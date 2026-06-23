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

## Data flow & DynamoDB model

Single table, keyed by `pk` / `sk`, with one GSI (`GSI1PK` / `GSI1SK`).

| Item | pk | sk | Notes |
|---|---|---|---|
| Tenant | `<tenantId>` | `tenant` | `apiKeyParameter`, `github.{owner,repo}`, `email`. |
| Catalog entry | `<url>` (e.g. `/blog/my-slug`) | `blog` | `GSI1PK = blog#<tenantId>`, `GSI1SK = <fileName>`. Holds `ids` and `links` maps (per-platform id + URL). |
| Idempotency record | `<tenant.pk>#<fileName>` | `blog` | `status` (`in progress`/`succeeded`/`failed`) plus per-publisher status maps. |
| Weekly view count | `<articleUrl>` | `viewCount-<YYYY-MM-DD>` | `weekly` and `allTime` maps of `{ blog, medium, dev, hashnode, total }`. |

The **catalog** serves a key purpose during reformatting: internal links between
articles are rewritten to point at the *platform-native* copy of the linked article
when one exists (e.g. a link to another RSC post becomes its Dev.to/Medium/Hashnode URL
if known), otherwise it falls back to the absolute `readysetcloud.io` URL.

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

> **Link & tweet rewriting (all platforms):** `ParseBlog` finds Markdown links
> `(...)` and Hugo tweet shortcodes `{{<tweet user="x" id="123">}}`. Links matching a
> catalogued article are swapped for that platform's native URL (or the absolute RSC
> URL). Tweet shortcodes become each platform's embed/URL form.

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
