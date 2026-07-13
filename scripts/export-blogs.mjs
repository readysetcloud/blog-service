#!/usr/bin/env node
/**
 * export-blogs.mjs
 *
 * Local, read-only utility that scans the entire BlogTable, reassembles each
 * article into one clean "blog object", and writes the result to a JSON file
 * on disk for import into another service.
 *
 * The table is single-table (see README "Data model"). Items are distinguished
 * only by the *shape* of their keys — there is no entityType attribute:
 *
 *   - Tenant            pk=<tenantId>            sk="tenant"
 *   - Catalog entry     pk="/blog/<slug>"        sk="blog"          (pk starts with "/")
 *   - Idempotency rec.  pk="<tenantId>#<file>"   sk="blog"          (pk contains "#")
 *   - View-count snap.  pk="/blog/<slug>"        sk="viewCount-<YYYY-MM-DD>"
 *
 * The catalog entry is the canonical article record. We join to it:
 *   - its idempotency record (per-platform publish status) via <tenantId>#<fileName>,
 *     which is reconstructed from the catalog's GSI1PK ("blog#<tenantId>") and GSI1SK.
 *   - all of its weekly view-count snapshots, which share the catalog pk.
 *
 * Usage:
 *   node scripts/export-blogs.mjs --table BlogTable-abc123 [options]
 *
 * Every assembled blog object is validated against scripts/blog-export.schema.json
 * before anything is written. Conforming blogs go to the export file; any that
 * fail validation are excluded and written (with their validation errors) to a
 * review file so nothing malformed silently lands in the import.
 *
 * Options:
 *   --table   <name>   DynamoDB table name           (or env TABLE_NAME)   [required]
 *   --region  <region> AWS region                    (or env AWS_REGION)
 *   --out     <path>   Output file path              (default ./blog-export.json)
 *   --review  <path>   Review file for non-conforming blogs
 *                                                    (default: <out>.review.json)
 *   --tenant  <id>     Only export this tenant's articles
 *   --pretty           Pretty-print the JSON (default: on; use --no-pretty for compact)
 *   --no-validate      Skip schema validation (export everything as-is)
 *
 * Credentials come from the standard AWS chain (env vars, shared config/SSO,
 * AWS_PROFILE, etc.) — the same as any other AWS CLI/SDK call. This script only
 * ever reads (Scan); it never writes to DynamoDB.
 */

import { writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import Ajv from 'ajv';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------
const parseArgs = (argv) => {
  const args = { pretty: true, validate: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--table': args.table = argv[++i]; break;
      case '--region': args.region = argv[++i]; break;
      case '--out': args.out = argv[++i]; break;
      case '--review': args.review = argv[++i]; break;
      case '--tenant': args.tenant = argv[++i]; break;
      case '--pretty': args.pretty = true; break;
      case '--no-pretty': args.pretty = false; break;
      case '--no-validate': args.validate = false; break;
      case '-h':
      case '--help': args.help = true; break;
      default:
        console.error(`Unknown argument: ${arg}`);
        args.help = true;
    }
  }
  return args;
};

const args = parseArgs(process.argv.slice(2));

// Resolve CLI/env config. Called from main() so importing this module for
// testing has no side effects.
const resolveConfig = () => {
  if (args.help) {
    console.log(`Usage: node scripts/export-blogs.mjs --table <name> [--region <r>] [--out <path>] [--review <path>] [--tenant <id>] [--no-pretty] [--no-validate]`);
    process.exit(0);
  }
  const tableName = args.table ?? process.env.TABLE_NAME;
  const region = args.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  const outPath = resolve(args.out ?? 'blog-export.json');
  const reviewPath = resolve(args.review ?? `${outPath.replace(/\.json$/i, '')}.review.json`);
  if (!tableName) {
    console.error('Error: table name is required. Pass --table <name> or set TABLE_NAME.');
    process.exit(1);
  }
  return { tableName, region, outPath, reviewPath };
};

// ---------------------------------------------------------------------------
// Item classification (keys tell entities apart — there is no entityType attr)
// ---------------------------------------------------------------------------
const classify = (item) => {
  const { pk, sk } = item;
  if (sk === 'tenant') return 'tenant';
  if (typeof sk === 'string' && sk.startsWith('viewCount')) return 'viewCount';
  if (sk === 'blog') {
    // Catalog entries are keyed by the canonical URL ("/blog/<slug>").
    // Idempotency records are keyed by "<tenantId>#<fileName>".
    if (pk.startsWith('/')) return 'catalog';
    if (pk.includes('#')) return 'idempotency';
  }
  return 'unknown';
};

// tenantId + fileName -> the idempotency record's pk
const idempotencyKey = (tenantId, fileName) => `${tenantId}#${fileName}`;

