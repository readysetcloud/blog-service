# Blog Service

A serverless microservice that **catalogs**, **publishes**, and **cross-posts** blog
articles for [Ready, Set, Cloud!](https://readysetcloud.io), and tracks their
**analytics** across every platform they live on.

It is an AWS SAM application (Lambda + Step Functions + DynamoDB + EventBridge). This
README is written so that an agent (or engineer) can **re-create the same behavior in
another repository** without having to reverse-engineer the source. It documents what
the service does, how data flows through it, the exact platform API contracts, and —
importantly — **every credential it uses to authenticate** and where those credentials
come from.

---

## Objective

In the author's words:

> A service to track all my blog posts, automatically cross-post them to various
> publications, and update the cross-links between articles so they stay on-platform.

Concretely, that means: keep one **catalog** of every article I write, **publish** each
new post out to the other communities I'm active on (Dev.to, Medium, Hashnode) without me
doing it by hand, and — when one article links to another of mine — **rewrite that link**
to the reader's *current* platform (a Dev.to copy links to the Dev.to copy, Medium to
Medium, etc.) instead of always bouncing them back to the main site. Tracking weekly
view counts across all of those platforms came along for the ride.

---

## What it does (at a glance)

1. **Ingest** – When a new blog post is committed to the source content repo, an
   EventBridge event kicks off the service. It reads the raw Markdown (with
   frontmatter) directly from GitHub.
2. **Catalog** – It records the article in a DynamoDB table so the post and its
   cross-posted copies can be linked and looked up later (idempotently).
3. **Cross-post** – It re-formats the article for each target platform
   (**Dev.to**, **Medium**, **Hashnode**) and publishes it there, optionally on a
   staggered schedule so the copies don't all appear at once.
4. **Analytics** – On a weekly schedule it pulls view counts for every article from
   every platform (plus Google Analytics for the canonical site), computes
   week-over-week deltas, stores them, and emails a "top articles" summary.

The whole thing is **multi-tenant**: the originating GitHub repo, owner, and even the
GitHub credential can be resolved per-tenant from DynamoDB.

---

## Architecture

```
GitHub commit ──► EventBridge ("Create New Blog", source: github)
                      │
                      ▼
            ImportFromGithubFunction ─────► CrossPostStateMachine (Step Functions)
                                                   │
              ┌────────────────────────────────────┼───────────────────────────────┐
              │ idempotency check (DynamoDB)        │                               │
              │ optional wait until futureDate      │                               │
              │ generate crosspost dates (Lambda)   │                               │
              │ save catalog entry (DynamoDB)       │                               │
              │                                     ▼                               │
              │                          Parallel: dev / medium / hashnode          │
              │                                     │ (each waits its own date)     │
              │                                     ▼                               │
              │                          PublishStateMachine (per platform) ────────┘
              │                                     │
              │   load content from GitHub ─► load catalog ─► ParseBlog (reformat)
              │   ─► SendApiRequest (shared lambda, does the authenticated POST)
              │   ─► record platform id + url back into DynamoDB ─► email via EventBridge
              ▼
   ─────────────────────────────────────────────────────────────────────────────
   Weekly schedule (cron Mon 11:00 UTC) ──► BlogViewCountStateMachine
        for each catalogued article:
          GetViewCount (RSC/GA, Medium, Dev.to, Hashnode) ─► CompareViewCounts
          ─► store weekly + all-time counts (DynamoDB) ─► push to Momento sorted sets
        ─► GetTopBlogs (read Momento) ─► email summary via EventBridge
```

### Components

| Resource | Type | Purpose |
|---|---|---|
| `BlogTable` | DynamoDB | Single-table store for tenants, catalog entries, idempotency records, weekly view counts. PK/SK + `GSI1` (GSI1PK/GSI1SK). |
| `ImportFromGithubFunction` | Lambda | EventBridge target. Reads the new post from GitHub, parses frontmatter, starts the cross-post state machine. |
| `CrossPostStateMachine` | Step Functions (STANDARD) | Orchestrates idempotency, scheduling, catalog save, and fan-out to the three platforms. |
| `PublishStateMachine` | Step Functions (STANDARD) | Publishes a single article to a single platform (load → transform → POST → record). |
| `BlogViewCountStateMachine` | Step Functions (STANDARD) | Weekly analytics gathering + summary email. Scheduled `cron(0 11 ? * MON *)`. |
| `ParseBlogFunction` | Lambda | Reformats Markdown into each platform's payload shape (see below). |
| `GetBlogContentFunction` | Lambda | Fetches raw file content (and optionally frontmatter metadata) from GitHub. |
| `GetCrosspostDatesFunction` | Lambda | Decides when each platform copy should publish (now, or staggered weekdays). |
| `GetPublisherStatusFunction` | Lambda | Reads per-platform publish status from the idempotency record. |
| `GetPublisherOutputFunction` | Lambda | Extracts the published URL/id from a platform response via JSONPath. |
| `GetViewCountFunction` | Lambda | Pulls view counts from RSC (Google Analytics), Medium, Dev.to, Hashnode. |
| `CompareViewCountsFunction` | Lambda | Computes deltas vs. last week, writes to Momento sorted sets. |
| `GetTopBlogsFunction` | Lambda | Reads Momento sorted sets, builds the HTML summary email. |

