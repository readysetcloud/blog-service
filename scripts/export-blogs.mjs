#!/usr/bin/env node
/**
 * export-blogs.mjs
 *
 * Local, read-only utility that scans the entire BlogTable, reassembles each
 * article into one clean "blog object", and writes the result to a JSON file
 * on disk for import into another service.
 *
 * The table is single-table (see README "Data model"). Items are distinguished
 * only by the *shape* of their keys — there is no entityType attribute. Two
 * conventions are handled transparently (see classify()):
 *
 *                       current service                     legacy readysetcloud table
 *   Catalog entry       sk="blog",  pk="/blog/<slug>"       sk="article", pk="/blog/<tenant>/<slug>"
 *   Idempotency rec.    sk="blog",  pk="<tenant>#<file>"    sk="article", pk="<hash>#<file>"
 *   View-count snap.    sk="viewCount-<YYYY-MM-DD>"         (same)
 *   Tenant              sk="tenant"                         (absent; tenant derived from pk)
 *   links / ids keys    dev/medium/hashnode                 devUrl/mediumUrl/hashnodeUrl, devId/...
 *
 * The catalog entry is the canonical article record. We join to it:
 *   - its idempotency record (per-platform publish status), either via the
 *     reconstructed <tenant>#<fileName> key (current) or via the record's `url`
 *     attribute pointing back at the catalog pk (legacy).
 *   - all of its weekly view-count snapshots, which share the catalog pk.
 * Output field names are normalized to one shape regardless of source table.
 *
 * Usage:
 *   node scripts/export-blogs.mjs --table BlogTable-abc123 [options]
 *
 * Every assembled blog object is validated against scripts/blog-export.schema.json
 * before anything is written. Conforming blogs go to the export file; any that
 * fail validation are excluded and written (with their validation errors) to a
 * review file so nothing malformed silently lands in the import.
 *
 * Append / multiple runs: if the --out file already exists, this run is MERGED
 * into it (blogs deduped by url, last write wins; tenants deduped by pk; a per-run
 * entry appended to `sources`; totals/counts recomputed). Re-running the same
 * table is therefore idempotent, and running several tables into the same --out
 * accumulates them. Pass --overwrite to start a fresh file instead.
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
 *   --overwrite        Replace the --out file instead of merging into it
 *
 * Credentials come from the standard AWS chain (env vars, shared config/SSO,
 * AWS_PROFILE, etc.) — the same as any other AWS CLI/SDK call. This script only
 * ever reads (Scan); it never writes to DynamoDB.
 */

import { writeFile, rm } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
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
      case '--overwrite': args.overwrite = true; break;
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
    console.log(`Usage: node scripts/export-blogs.mjs --table <name> [--region <r>] [--out <path>] [--review <path>] [--tenant <id>] [--no-pretty] [--no-validate] [--overwrite]`);
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
//
// Two table conventions are supported transparently:
//   - "current" service:  catalog sk="blog",    GSI1PK="blog#<tenant>",
//                          links.{dev,medium,hashnode},  ids.{dev,medium,hashnode},
//                          idempotency pk="<tenant>#<file>".
//   - "legacy" table:     catalog sk="article",  GSI1PK="article",
//                          links.{devUrl,mediumUrl,hashnodeUrl}, ids.{devId,mediumId,hashnodeId},
//                          pk="/blog/<tenant>/<slug>", idempotency pk="<hash>#<file>"
//                          joined back to the catalog via a `url` attribute.
// ---------------------------------------------------------------------------
const CATALOG_SKS = new Set(['blog', 'article']);

const classify = (item) => {
  const { pk, sk } = item;
  if (sk === 'tenant') return 'tenant';
  if (typeof sk === 'string' && sk.startsWith('viewCount')) return 'viewCount';
  if (CATALOG_SKS.has(sk) && typeof pk === 'string') {
    // Catalog entries are keyed by the canonical URL ("/blog/...").
    // Idempotency records are keyed by "<tenantOrHash>#<fileName>".
    if (pk.startsWith('/blog/')) return 'catalog';
    if (pk.includes('#')) return 'idempotency';
  }
  return 'unknown';
};

// tenantId + fileName -> the current-service idempotency record's pk
const idempotencyKey = (tenantId, fileName) => `${tenantId}#${fileName}`;

// "blog#<tenantId>" -> "<tenantId>" (current service). Legacy GSI1PK is the
// literal "article" and carries no tenant, so this returns undefined there.
const tenantIdFromGsi = (gsi1pk) =>
  (typeof gsi1pk === 'string' && gsi1pk.startsWith('blog#')) ? gsi1pk.slice('blog#'.length) : undefined;

