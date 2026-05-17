# Fortnite Data API MCP — Design Spec

**Status:** Draft (awaiting user review)
**Date:** 2026-05-17
**Topic:** MCP server that wraps the public Fortnite Data API (`https://api.fortnite.com/ecosystem/v1`)
**Distribution:** Open-source public npm package, stdio transport

---

## 1. Goal & Scope

Build a TypeScript/Node MCP server that exposes the [Fortnite Data API](https://dev.epicgames.com/documentation/fortnite/using-fortnite-data-api-in-fortnite) — the public ecosystem API for Fortnite Islands (UEFN/Creative experiences) and their engagement metrics — to MCP clients (Claude Desktop, Claude Code, Cursor, etc.).

Users install via `npx fortnite-data-api-mcp` and configure their MCP client to launch it over stdio. No authentication setup is required.

**In scope:**
- 3 semantic tools covering all 13 GET endpoints of the API
- Cursor pagination, interval/metrics filtering, 429 backoff retry
- Normalized errors surfaced to the LLM with a `[kind]` prefix and the upstream `uuid` for traceability
- npm-publishable package with `bin` entry, GitHub Actions CI (lint + test + build)

**Out of scope:**
- HTTP/SSE transport, multi-tenant deployment, response caching
- Relative-time helpers (`"yesterday"`, `"last hour"`) — LLM computes ISO strings
- OpenAPI codegen — the API is small and stable enough that hand-written types win
- Real-API integration tests in CI (msw mocks only)

---

## 2. Upstream API: Verified Facts

Source: `https://api.fortnite.com/ecosystem/v1/docs/openapi.yaml` (OpenAPI 3.1.1, `info.version: 1.0.0`).

### 2.1 Authentication — None Required

The spec defines an OAuth2 client_credentials `securitySchemes` block but **never references it** via any `security:` requirement (no top-level `security:`, no per-operation `security:`). Empirical probe on 2026-05-17 confirmed:

| Request (no Authorization header) | Result |
| --- | --- |
| `GET /islands?size=2` | `200`, real payload |
| `GET /islands/0000-0000-0000` | `404` business not-found (not `401`) |
| `GET /islands/battle-royale` | `200`, returns BR metadata |

The MCP server **does not implement OAuth**. If Epic enables auth in the future, we add an `auth.ts` layer and required env vars at that time.

### 2.2 Endpoints (13 GETs, all under `/islands`)

| Path | Purpose |
| --- | --- |
| `/islands` | Paginated list of islands, newest first |
| `/islands/{code}` | Metadata for one island |
| `/islands/{code}/metrics` | All 8 metrics, daily buckets |
| `/islands/{code}/metrics/{interval}` | All or filtered metrics; `interval ∈ {day, hour, minute}`; supports `metrics[]` repeated query |
| `/islands/{code}/metrics/{interval}/<name>` × 8 | Single-metric paths: `peak-ccu`, `favorites`, `minutes-played`, `average-minutes-per-player`, `recommendations`, `plays`, `unique-players`, `retention` |

`/islands/{code}/metrics/{interval}` is a **strict superset** of the 8 single-metric paths (any subset selectable via `metrics[]`) and of the bare `/metrics` path (it equals `interval=day` with no filter). The MCP collapses all metric calls onto this one endpoint.

### 2.3 Upstream Constraints (must be surfaced in tool descriptions)

- Historical data ≤ 7 days.
- An interval bucket with < 5 unique players returns `value: null`.
- `retention` only populated when `interval=day`; `404` on `hour`/`minute` for the dedicated retention path.
- `averageMinutesPerPlayer` only populated when `interval ∈ {day, hour}`.
- Some Epic first-party games return `0` for `favorites` and `recommendations`.
- `code` parameter accepts either an island code (e.g. `1234-1234-1234`) or a `displayName` alias (e.g. `battle-royale`).
- `from` query default varies by interval: day → start of previous day; hour → `now-24h`; minute → `now-60m`.
- `to` is exclusive; `from` is inclusive.
- Errors return `{ errorCode, errorMessage, uuid }`.
- `429` responses include `text/plain` body and `Retry-After` header.

---

## 3. Architecture

### 3.1 Layered design (3 layers)

```
config.ts   →   client.ts   →   tools/*.ts   →   server.ts
(optional env)  (fetch+retry)   (3 handlers)     (MCP wiring)
```

Each layer has one clear job, depends only on the layer to its left, and is independently testable. The deliberate absence of an `auth` layer reflects §2.1.

### 3.2 Repository layout

```
fortnite-data-api-mcp/
├── .gitignore              # node_modules/, dist/, .DS_Store, .env*, *.log, coverage/, .scratch/
├── .github/workflows/ci.yml
├── package.json            # "bin": { "fortnite-data-api-mcp": "dist/server.js" }
├── tsconfig.json
├── tsup.config.ts          # ESM bundle, target node20
├── README.md               # install, client config snippets, tool docs
├── LICENSE                 # (existing)
├── docs/
│   └── specs/              # this file
├── src/
│   ├── server.ts           # MCP server entry — registers tools, starts stdio transport
│   ├── client.ts           # FortniteClient: fetch + 429/5xx backoff + error normalization
│   ├── config.ts           # loadConfig() reads optional env vars
│   ├── errors.ts           # ApiError class + helpers
│   ├── schemas.ts          # zod schemas for tool inputs (also drive JSON Schema for LLM)
│   └── tools/
│       ├── listIslands.ts
│       ├── getIsland.ts
│       └── getIslandMetrics.ts
└── test/
    ├── fixtures/           # real captured responses saved as JSON
    ├── client.test.ts
    ├── server.test.ts
    └── tools/
        ├── listIslands.test.ts
        ├── getIsland.test.ts
        └── getIslandMetrics.test.ts
```

### 3.3 Tech stack

| Concern | Choice | Notes |
| --- | --- | --- |
| MCP framework | `@modelcontextprotocol/sdk` (official) | stdio transport |
| Input schemas | `zod` | SDK converts zod → JSON Schema for the LLM |
| HTTP | global `fetch` (Node ≥ 20) | no library needed |
| Tests | `vitest` + `msw` | HTTP-level mocking, not fetch mocking |
| Build | `tsup` | single ESM bundle to `dist/server.js` |
| Lint | `eslint` + `@typescript-eslint` | minimal config |
| CI | GitHub Actions | matrix `node-version: [20, 22]` |
| Runtime | Node ≥ 20 | `engines.node: ">=20"` in package.json |

### 3.4 `.gitignore`

```
node_modules/
dist/
coverage/
.DS_Store
.env
.env.local
*.log
.scratch/
```

---

## 4. Tool Contracts

All three tools accept their inputs as a single JSON object, validated by zod. Outputs are JSON via the MCP `content: [{ type: "text", text: JSON.stringify(...) }]` convention.

Numbered field annotations below (e.g. ❗) appear in the tool's `description` string verbatim so the LLM sees them.

### 4.1 `list_islands`

> List public, discoverable Fortnite islands, sorted newest-release-first. Cursor-paginated.

**Input:**
```ts
{
  size?: number,     // default 100, range 1–1000
  after?: string,    // cursor; mutually exclusive with `before`
  before?: string,   // cursor; mutually exclusive with `after`
}
```

`after` and `before` mutually exclusive at the zod level (`refine`).

**Output (lightly reshaped — see §4.4 for rationale):**
```ts
{
  islands: Array<{
    code: string,
    creatorCode?: string,
    displayName?: string,
    title: string,
    category?: string,
    createdIn?: string,
    tags: string[],
    cursor: string,    // hoisted from data[].meta.page.cursor
  }>,
  count: number,
  nextCursor: string | null,
  prevCursor: string | null,
}
```

**Upstream:** `GET /islands?size=&after=&before=`.

### 4.2 `get_island`

> Fetch metadata for one Fortnite island.

**Input:**
```ts
{ code: string }   // island code (e.g. "1234-1234-1234") OR displayName (e.g. "battle-royale")
```

**Output:** Pass-through of `IslandMetadataSummary`:
```ts
{
  code: string,
  creatorCode?: string,
  displayName?: string,
  title: string,
  category?: string,
  createdIn?: string,
  tags: string[],
}
```

**Upstream:** `GET /islands/{code}`.
**404:** Surfaced as `ApiError("not_found", …)`.

### 4.3 `get_island_metrics`

> Engagement metrics for one Fortnite island. Single tool covers aggregate + interval + per-metric API paths.

**Input:**
```ts
{
  code: string,                              // island code or displayName
  interval?: "day" | "hour" | "minute",      // default "day"
  metrics?: Array<MetricName>,               // default: all 8
  from?: string,                             // ISO 8601; default depends on interval (§2.3)
  to?: string,                               // ISO 8601, exclusive
}

type MetricName =
  | "peakCCU" | "favorites" | "minutesPlayed"
  | "averageMinutesPerPlayer" | "recommendations"
  | "plays" | "uniquePlayers" | "retention";
```

The `metrics` array must be non-empty and contain only valid enum values (zod-enforced).

**Output:** Pass-through of `FilterableIslandMetricsResponse`:
```ts
{
  averageMinutesPerPlayer?: Array<{ value: number | null; timestamp: string }>,
  peakCCU?:                  Array<{ value: number | null; timestamp: string }>,
  favorites?:                Array<{ value: number | null; timestamp: string }>,
  minutesPlayed?:            Array<{ value: number | null; timestamp: string }>,
  recommendations?:          Array<{ value: number | null; timestamp: string }>,
  plays?:                    Array<{ value: number | null; timestamp: string }>,
  uniquePlayers?:            Array<{ value: number | null; timestamp: string }>,
  retention?:                Array<{ d1: number | null; d7: number | null; timestamp: string }>,
}
```

**Upstream:** Always `GET /islands/{code}/metrics/{interval}?metrics=…&from=…&to=…`. The `metrics` query is `style=form, explode=true`, i.e. repeated keys: `?metrics=peakCCU&metrics=favorites`.

**Tool description must list (verbatim):**
- Historical data limited to 7 days.
- `retention` is populated only when `interval=day`.
- `averageMinutesPerPlayer` is populated only when `interval ∈ {day, hour}`.
- Bucket value is `null` when fewer than 5 unique players in that bucket.
- Some Epic first-party games return `0` for `favorites` and `recommendations`.
- `code` accepts either an island code or a `displayName`.

### 4.4 Output reshaping rules

- **`list_islands`:** reshape. Upstream embeds the per-row cursor at `data[i].meta.page.cursor` (a nested-object-with-only-one-leaf pattern that wastes LLM context). We hoist it to `islands[i].cursor` and put pagination cursors at the top level alongside `count`. Everything else is passed through.
- **`get_island`, `get_island_metrics`:** pass through. The shapes are already flat and LLM-friendly.

Hoisting and pass-through are both implemented in the tool handler, not the client — the client returns raw parsed JSON.

---

## 5. Configuration

`src/config.ts` exposes `loadConfig()` returning a frozen object. All env vars are **optional**.

| Env var | Default | Purpose |
| --- | --- | --- |
| `FORTNITE_API_BASE_URL` | `https://api.fortnite.com/ecosystem/v1` | Override for testing / proxies |
| `FORTNITE_API_TIMEOUT_MS` | `15000` | Per-request timeout via `AbortSignal.timeout` |
| `FORTNITE_API_LOG_LEVEL` | `info` | `silent` | `error` | `info` | `debug` — logs go to stderr only (stdio transport uses stdout) |

No `.env` file is required to run. Misformatted values fall back to defaults with a warning to stderr.

---

## 6. Data Flow

```
MCP client ──► server.ts (tools/call route)
                 │
                 ▼
              tools/<tool>.ts
                 1. zod.parse(args)  → InvalidParams on failure
                 2. build query
                 3. client.get(path, query)
                 4. reshape (only list_islands)
                 │
                 ▼
              client.ts ── FortniteClient.get()
                 1. fetch(BASE + path, { signal: timeout })
                 2. switch (status):
                      2xx  → JSON.parse → return
                      400  → throw ApiError("invalid_params")
                      404  → throw ApiError("not_found")
                      429  → backoff retry (see §7.1)
                      5xx  → backoff retry (see §7.1)
                      else → throw ApiError("upstream")
                 3. AbortError / network → throw ApiError("network" | "timeout")
```

---

## 7. Error Handling

### 7.1 Retry policy (`client.ts`)

- **Retryable statuses:** `429`, `500`, `502`, `503`, `504`.
- **Budget:** up to 2 retries (3 total attempts).
- **Backoff schedule:** 500 ms → 2000 ms, with ±25 % jitter.
- **`Retry-After` (429 only):** if present and ≤ 10 s, sleep for that duration instead of the schedule; if > 10 s, abort retries and surface `ApiError("rate_limited", retryAfterMs)` so the LLM can give up gracefully.
- **5xx:** uses the static schedule (don't trust upstream `Retry-After` semantics on 5xx).
- All sleeps are plain `await sleep(ms)` — the MCP server is single-tool-call-at-a-time.

### 7.2 `ApiError` shape (`src/errors.ts`)

```ts
class ApiError extends Error {
  kind:
    | "invalid_params"   // zod failure OR upstream 400
    | "not_found"        // upstream 404
    | "rate_limited"     // upstream 429 after retries exhausted
    | "upstream"         // any other non-2xx
    | "network"          // fetch threw (DNS, ECONNRESET, …)
    | "timeout";         // AbortSignal.timeout fired
  status?: number;       // HTTP status when applicable
  uuid?: string;         // upstream errorMessage.uuid
  retryAfterMs?: number; // populated on "rate_limited"
}
```

### 7.3 MCP error surface

The server catches `ApiError` at the tool boundary and returns:

```json
{
  "isError": true,
  "content": [{
    "type": "text",
    "text": "[<kind>] <human message> (uuid: <upstream uuid if present>)"
  }]
}
```

Examples:
- `[not_found] Island '0000-0000-0000' not found (uuid: e1aad85b-…)`
- `[invalid_params] 'metrics' must be a non-empty array`
- `[rate_limited] Upstream is rate-limiting. Retry after ~12s.`

Zod validation errors map to `kind: "invalid_params"` with the zod issue list joined into the message. Stack traces are **not** included.

### 7.4 Things we explicitly do not do

- No client-side rate limiting — let `429` reach the LLM transparently after the retry budget.
- No response caching.
- No keep-alive pool tuning.
- No persistence to disk.

---

## 8. Testing Strategy

Stack: `vitest` + `msw` for HTTP-level mocking (no `fetch` patching). Fixtures live in `test/fixtures/` and are captured from real responses recorded during this design phase.

### 8.1 Coverage matrix

| Layer | Cases |
| --- | --- |
| `client.ts` | `200` happy path; `400`/`404` propagate with body; `429` + `Retry-After` honored; `429` no header → backoff schedule; `5xx` retry then succeed; retry budget exhausted; `AbortSignal` timeout; network error |
| `tools/listIslands` | default `size`; custom `size`; `after` cursor passes through; `before` cursor passes through; `after`+`before` together → InvalidParams; cursor hoisting; empty result set |
| `tools/getIsland` | island-code lookup; `displayName` lookup (`battle-royale`); `404` → `ApiError("not_found")` |
| `tools/getIslandMetrics` | default `interval=day` + all metrics; single-metric filter; `interval=hour` returns no `retention`; `from`/`to` query string forwarded; `400` body propagated; empty `metrics` array → InvalidParams |
| `server.ts` | `tools/list` returns 3 tools with correct schemas; `tools/call` routes by name; unknown tool name → MCP error; `ApiError` from handler → `isError: true` with `[kind]` prefix |

### 8.2 Not tested in CI

- Real Fortnite API (no nightly integration job).
- MCP protocol compliance (trusted to `@modelcontextprotocol/sdk`).

---

## 9. Distribution & Operations

- **Package name:** `fortnite-data-api-mcp` (subject to npm availability check at publish time).
- **`bin`:** `fortnite-data-api-mcp` → `dist/server.js` (shebang `#!/usr/bin/env node`).
- **License:** MIT (already in repo as `LICENSE`).
- **README** documents:
  - One-line `npx fortnite-data-api-mcp` quickstart.
  - Claude Desktop `claude_desktop_config.json` snippet.
  - Claude Code `.mcp.json` snippet.
  - All three tools with their input fields.
  - Upstream API constraints (`§2.3`).
  - "No auth required" note (preempts user confusion since the OpenAPI doc lists a `securityScheme`).
- **CI (`.github/workflows/ci.yml`):** matrix node 20/22 — `pnpm install --frozen-lockfile && pnpm lint && pnpm test && pnpm build`.
- **Release:** manual `npm publish` for v0.1.0; consider Changesets later. Not in initial scope.

---

## 10. Open Questions

None blocking. Items to revisit after first iteration:
- Should `list_islands` auto-paginate up to `size` results across multiple upstream pages? (Currently no — single-page; the LLM walks cursors.)
- Should we add a `find_island_by_title` convenience tool? (Defer — there's no upstream search; we'd have to walk pages.)
- Pin a specific OpenAPI version once Epic publishes a stable one (the spec says `openapi: 3.1.1` and `info.version: 1.0.0` as of capture).