> **Note on `SendApiRequest`:** The actual authenticated HTTP POST to each platform is
> performed by a **shared, external Lambda** referenced via SSM
> (`/readysetcloud/send-api-request`). It is *not* in this repo. To replicate the
> service standalone you must implement an equivalent (see
> [Re-implementing `SendApiRequest`](#re-implementing-sendapirequest)).

---

## Authentication & credentials

This is the part most important for replication. The service authenticates to a number
of external systems. **All credentials live in a single AWS Secrets Manager secret**,
whose ARN is stored in SSM Parameter Store. There are also several plain SSM parameters
for non-secret configuration.

### Where credentials come from

- **Secrets Manager secret** — its ARN is resolved from the SSM parameter
  `/readysetcloud/secrets` and injected into every Lambda as the env var `SECRET_ID`:
  ```yaml
  Environment:
    Variables:
      SECRET_ID: "{{resolve:ssm:/readysetcloud/secrets}}"
  ```
  The secret is a **JSON object**. Lambdas read it with
  `@aws-lambda-powertools/parameters` (`getSecret(SECRET_ID, { transform: 'json' })`)
  and pull individual keys out of it.

### Secret JSON keys

| JSON key | Used by | What it is / how it's used |
|---|---|---|
| `github` | `getOctokit()` (helpers) | GitHub Personal Access Token. Used as `new Octokit({ auth })` to read blog Markdown from the content repo. |
| `dev` | `GetViewCount` **and** publishing | Dev.to API key. For analytics it is sent as the `api-key` header to `https://dev.to/api/analytics/historical`. For publishing it is the credential for the `api-key` header on `POST https://dev.to/api/articles`. |
| `medium` | publishing | Medium **integration token**. Sent as the `accessToken` **query-string** parameter when posting to the Medium API. |
| `medium-cookie` | `GetViewCount` | A logged-in Medium **session cookie** string. Sent as the `Cookie` header to Medium's private GraphQL endpoint (`https://medium.com/_/graphql`) to read view stats (there is no public stats API). |
| `hashnode` | `GetViewCount` **and** publishing | Hashnode Personal Access Token. Sent as the `Authorization` header — both to the private stats AJAX endpoint and to the GraphQL publish mutation at `https://gql.hashnode.com`. |
| `ga` | `GetViewCount` (RSC views) | Google service-account credentials JSON for the Google Analytics Data API, stored **gzip-compressed then base64-encoded**. At runtime it is base64-decoded, `zlib.inflateSync`'d, written to `/tmp/credentials.json`, and used as the `keyFile` for `BetaAnalyticsDataClient`. |
| `momento` | `getCacheClient()` (helpers) | Momento cache auth token. Used to build a `CacheClient` (`CredentialProvider.fromString({ authToken })`) for the analytics sorted sets. |

> ⚠️ The `secretKey` passed to the shared `SendApiRequest` lambda is literally the
> publisher name — `dev`, `medium`, or `hashnode`. That lambda is expected to look up
> the same secret and use the value at that key as the auth credential. Keep the JSON
> key names aligned with the publisher names.

### Plain SSM parameters (non-secret config)

| SSM parameter | Injected as | Purpose |
|---|---|---|
| `/readysetcloud/secrets` | `SECRET_ID` env var | ARN of the Secrets Manager secret above. |
| `/readysetcloud/github-owner` | `OWNER` env var (GetBlogContent) | Default GitHub repo owner for content. |
| `/readysetcloud/github-repo` | `REPO` env var (GetBlogContent) | Default GitHub repo name for content. |
| `/readysetcloud/admin-email` | state-machine substitution `AdminEmail` | Recipient of success/failure and weekly summary emails. |
| `/readysetcloud/send-api-request` | state-machine substitution `SendApiRequest` | ARN of the shared HTTP-request Lambda used to publish. |

### Per-tenant credentials (multi-tenant mode)

When an event carries a `tenantId`, the service can use **tenant-specific** GitHub
credentials instead of the shared secret. The tenant record
(`pk = <tenantId>`, `sk = tenant`) in DynamoDB stores:

- `apiKeyParameter` – the name of an SSM parameter (under `/rsc/*`) holding that
  tenant's secrets JSON (decrypted, `transform: 'json'`), from which `github` is read.
- `github.owner` / `github.repo` – which repo to pull that tenant's content from.
- `email` – the tenant's email, attached to the blog payload.

`getOctokit(tenantId)` prefers the tenant's `apiKeyParameter`; with no tenant it falls
back to the shared `SECRET_ID` secret's `github` key.

### IAM permissions required

- `ssm:GetParameter` on `arn:aws:ssm:<region>:<account>:parameter/rsc/*` (tenant keys).
- `secretsmanager:GetSecretValue` on the secret resolved from `/readysetcloud/secrets`.
- `dynamodb:GetItem/PutItem/UpdateItem/Query` on the table (+ `GSI1` for queries).
- `states:StartExecution` on the cross-post / publish state machines.
- `lambda:InvokeFunction` on the helper functions and the shared `SendApiRequest`.
- `events:PutEvents` on the default event bus (emails + site-rebuild triggers).

---

## Data model

A single DynamoDB table (`BlogTable`) holds every entity. It is keyed by `pk`
(partition, `HASH`) / `sk` (sort, `RANGE`), both strings, with one global secondary
index **`GSI1`** on `GSI1PK` / `GSI1SK` (also strings) projecting `ALL` attributes.
Billing is `PAY_PER_REQUEST`. There is no `entityType` attribute — item kinds are
distinguished implicitly by the *shape* of their keys (one of the things the
[next-gen design](#next-generation-design--improvements) cleans up).

### Entities

#### 1. Tenant
Owner of a blog and the credentials/config used to publish it.

| Attribute | Type | Example | Notes |
|---|---|---|---|
| `pk` | S | `allen.helton` | The tenant id. |
| `sk` | S | `tenant` | Constant. |
| `email` | S | `me@example.com` | Attached to each blog payload; not (currently) the email recipient. |
| `apiKeyParameter` | S | `/rsc/allen.helton/keys` | SSM SecureString path holding that tenant's secrets JSON. |
| `github` | M | `{ owner, repo }` | Which repo to pull content from (legacy pull model). |

> Read with `GetItem(pk=<tenantId>, sk=tenant)` (`getTenant` in `helpers.mjs`).

#### 2. Catalog entry (article)
The canonical record of a published article and where its copies live. This is the
record consulted during reformatting so cross-links resolve to platform-native URLs.

| Attribute | Type | Example | Notes |
|---|---|---|---|
| `pk` | S | `/blog/my-post` | The canonical site-relative URL (`/blog/<slug>`). |
| `sk` | S | `blog` | Constant. |
| `GSI1PK` | S | `blog#allen.helton` | `blog#<tenantId>` — used to list a tenant's catalog. |
| `GSI1SK` | S | `posts/my-post.md` | The source `fileName`. |
| `links` | M | `{ url, dev, medium, hashnode }` | `url` = canonical path; per-platform keys = native URL of the copy. Read in `parse-blog.mjs` as `links.M.<platform>.S`. |
| `ids` | M | `{ dev, medium, hashnode }` | Per-platform post id of the copy. Used by the analytics job to fetch per-platform views. |

> Created by **Save Catalog Entry** (cross-post), enriched per platform by **Update
> Catalog** (publish), and queried via `GSI1` for link rewriting and analytics.

#### 3. Idempotency record (per-article publish state)
Guards against double-processing a blog and tracks per-platform progress. Note it shares
`sk = blog` with the catalog entry but uses a different `pk` shape.

| Attribute | Type | Example | Notes |
|---|---|---|---|
| `pk` | S | `allen.helton#posts/my-post.md` | `<tenantId>#<fileName>` (the `key`). |
| `sk` | S | `blog` | Constant. |
| `status` | S | `in progress` | Overall: `in progress` \| `succeeded` \| `failed`. |
| `dev` / `medium` / `hashnode` | M | `{ status, url, id }` | Per-publisher result. `status` of `succeeded` short-circuits re-publish. |
| `ids` / `links` | M | `{}` | Initialized empty when set to in progress. |

> Read with `GetItem(pk=<tenantId>#<fileName>, sk=blog)`. The cross-post machine checks
> `status`; the publish machine checks the per-publisher `status` via
> `get-publisher-status.mjs`.

#### 4. Weekly view count (analytics snapshot)
One item per article per weekly run, capturing both the running total and the
week-over-week delta.

| Attribute | Type | Example | Notes |
|---|---|---|---|
| `pk` | S | `/blog/my-post` | The article URL (same as catalog `pk`). |
| `sk` | S | `viewCount-2026-06-22` | `viewCount-<YYYY-MM-DD>` (execution start date). |
| `weekly` | M | `{ blog, medium, dev, hashnode, total }` | Delta vs. the previous snapshot (all `N`). |
| `allTime` | M | `{ blog, medium, dev, hashnode, total }` | Running totals at snapshot time (all `N`). |

> Latest prior snapshot is fetched with `Query(pk=<url>, begins_with(sk,'viewCount'),
> ScanIndexForward=false, Limit=1)`.

### Access patterns

| # | Need | Operation |
|---|---|---|
| 1 | Resolve tenant config/creds | `GetItem` `pk=<tenantId>`, `sk=tenant` |
| 2 | Check/guard publish idempotency | `GetItem` `pk=<tenantId>#<fileName>`, `sk=blog` |
| 3 | List a tenant's catalog (link rewriting) | `Query GSI1` `GSI1PK=blog#<tenantId>` |
| 4 | List all articles for the weekly job | `Query GSI1` `GSI1PK=article` ⚠️ *see note* |
| 5 | Get an article's last snapshot | `Query` `pk=<url>` + `begins_with(sk,'viewCount')`, desc, limit 1 |
| 6 | Write/enrich catalog, idempotency, snapshots | `PutItem` / `UpdateItem` on the keys above |

> ⚠️ **Inconsistency to be aware of:** access pattern #4 queries `GSI1PK = "article"`,
> but the only writer of `GSI1PK` (Save Catalog Entry) writes `blog#<tenantId>`. In this
> repo nothing writes `article`, so the weekly job's "Get All Blogs" returns nothing
> unless the data was seeded elsewhere. The next-gen design fixes the GSI1 convention.

The **catalog** is central to reformatting: internal links between articles are rewritten
to point at the *platform-native* copy of the linked article when one exists (e.g. a link
to another RSC post becomes its Dev.to/Medium/Hashnode URL), otherwise it falls back to
the absolute `readysetcloud.io` URL.

---

## Cross-post flow in detail

### 1. Trigger (`ImportFromGithubFunction`)

Listens for EventBridge events:

```json
{ "detail-type": "Create New Blog", "detail": { "source": "github" } }
```

Event detail shape:

```json
{
  "detail": {
    "tenantId": "<tenant id>",
    "github": { "fileName": "path/to/post.md", "branchName": "main" }
  }
}
```

It resolves the tenant, fetches the file from GitHub, parses frontmatter, and starts
`CrossPostStateMachine` with a payload containing the post content, `crossPostTo`
list (from frontmatter `crosspost`), the canonical `url` (`/blog/<slug>`), a `key`
(`<tenant.pk>#<fileName>`), an optional `futureDate` (if the post date is in the
future), and `shouldPublish` (from the `SHOULD_PUBLISH` env var — only `true` in
production).

#### Required frontmatter

`ParseBlog` and `ImportFromGithub` read these frontmatter fields:

- `title`, `description`, `slug` (leading char stripped: `slug.substring(1)`),
  `image`, optional `image_attribution`
- `date` (publish date; future dates schedule a wait + site rebuild)
- `categories[]` and `tags[]` (combined and space-stripped into platform tags)
- `crosspost[]` — subset of `["dev","medium","hashnode"]`

### 2. `CrossPostStateMachine`

- **Idempotency:** read the record; if present and not `failed`, succeed as a duplicate.
- Mark `in progress`; if the post is future-dated *and* `shouldPublish`, **wait** until
  `futureDate`, then emit a `Trigger Site Rebuild` event.
- **`GetCrosspostDates`** returns a per-platform timestamp or the sentinel
  `"DO NOT PUBLISH"`. When `SHOULD_PUBLISH !== 'true'` every platform is
  `DO NOT PUBLISH`. With `DELAY_TYPE=delay` (production) each platform is staggered
  3–5+ days out, forced onto a weekday, at a random hour 16:00–18:00; otherwise all
  publish immediately.
- **Save catalog entry** (the `<url>/blog` item with its GSI keys).
- **Parallel fan-out** — one branch per platform. Each branch waits for its scheduled
  timestamp (unless `DO NOT PUBLISH`), then starts `PublishStateMachine` with a
  platform-specific **request contract** (see below).
- Mark the record `succeeded` (or `failed` on error).

### 3. `PublishStateMachine` (per platform)

- Idempotency per publisher (skip if that publisher already `succeeded`).
- Load content from GitHub (`GetBlogContent`), load the tenant's catalog (`GSI1`).
- **`ParseBlog`** transforms the Markdown into the platform payload.
- If `shouldPublish === "true"`, invoke **`SendApiRequest`** to POST it; otherwise stop
  at success (dry run).
- **`GetPublisherOutput`** extracts the new `url`/`id` from the response via JSONPath.
- Record id + url onto both the idempotency record and the catalog entry, then send a
  success email via EventBridge (or a failure email on any error).

---

## Platform API contracts

These are the exact request shapes the cross-post machine passes to `SendApiRequest`,
and the payloads `ParseBlog` produces. Reproduce these precisely.

### Dev.to
- **Endpoint:** `POST https://dev.to/api/articles`
- **Auth:** header `api-key: <secret.dev>`
- **Headers:** `accept: application/vnd.forem.api-v1+json`
- **Body:** `{ "article": { title, published: true, main_image, canonical_url,
  description, tags[] (space-stripped), organization_id: 2491, body_markdown } }`
- **Output:** id at `$.result.Payload.id`. Tweets become `{% twitter <url> %}` liquid tags.

### Medium
- **Endpoint:** `POST https://api.medium.com/v1/publications/5517fd7b58a6/posts`
- **Auth:** **query string** `accessToken=<secret.medium>`
- **Body:** `{ title, contentFormat: "markdown", tags[], canonicalUrl,
  publishStatus: "draft", notifyFollowers: true, content }` where `content` is a
  composed Markdown doc (title + description + hero image + body, with `## ` headings
  turned into `---` separators).
- **Output:** url at `$.result.Payload.data.url`, id at `$.result.Payload.data.id`.

### Hashnode
- **Endpoint:** `POST https://gql.hashnode.com` (GraphQL)
- **Auth:** header `Authorization: <secret.hashnode>`
- **Headers:** `content-type: application/json`
- **Body:** GraphQL `publishPost` mutation. `variables.input` includes `title`,
  `subtitle`, `publicationId: "626beb20b7dcabd258e7436c"`, `contentMarkdown`,
  `coverImageOptions`, `originalArticleURL`, `tags[] ({slug,name})`, and `metaTags`.
  Tweets become `%[<url>]` embeds.
- **Output:** slug at `$.result.Payload.data.publishPost.post.slug`; the public URL is
  composed as `https://allenheltondev.hashnode.dev/<slug>`.

### Content reformatting spec (`parse-blog.mjs`)

This is the exact behavior an implementation must reproduce. `ParseBlog` receives
`{ post, catalog, format }` where `post` is the raw Markdown (frontmatter + body),
`catalog` is the tenant's catalog items (DynamoDB-marshalled), and `format` is the
publisher name. It returns `{ payload, url }`.

**Step 0 — split frontmatter.** Parse with `@github-docs/frontmatter`, giving
`data` (the frontmatter object) and `content` (the body Markdown).

**Step 1 — extract links and tweets** from the *body* with these exact regexes:

```js
// every markdown link target, i.e. the text inside (...)
const links  = content.matchAll(/\(([^\)]*)\)/g);
// Hugo tweet shortcodes: {{<tweet user="handle" id="123">}}
const tweets = content.matchAll(/\{\{<tweet user="([a-zA-Z0-9]*)" id="([\d]*)">\}\}/g);
// tweet URL built from the capture groups:
const tweetUrl = `https://twitter.com/${tweet[1]}/status/${tweet[2]}`;
```

`link[1]` is the captured URL (the bit inside the parens). `tweet[0]` is the whole
shortcode match; `tweet[1]`/`tweet[2]` are the handle/id.

**Step 2 — build the per-platform body** (differences are the important part):

| | Dev.to | Medium | Hashnode |
|---|---|---|---|
| Base content | body as-is | **prepended header block** (see below) | body as-is |
| Heading rule | — | every `\n\n## ` → `\n\n---\n\n## ` (insert an `---` divider before each H2) | — |
| Tweet replacement | `tweet[0]` → `` `{% twitter <tweetUrl> %}` `` | `tweet[0]` → `<tweetUrl>` (bare URL) | `tweet[0]` → `` `%[<tweetUrl>]` `` |
| Link self-host fallback base | `process.env.BLOG_BASE_URL` | `process.env.BLOG_BASE_URL` | hard-coded `https://readysetcloud.io` |

Medium's prepended header block (note the literal `#`, `####`, and image markdown):

```js
let mediumContent =
  `\n# ${data.title}\n` +
  `#### ${data.description}\n` +
  `![${data.image_attribution ?? ''}](${data.image})\n` +
  `${content}`;
mediumContent = mediumContent.replace(/\n\n## /g, '\n\n---\n\n## ');
```

**Step 3 — rewrite cross-links to stay on-platform.** For each extracted `link`, look
for a catalog entry whose canonical URL matches the link target:

```js
const replacement = catalog.find(c => c.links.M.url.S == link[1]);
```

If found, replace `link[1]` in the content with, in priority order:
1. the linked article's **native URL on the current platform** —
   `replacement.links.M.<platform>.S` (`dev` / `medium` / `hashnode`); else
2. the **absolute canonical URL** — `<base><replacement.links.M.url.S>`, where `<base>`
   is `BLOG_BASE_URL` for Dev.to/Medium and the literal `https://readysetcloud.io` for
   Hashnode.

So a link to *another of your posts* points readers at the copy on the platform they're
already reading, and falls back to the main site only when no native copy is catalogued.
(Replacement uses `String.replace`, i.e. **first occurrence only** per match — a known
sharp edge if the same URL appears twice; see improvements.)

**Step 4 — assemble tags.** `tags = [...data.categories, ...data.tags]`. Dev.to and
Hashnode strip spaces from each tag (`'Serverless Patterns'` → `'ServerlessPatterns'`);
Hashnode emits `{ slug, name }` objects with the stripped value for both. Medium passes
categories/tags through unchanged.

**Step 5 — canonical URL / return.** Canonical URL is
`https://readysetcloud.io/blog/${data.slug.substring(1)}` (the leading char of `slug` is
dropped). The function returns `{ payload, url: '/blog/' + data.slug.substring(1) }`.

**Worked example.** Body fragment:

```markdown
I wrote about [idempotency](/blog/idempotency-in-step-functions) before.
{{<tweet user="allenheltondev" id="1700000000000000000">}}
```

…with a catalog entry whose `links.url = /blog/idempotency-in-step-functions` and
`links.dev = https://dev.to/allenheltondev/idempotency-abc` produces, **for Dev.to**:

```markdown
I wrote about [idempotency](https://dev.to/allenheltondev/idempotency-abc) before.
{% twitter https://twitter.com/allenheltondev/status/1700000000000000000 %}
```

For **Hashnode** the same link (no `links.hashnode` present) falls back to
`https://readysetcloud.io/blog/idempotency-in-step-functions`, and the tweet becomes
`%[https://twitter.com/allenheltondev/status/1700000000000000000]`.

> **Improvements for the rewrite (carry into the rebuild):** the link regex matches the
> inside of *any* `(...)`, not just Markdown links, so it can touch parenthetical prose;
> and `String.replace` only swaps the first occurrence. Prefer a real Markdown AST
> (e.g. `remark`) to rewrite only true link nodes, and handle repeated targets.

### Re-implementing `SendApiRequest`

The shared lambda receives:

```json
{
  "secretKey": "dev|medium|hashnode",
  "auth": { "location": "header|query", "key": "api-key|accessToken|Authorization" },
  "request": { "method": "POST", "headers": { }, "baseUrl": "https://...", "body": { } }
}
```

It must: look up the Secrets Manager secret, take `secret[secretKey]` as the credential,
place it either in a request header or the query string per `auth.location`/`auth.key`,
send `request.method request.baseUrl` with the given headers and JSON `body`, and return
the parsed platform response (so the JSONPaths above resolve).

---

## Analytics flow (`BlogViewCountStateMachine`)

- **Schedule:** `cron(0 11 ? * MON *)` (Mondays 11:00 UTC).
- Query `GSI1` for all articles, then for each (concurrency 1):
  - **`GetViewCount`** fetches views from four sources in parallel:
    - **RSC / canonical site** via Google Analytics Data API (property `363019578`,
      `screenPageViews` for `pagePath` beginning `/blog/`), using the `ga` credential.
    - **Medium** via private GraphQL (`StatsPostReferrersContainer`) with `medium-cookie`.
      A `429` is rethrown as a custom `RateLimitExceeded` error (the state machine
      retries it with a 30s base backoff).
    - **Dev.to** via `GET /api/analytics/historical` with the `dev` api-key header.
    - **Hashnode** via the private `post-stats` AJAX endpoint with the `hashnode` token.
  - **`CompareViewCounts`** computes deltas vs. the most recent prior `viewCount-*`
    item and writes weekly deltas into **Momento sorted sets** (`blogcounts`,
    `mediumcounts`, `devcounts`, `hashnodecounts`, `totalcounts` in cache `chatgpt`).
  - Store a new `viewCount-<date>` item with `weekly` and `allTime` maps.
- **`GetTopBlogs`** reads the top 5 from each Momento sorted set and builds an HTML
  table; the machine emails it via EventBridge (`Send Email`).

---

## Emails & events

The service does not send email directly — it publishes EventBridge events that a
separate notification service consumes:

```json
{
  "DetailType": "Send Email",
  "Source": "user.CrossPostStateMachine",
  "Detail": { "subject": "...", "to": "<AdminEmail>", "html": "..." }
}
```

It also emits `Trigger Site Rebuild` (`source: user.CrossPostStateMachine`) when a
future-dated post becomes live.

---

## Configuration / parameters

`template.yaml` parameters:

- `Environment` — `sandbox` | `stage` | `production` (default `sandbox`). Controls
  `SHOULD_PUBLISH` (only `true` in production) and `DELAY_TYPE` (`delay` in production,
  else `now`).
- `HashnodeBlogUrl` — default `https://allenheltondev.hashnode.dev`.

Runtime: `nodejs20.x`, `arm64`, esbuild (ESM, minified, `.mjs`), X-Ray tracing on.

---

## Replication checklist

To stand this behavior up in another repo:

1. **Provision credentials.** Create a Secrets Manager secret (JSON) with keys:
   `github`, `dev`, `medium`, `medium-cookie`, `hashnode`, `ga`
   (gzip+base64 GA service-account JSON), `momento`. Store its ARN in SSM at
   `/readysetcloud/secrets` (or your own path) and wire it in as `SECRET_ID`.
2. **Create SSM config params:** `github-owner`, `github-repo`, `admin-email`, and
   `send-api-request` (ARN of your HTTP lambda).
3. **Create the DynamoDB table** with `pk`/`sk` and a `GSI1` (`GSI1PK`/`GSI1SK`).
4. **Implement `SendApiRequest`** (the shared authenticated-POST lambda) per the
   contract above, or inline the POST into `PublishStateMachine`.
5. **Re-create the three state machines** and the helper Lambdas, keeping the
   request/output contracts and DynamoDB key shapes identical.
6. **Wire the EventBridge trigger** (`Create New Blog` / `source: github`) from your
   content pipeline, and the weekly analytics schedule.
7. Keep the **secret JSON key names equal to the publisher names** (`dev`, `medium`,
   `hashnode`) so `SendApiRequest`'s `secretKey` lookup works.

---

## Next-generation design & improvements

The sections above describe the **legacy** service as it exists today. This section is
the spec for a **rebuild** that keeps the catalog + cross-post + analytics behavior but
removes the parts that aged poorly. Treat it as the target for the new repo.

### Confirmed design changes

1. **Push-based ingestion (drop the GitHub "pull").**
   The trigger event carries the **full Markdown + frontmatter** in its payload instead
   of just a `fileName` to fetch. The service no longer reaches out to GitHub.
   - **Removed:** Octokit, `import-from-github`, `get-blog-content`, the `github` secret,
     and the `github-owner` / `github-repo` config.
   - **New event shape:**
     ```json
     {
       "detail-type": "Create New Blog",
       "detail": {
         "tenantId": "allen.helton",
         "fileName": "posts/my-post.md",
         "content": "---\ntitle: ...\n---\n# body markdown..."
       }
     }
     ```
   - **Why:** decouples the service from a specific source repo, makes every step
     deterministically testable from a fixture, and kills a network dependency +
     credential. The content producer (GitHub Action, CMS webhook, etc.) owns "where
     content comes from"; this service just publishes what it's handed.

2. **No shared/config Parameter Store, no Secrets Manager. Secrets become per-tenant
   SecureString SSM parameters.**
   - **Removed:** `/readysetcloud/secrets`, `/readysetcloud/admin-email`,
     `/readysetcloud/send-api-request`, `/readysetcloud/github-*`, and the single shared
     Secrets Manager secret.
   - **Kept (the *only* remaining Parameter Store use):** one **SecureString** parameter
     per tenant holding that tenant's platform tokens as JSON, e.g.
     `/<service>/tenants/<tenantId>/credentials` →
     `{ "dev": "...", "medium": "...", "medium-cookie": "...", "hashnode": "...", "ga": "..." }`.
     The tenant record points at it via `credentialsParameter`.
   - Other former-SSM values become plain **env vars / SAM parameters** (admin email,
     publication ids, etc.).
   - **Why:** per-tenant SecureString gives tenant-scoped IAM (`ssm:GetParameter` on
     `/<service>/tenants/<tenantId>/*`) and independent rotation, with no global secret
     blob and no second secrets product to manage.

3. **Inline the HTTP call — delete `SendApiRequest`.**
   The shared lambda was *literally a wrapper around `fetch`*. Replace it with one of:
   - a **Step Functions HTTP Task** (EventBridge API Destinations) for the publish POST —
     no Lambda at all; or
   - a small inline `publish` Lambda that reads the tenant token, sets the header/query
     credential, and `fetch`es — when per-tenant auth injection is easier in code.
   Either way the cross-service SSM ARN indirection goes away. The auth/request/output
   contract (header-vs-query, JSONPath extraction) stays the same — just inlined.

4. **Remove Momento entirely.**
   The weekly job used Momento sorted sets only to rank "top N" articles. Since every
   weekly snapshot is already in DynamoDB, compute the ranking from there:
   - keep writing `viewCount-<date>` snapshots (with `weekly` deltas);
   - for the summary, `Query GSI1` for the latest snapshot per article (add a snapshot to
     `GSI1` keyed `GSI1PK=viewCount#<date>`), sort the handful of rows in memory, take
     the top 5 per source. Article volume is tiny — no cache needed.
   - **Removed:** `@gomomento/sdk`, `getCacheClient`, and the arbitrary `chatgpt` /
     `*counts` set names.

### Data-model cleanups

- **Add an explicit `entityType` (or `type`) attribute** to every item so kinds aren't
  inferred from key *shape*. Today catalog entries and idempotency records both use
  `sk = blog` and are told apart only by `pk` format.
- **Fix the `GSI1` convention** so the weekly job actually finds articles. Pick one
  scheme and use it for both reads and writes — e.g. `GSI1PK = article#<tenantId>` for
  catalog entries, and have "Get All Blogs" query that (or fan out per tenant). The
  current `GSI1PK="article"` read matches nothing that gets written.
- **One idempotency key scheme.** Use entity-prefixed keys (e.g. `pk=ARTICLE#<url>`,
  `pk=IDEMPOTENCY#<tenant>#<file>`, `pk=TENANT#<id>`) so partitions are self-describing.
- **Seed `links.url` (the canonical URL) explicitly** when the catalog entry is created.
  `parse-blog` reads `links.M.url.S`, but no step writes it today.

### Latent bugs in the legacy code to fix in the rewrite

These were found while documenting the service; carry fixes into the new implementation:

- `publish.asl.json` → **Update Record- Success** sets the catalog `id` from
  `$.publisher.output.url` (copy/paste — should be `.id`).
- `publish.asl.json` → **Update Catalog** writes `links.<publisher> = $.publisher.output.link`,
  but `get-publisher-output.mjs` only returns `url` and `id` — `link` is never produced,
  so the link write resolves to null.
- `get-blog-content.mjs` references an undefined `data` (`frontmatter(data)`) when
  `includeMetadata` is true; it should be `frontmatter(content)`. (Moot once ingestion is
  push-based, but the metadata-parse logic moves with it.)
- `helpers.mjs` → `getTenant` caches with the literal key `tenants.tenantId` (not
  `tenants[tenantId]`), and `getOctokit` caches one client globally — both leak the first
  tenant's data/credentials to later tenants. (Caching moot once pull is gone, but apply
  the same care to the per-tenant *secret* cache.)
- `get-view-count.mjs` → `getHashnodeData` shadows `hashnodeArticles` with an inner
  `const`, so `cachedHashnodeArticles` is set to the empty outer array and the cache never
  warms.

### Operational improvements worth adding

- **Tests.** `npm test` currently just errors. The reformat (`parse-blog`), output
  extraction (`get-publisher-output`), and crosspost-date logic are pure and easy to unit
  test — add fixtures per platform.
- **Frontmatter validation at ingestion** (title/slug/date/tags present and well-typed)
  so a bad post fails fast with a clear message instead of mid-publish.
- **DLQs + alarms** on the analytics `Map` and the cross-post `Parallel` branches, and a
  failure alarm on each state machine, so a silent per-platform failure is visible.
- **Structured logging + tracing** (the legacy `console.error`s swallow context); keep
  X-Ray on.
- **Least-privilege IAM per tenant path** for the SecureString reads.
- **Idempotent platform publishes** where the API supports it (Dev.to/Hashnode), so a
  retry doesn't create duplicate posts.

---

## Local development

```bash
npm ci          # install deps
npm run lint    # eslint
sam build --parallel
sam deploy --stack-name blog-service --resolve-s3 \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides Environment=sandbox
```

Production deploys run automatically from `main` via
`.github/workflows/deploy.yaml` (`Environment=production`).