// Derive tenantId + slug from the catalog entry. Prefers the GSI ("blog#<t>");
// falls back to the legacy pk shape "/blog/<tenant>/<slug>".
const deriveIdentity = (entry) => {
  let tenantId = tenantIdFromGsi(entry.GSI1PK);
  let slug;
  if (typeof entry.pk === 'string' && entry.pk.startsWith('/blog/')) {
    const rest = entry.pk.slice('/blog/'.length); // "<tenant>/<slug>" or "<slug>"
    if (tenantId && rest.startsWith(`${tenantId}/`)) {
      slug = rest.slice(tenantId.length + 1);
    } else if (!tenantId && rest.includes('/')) {
      // legacy: first path segment is the tenant
      tenantId = rest.slice(0, rest.indexOf('/'));
      slug = rest.slice(rest.indexOf('/') + 1);
    } else {
      slug = rest;
    }
  }
  return { tenantId, slug };
};

// Normalize a links/ids map to bare platform keys, accepting both the current
// keys (dev/medium/hashnode) and the legacy suffixed keys (devUrl/devId/...).
const PLATFORMS = ['dev', 'medium', 'hashnode'];
const normalizeLinks = (links) => {
  if (!links || typeof links !== 'object') return null;
  const out = {};
  if (links.url !== undefined) out.url = links.url;
  for (const p of PLATFORMS) {
    const v = links[p] ?? links[`${p}Url`];
    if (v !== undefined) out[p] = v;
  }
  return out;
};
const normalizeIds = (ids) => {
  if (!ids || typeof ids !== 'object') return null;
  const out = {};
  for (const p of PLATFORMS) {
    const v = ids[p] ?? ids[`${p}Id`];
    if (v !== undefined) out[p] = v;
  }
  return out;
};

// Normalize one per-publisher result map to { status, url, id }, accepting the
// current keys and the legacy {status, devUrl/mediumUrl/hashnodeUrl} shape.
const normalizePublisher = (m) => {
  if (m === undefined || m === null) return null;
  if (typeof m !== 'object') return m;
  const out = {};
  if (m.status !== undefined) out.status = m.status;
  const url = m.url ?? m.devUrl ?? m.mediumUrl ?? m.hashnodeUrl;
  if (url !== undefined) out.url = url;
  const id = m.id ?? m.devId ?? m.mediumId ?? m.hashnodeId;
  if (id !== undefined) out.id = id;
  return out;
};

// "<hash-or-tenant>#<fileName>" -> "<fileName>"
const fileNameFromIdempotencyPk = (pk) =>
  (typeof pk === 'string' && pk.includes('#')) ? pk.slice(pk.indexOf('#') + 1) : undefined;

// Consolidate a snapshot's cumulative "allTime" map into clean per-platform
// totals plus a combined total. allTime is authoritative (the analytics job
// maintained it as a running total); re-summing weekly deltas would drift.
const COUNT_PLATFORMS = ['blog', 'dev', 'medium', 'hashnode'];
const buildTotals = (allTime) => {
  if (!allTime || typeof allTime !== 'object') return null;
  const t = {};
  for (const p of COUNT_PLATFORMS) t[p] = Number(allTime[p] ?? 0);
  t.total = allTime.total !== undefined
    ? Number(allTime.total)
    : COUNT_PLATFORMS.reduce((sum, p) => sum + t[p], 0);
  return t;
};