// "blog#<tenantId>" -> "<tenantId>"
const tenantIdFromGsi = (gsi1pk) =>
  (typeof gsi1pk === 'string' && gsi1pk.startsWith('blog#')) ? gsi1pk.slice('blog#'.length) : undefined;

// ---------------------------------------------------------------------------
// Full-table scan (paginated)
// ---------------------------------------------------------------------------
const scanAll = async (client, tableName) => {
  const items = [];
  let ExclusiveStartKey;
  let pages = 0;
  do {
    const res = await client.send(new ScanCommand({
      TableName: tableName,
      ExclusiveStartKey
    }));
    for (const raw of res.Items ?? []) {
      items.push(unmarshall(raw));
    }
    ExclusiveStartKey = res.LastEvaluatedKey;
    pages++;
    process.stderr.write(`\rScanning… ${items.length} items (${pages} page${pages === 1 ? '' : 's'})`);
  } while (ExclusiveStartKey);
  process.stderr.write('\n');
  return items;
};

// ---------------------------------------------------------------------------
// Assemble one clean blog object per catalog entry
// ---------------------------------------------------------------------------
const buildBlogs = (items) => {
  const catalog = [];
  const idempotencyByKey = new Map();
  const viewCountsByUrl = new Map();
  const tenants = new Map();
  const unknown = [];

  for (const item of items) {
    switch (classify(item)) {
      case 'tenant':
        tenants.set(item.pk, item);
        break;
      case 'catalog':
        catalog.push(item);
        break;
      case 'idempotency':
        idempotencyByKey.set(item.pk, item);
        break;
      case 'viewCount': {
        const list = viewCountsByUrl.get(item.pk) ?? [];
        list.push(item);
        viewCountsByUrl.set(item.pk, list);
        break;
      }
      default:
        unknown.push({ pk: item.pk, sk: item.sk });
    }
  }

  const usedIdempotency = new Set();
  const usedViewCounts = new Set();

  let blogs = catalog.map((entry) => {
    const tenantId = tenantIdFromGsi(entry.GSI1PK);
    const fileName = entry.GSI1SK;
    const slug = typeof entry.pk === 'string' ? entry.pk.replace(/^\/blog\//, '') : undefined;

    // Publish status lives on the idempotency record (pk = "<tenantId>#<fileName>").
    let publish;
    if (tenantId && fileName) {
      const key = idempotencyKey(tenantId, fileName);
      const record = idempotencyByKey.get(key);
      if (record) {
        usedIdempotency.add(key);
        publish = {
          status: record.status ?? null,
          dev: record.dev ?? null,
          medium: record.medium ?? null,
          hashnode: record.hashnode ?? null
        };
      }
    }

    // View-count snapshots share the catalog pk (the canonical URL).
    const snapshots = (viewCountsByUrl.get(entry.pk) ?? [])
      .map((snap) => ({
        // sk is "viewCount-<YYYY-MM-DD>"
        date: typeof snap.sk === 'string' ? snap.sk.replace(/^viewCount-/, '') : snap.sk,
        weekly: snap.weekly ?? null,
        allTime: snap.allTime ?? null
      }))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    if (viewCountsByUrl.has(entry.pk)) usedViewCounts.add(entry.pk);

    return {
      slug,
      url: entry.pk,
      canonicalUrl: slug ? `https://readysetcloud.io/blog/${slug}` : null,
      tenantId: tenantId ?? null,
      fileName: fileName ?? null,
      // Native URLs of each cross-posted copy (+ the canonical "url" key).
      links: entry.links ?? null,
      // Per-platform post ids used by the analytics job.
      ids: entry.ids ?? null,
      publish: publish ?? null,
      analytics: {
        latest: snapshots.length ? snapshots[snapshots.length - 1] : null,
        history: snapshots
      }
    };
  });

  if (args.tenant) {
    blogs = blogs.filter((b) => b.tenantId === args.tenant);
  }
  blogs.sort((a, b) => String(a.url).localeCompare(String(b.url)));

  // Surface data that didn't join to a catalog entry so nothing is silently dropped.
  const orphanIdempotency = [...idempotencyByKey.keys()].filter((k) => !usedIdempotency.has(k));
  const orphanViewCounts = [...viewCountsByUrl.keys()].filter((k) => !usedViewCounts.has(k));

  return {
    blogs,
    tenants: [...tenants.values()],
    diagnostics: {
      counts: {
        catalog: catalog.length,
        idempotency: idempotencyByKey.size,
        viewCountArticles: viewCountsByUrl.size,
        tenants: tenants.size,
        unknown: unknown.length
      },
      orphanIdempotencyKeys: orphanIdempotency,
      orphanViewCountUrls: orphanViewCounts,
      unknownItems: unknown
    }
  };
};

// ---------------------------------------------------------------------------
// Schema self-validation
// ---------------------------------------------------------------------------
const SCHEMA_PATH = fileURLToPath(new URL('./blog-export.schema.json', import.meta.url));

// Compile a validator for a single blog object and one for the whole export
// envelope, from the on-disk schema.
const loadValidators = () => {
  let schema;
  try {
    schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  } catch (err) {
    throw new Error(`Could not read schema at ${SCHEMA_PATH}: ${err.message}. Pass --no-validate to skip.`);
  }
  // ajv v6 (draft-07) doesn't know the 2020-12 meta-schema; every keyword used
  // in this schema is draft-07 compatible, so drop $schema before compiling.
  delete schema.$schema;

  const ajv = new Ajv({ allErrors: true });
  const validateExport = ajv.compile(schema);
  // Standalone validator for one blog object; $defs is carried along so the
  // internal $refs (publisherResult, snapshot, viewCounts) still resolve.
  const validateBlog = ajv.compile({ ...schema.$defs.blog, $defs: schema.$defs });
  return { validateBlog, validateExport };
};

// Split blogs into schema-conforming (kept) and non-conforming (sent to review).
const validateBlogs = (blogs, validateBlog) => {
  const valid = [];
  const review = [];
  for (const blog of blogs) {
    if (validateBlog(blog)) {
      valid.push(blog);
    } else {
      review.push({
        url: blog.url ?? null,
        tenantId: blog.tenantId ?? null,
        fileName: blog.fileName ?? null,
        // ajv reuses .errors across calls — capture it now, before the next blog.
        errors: (validateBlog.errors ?? []).map((e) => ({
          path: e.dataPath || '(root)',
          message: e.message,
          params: e.params
        })),
        blog
      });
    }
  }
  return { valid, review };
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const main = async () => {
  const { tableName, region, outPath, reviewPath } = resolveConfig();
  const client = new DynamoDBClient(region ? { region } : {});
  console.error(`Scanning table "${tableName}"${region ? ` in ${region}` : ''}…`);

  const items = await scanAll(client, tableName);
  const { blogs, tenants, diagnostics } = buildBlogs(items);

  const validators = args.validate ? loadValidators() : null;

  let exportBlogs = blogs;
  let review = [];
  if (validators) {
    ({ valid: exportBlogs, review } = validateBlogs(blogs, validators.validateBlog));
  }

  const output = {
    exportedAt: new Date().toISOString(),
    source: { table: tableName, region: region ?? null },
    counts: {
      blogs: exportBlogs.length,
      tenants: tenants.length,
      itemsScanned: items.length
    },
    tenants,
    blogs: exportBlogs
  };

  // Sanity check: the filtered export must itself satisfy the full schema.
  if (validators && !validators.validateExport(output)) {
    console.error('⚠  Export envelope failed schema validation:');
    console.error(JSON.stringify(validators.validateExport.errors, null, 2));
  }

  await writeFile(outPath, JSON.stringify(output, null, args.pretty ? 2 : 0));
  console.error(`\nWrote ${exportBlogs.length} blog object(s) to ${outPath}`);

  if (review.length) {
    const reviewDoc = {
      generatedAt: output.exportedAt,
      source: output.source,
      schema: 'blog-export.schema.json',
      invalidCount: review.length,
      items: review
    };
    await writeFile(reviewPath, JSON.stringify(reviewDoc, null, args.pretty ? 2 : 0));
    console.error(`⚠  ${review.length} blog(s) failed schema validation → ${reviewPath} (excluded from export)`);
  } else if (validators) {
    console.error('All blog objects passed schema validation.');
  } else {
    console.error('Schema validation skipped (--no-validate).');
  }

  console.error(`Item breakdown: ${JSON.stringify(diagnostics.counts)}`);
  if (diagnostics.orphanIdempotencyKeys.length) {
    console.error(`⚠  ${diagnostics.orphanIdempotencyKeys.length} idempotency record(s) had no matching catalog entry.`);
  }
  if (diagnostics.orphanViewCountUrls.length) {
    console.error(`⚠  ${diagnostics.orphanViewCountUrls.length} article(s) have view-count snapshots but no catalog entry.`);
  }
  if (diagnostics.counts.unknown) {
    console.error(`⚠  ${diagnostics.counts.unknown} item(s) did not match any known entity shape (see below).`);
    console.error(JSON.stringify(diagnostics.unknownItems, null, 2));
  }
};

// Only scan/run when invoked directly, so the assembly logic (buildBlogs) can
// be imported and unit-tested without touching AWS.
if (import.meta.url === `file://${process.argv[1]}` || import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  main().catch((err) => {
    console.error('\nExport failed:', err);
    process.exit(1);
  });
}

export { buildBlogs, classify, loadValidators, validateBlogs };