// Sum a list of totals maps into one grand total (null entries ignored).
const sumTotals = (list) => {
  const grand = { blog: 0, dev: 0, medium: 0, hashnode: 0, total: 0 };
  for (const t of list) {
    if (!t) continue;
    for (const k of Object.keys(grand)) grand[k] += Number(t[k] ?? 0);
  }
  return grand;
};

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
  const idempotencyByKey = new Map();  // pk -> record (current-service join)
  const idempotencyByUrl = new Map();  // record.url -> record (legacy join)
  const viewCountsByUrl = new Map();
  const tenants = new Map();
  const unknownBySk = new Map();       // sk-kind -> count
  const unknownExamples = [];

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
        if (typeof item.url === 'string') idempotencyByUrl.set(item.url, item);
        break;
      case 'viewCount': {
        const list = viewCountsByUrl.get(item.pk) ?? [];
        list.push(item);
        viewCountsByUrl.set(item.pk, list);
        break;
      }
      default: {
        // Group unknown items by sk-kind (subscribers#<date> -> subscribers#*)
        // so the summary stays readable across ~800 non-blog legacy items.
        const sk = typeof item.sk === 'string' ? item.sk : '(no sk)';
        const kind = sk.includes('#') ? `${sk.slice(0, sk.indexOf('#'))}#*` : sk;
        unknownBySk.set(kind, (unknownBySk.get(kind) ?? 0) + 1);
        if (unknownExamples.length < 20) unknownExamples.push({ pk: item.pk, sk: item.sk });
      }
    }
  }

  const usedIdempotency = new Set();
  const usedViewCounts = new Set();

  let blogs = catalog.map((entry) => {
    const { tenantId, slug } = deriveIdentity(entry);

    // Publish status lives on a separate idempotency record. Join by the
    // reconstructed "<tenant>#<file>" key (current service) or, failing that,
    // by the record's `url` attribute pointing at this catalog pk (legacy).
    let record;
    let fileName = typeof entry.GSI1SK === 'string' && /\.md$/i.test(entry.GSI1SK) ? entry.GSI1SK : null;
    if (tenantId && fileName) {
      const key = idempotencyKey(tenantId, fileName);
      if (idempotencyByKey.has(key)) { record = idempotencyByKey.get(key); usedIdempotency.add(key); }
    }
    if (!record && idempotencyByUrl.has(entry.pk)) {
      record = idempotencyByUrl.get(entry.pk);
      usedIdempotency.add(record.pk);
    }
    if (!fileName && record) fileName = fileNameFromIdempotencyPk(record.pk) ?? null;

    const publish = record ? {
      status: record.status ?? null,
      dev: normalizePublisher(record.dev),
      medium: normalizePublisher(record.medium),
      hashnode: normalizePublisher(record.hashnode)
    } : null;

    // Title: explicit attribute wins; otherwise a non-.md GSI1SK is a title (legacy).
    const title = entry.title
      ?? (typeof entry.GSI1SK === 'string' && !/\.md$/i.test(entry.GSI1SK) ? entry.GSI1SK : null);

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

    const latest = snapshots.length ? snapshots[snapshots.length - 1] : null;

    return {
      slug: slug ?? null,
      title: title ?? null,
      url: entry.pk,
      canonicalUrl: typeof entry.pk === 'string' ? `https://readysetcloud.io${entry.pk}` : null,
      tenantId: tenantId ?? null,
      fileName: fileName ?? null,
      // Native URLs of each cross-posted copy (+ the canonical "url" key),
      // normalized from either key convention.
      links: normalizeLinks(entry.links),
      // Per-platform post ids used by the analytics job, normalized.
      ids: normalizeIds(entry.ids),
      publish,
      analytics: {
        // Consolidated cumulative views for this article (from the latest
        // snapshot's authoritative allTime). `.total` is the single number.
        totals: buildTotals(latest && latest.allTime),
        latest,
        history: snapshots
      }
    };
  });

  if (args.tenant) {
    blogs = blogs.filter((b) => b.tenantId === args.tenant);
  }
  blogs.sort((a, b) => String(a.url).localeCompare(String(b.url)));

  // Grand total across every exported blog — the consolidated "across the board" value.
  const totals = sumTotals(blogs.map((b) => b.analytics.totals));

  // Surface data that didn't join to a catalog entry so nothing is silently dropped.
  const orphanIdempotency = [...idempotencyByKey.keys()].filter((k) => !usedIdempotency.has(k));
  const orphanViewCounts = [...viewCountsByUrl.keys()].filter((k) => !usedViewCounts.has(k));

  return {
    blogs,
    tenants: [...tenants.values()],
    totals,
    diagnostics: {
      counts: {
        catalog: catalog.length,
        idempotency: idempotencyByKey.size,
        viewCountArticles: viewCountsByUrl.size,
        tenants: tenants.size,
        unknown: [...unknownBySk.values()].reduce((a, b) => a + b, 0)
      },
      unknownBySk: Object.fromEntries([...unknownBySk.entries()].sort((a, b) => b[1] - a[1])),
      orphanIdempotencyKeys: orphanIdempotency,
      orphanViewCountUrls: orphanViewCounts,
      unknownExamples
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
// Merge (append mode) — accumulate multiple runs into one --out file
// ---------------------------------------------------------------------------
// Read an existing export/review file, tolerating both the current `sources`
// shape and the older single `source` shape.
const readEnvelope = (path, label) => {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Existing ${label} file ${path} is not valid JSON: ${err.message}. Fix it or pass --overwrite.`);
  }
};

// Normalize a prior export envelope into { sources, tenants, blogs }.
const priorExport = (obj) => {
  if (!obj) return { sources: [], tenants: [], blogs: [] };
  const sources = Array.isArray(obj.sources)
    ? obj.sources
    : (obj.source
      ? [{ table: obj.source.table, region: obj.source.region ?? null, exportedAt: obj.exportedAt ?? null, itemsScanned: obj.counts?.itemsScanned ?? null, blogs: obj.counts?.blogs ?? (obj.blogs?.length ?? 0) }]
      : []);
  return {
    sources,
    tenants: Array.isArray(obj.tenants) ? obj.tenants : [],
    blogs: Array.isArray(obj.blogs) ? obj.blogs : []
  };
};

// Merge this run's contribution into the prior export (or an empty base).
const mergeExport = (prior, run) => {
  const base = priorExport(prior);
  const blogsByUrl = new Map();
  for (const b of base.blogs) blogsByUrl.set(b.url, b);
  for (const b of run.blogs) blogsByUrl.set(b.url, b); // last write wins → idempotent re-run
  const tenantsByPk = new Map();
  for (const t of base.tenants) tenantsByPk.set(t.pk, t);
  for (const t of run.tenants) tenantsByPk.set(t.pk, t);

  const blogs = [...blogsByUrl.values()].sort((a, b) => String(a.url).localeCompare(String(b.url)));
  const tenants = [...tenantsByPk.values()];
  return {
    exportedAt: run.exportedAt,
    sources: [...base.sources, run.sourceEntry],
    counts: { blogs: blogs.length, tenants: tenants.length },
    totals: sumTotals(blogs.map((b) => b.analytics.totals)),
    tenants,
    blogs
  };
};

// Review items that are still failing across all runs: prior + this run, deduped
// by url, minus any url that now appears in the export (i.e. became valid).
const mergeReview = (priorReview, runItems, exportedUrls) => {
  const byUrl = new Map();
  const prev = priorReview && Array.isArray(priorReview.items) ? priorReview.items : [];
  for (const it of prev) byUrl.set(it.url, it);
  for (const it of runItems) byUrl.set(it.url, it);
  return [...byUrl.values()].filter((it) => !exportedUrls.has(it.url));
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

  const exportedAt = new Date().toISOString();
  const sourceEntry = {
    table: tableName,
    region: region ?? null,
    exportedAt,
    itemsScanned: items.length,
    blogs: exportBlogs.length
  };

  // Merge into the existing --out file unless --overwrite was passed.
  const prior = args.overwrite ? null : readEnvelope(outPath, '--out');
  if (prior) {
    console.error(`Merging into existing ${outPath} (${prior.blogs?.length ?? 0} blog(s) already present)…`);
  }
  const output = mergeExport(prior, { blogs: exportBlogs, tenants, sourceEntry, exportedAt });

  // Sanity check: the merged export must itself satisfy the full schema.
  if (validators && !validators.validateExport(output)) {
    console.error('⚠  Export envelope failed schema validation:');
    console.error(JSON.stringify(validators.validateExport.errors, null, 2));
  }

  await writeFile(outPath, JSON.stringify(output, null, args.pretty ? 2 : 0));
  console.error(`\nWrote ${output.blogs.length} blog object(s) to ${outPath} (${exportBlogs.length} added/updated from "${tableName}").`);
  console.error(`Consolidated views (all blogs in file): ${output.totals.total.toLocaleString('en-US')} — ${JSON.stringify(output.totals)}`);

  // Review: keep the set of blogs still failing validation across all runs.
  const exportedUrls = new Set(output.blogs.map((b) => b.url));
  const priorReview = args.overwrite ? null : readEnvelope(reviewPath, '--review');
  const reviewItems = mergeReview(priorReview, review, exportedUrls);
  if (reviewItems.length) {
    const reviewDoc = {
      generatedAt: exportedAt,
      sources: output.sources,
      schema: 'blog-export.schema.json',
      invalidCount: reviewItems.length,
      items: reviewItems
    };
    await writeFile(reviewPath, JSON.stringify(reviewDoc, null, args.pretty ? 2 : 0));
    console.error(`⚠  ${reviewItems.length} blog(s) currently failing validation → ${reviewPath} (excluded from export)`);
  } else {
    if (existsSync(reviewPath)) await rm(reviewPath); // no longer any failures to review
    console.error(validators ? 'All blog objects passed schema validation.' : 'Schema validation skipped (--no-validate).');
  }

  console.error(`Item breakdown: ${JSON.stringify(diagnostics.counts)}`);
  if (diagnostics.orphanIdempotencyKeys.length) {
    console.error(`⚠  ${diagnostics.orphanIdempotencyKeys.length} idempotency record(s) had no matching catalog entry.`);
  }
  if (diagnostics.orphanViewCountUrls.length) {
    console.error(`⚠  ${diagnostics.orphanViewCountUrls.length} article(s) have view-count snapshots but no catalog entry.`);
  }
  if (diagnostics.counts.unknown) {
    console.error(`ℹ  ${diagnostics.counts.unknown} non-blog item(s) skipped, by sk kind:`);
    console.error(JSON.stringify(diagnostics.unknownBySk, null, 2));
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
