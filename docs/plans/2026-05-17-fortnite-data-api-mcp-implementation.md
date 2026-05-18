# Fortnite Data API MCP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** [docs/specs/2026-05-17-fortnite-data-api-mcp-design.md](../specs/2026-05-17-fortnite-data-api-mcp-design.md)

**Goal:** Build a TypeScript MCP server exposing the public Fortnite Data API (islands list + metadata + engagement metrics) via 3 semantic tools over stdio.

**Architecture:** Three-layer hand-written design: `config` → `client` (fetch + 429/5xx backoff + normalized errors) → `tools` (3 zod-validated handlers). MCP wiring in `server.ts`. No auth (upstream API is public). Pure stdio, single-bundle ESM via `tsup`.

**Tech Stack:** Node ≥ 20, TypeScript, `@modelcontextprotocol/sdk`, `zod`, `vitest`, `msw` v2, `tsup`, `eslint`, `pnpm`.

---

## File Structure

```
fortnite-data-api-mcp/
├── package.json                  # type: module, bin entry, scripts, engines.node ">=20"
├── tsconfig.json                 # strict ESM, target ES2022
├── tsup.config.ts                # bundle src/server.ts → dist/server.js (ESM, shebang)
├── vitest.config.ts              # node env, setupFiles for msw
├── eslint.config.js              # flat config, @typescript-eslint
├── .github/workflows/ci.yml      # lint + test + build on node 20/22
├── README.md                     # install, MCP client config snippets, tool docs
├── src/
│   ├── server.ts                 # McpServer registration + StdioServerTransport
│   ├── client.ts                 # FortniteClient: fetch + retry + error normalization
│   ├── config.ts                 # loadConfig() reads optional env vars
│   ├── errors.ts                 # ApiError class + formatToText helper
│   ├── schemas.ts                # zod schemas for the 3 tool inputs
│   └── tools/
│       ├── listIslands.ts        # handler + cursor-hoisting reshape
│       ├── getIsland.ts          # handler (pass-through)
│       └── getIslandMetrics.ts   # handler (pass-through, query construction)
└── test/
    ├── fixtures/                 # real captured upstream responses
    │   ├── islands-list.json
    │   ├── island-battle-royale.json
    │   ├── island-not-found.json
    │   └── metrics-day-filtered.json
    ├── helpers/
    │   └── msw.ts                # setupServer + per-test handler override util
    ├── setup.ts                  # global vitest setup (msw lifecycle)
    ├── errors.test.ts
    ├── config.test.ts
    ├── client.test.ts
    ├── server.test.ts
    └── tools/
        ├── listIslands.test.ts
        ├── getIsland.test.ts
        └── getIslandMetrics.test.ts
```

**Boundaries:**
- `client.ts` knows about HTTP, retries, and `ApiError`. It does **not** know about MCP, zod, or tool semantics.
- `tools/*.ts` know about tool semantics and call into `client`. They do **not** know about MCP transport (return plain JS values; the server wraps them into MCP content).
- `server.ts` is the only file that imports from `@modelcontextprotocol/sdk`.

---

## Task 1: Project Scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `eslint.config.js`, `.npmignore`, `src/server.ts` (stub), `test/setup.ts` (stub)

This task installs dependencies and lays down config. No TDD — pure setup.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "fortnite-data-api-mcp",
  "version": "0.1.0",
  "description": "MCP server for the public Fortnite Data API (Islands metadata + engagement metrics)",
  "type": "module",
  "bin": {
    "fortnite-data-api-mcp": "./dist/server.js"
  },
  "files": ["dist", "README.md", "LICENSE"],
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint src test",
    "typecheck": "tsc --noEmit",
    "prepublishOnly": "pnpm lint && pnpm typecheck && pnpm test && pnpm build"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^20.12.0",
    "@typescript-eslint/eslint-plugin": "^8.0.0",
    "@typescript-eslint/parser": "^8.0.0",
    "eslint": "^9.0.0",
    "msw": "^2.6.0",
    "tsup": "^8.3.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  },
  "keywords": ["mcp", "fortnite", "fortnite-data-api", "model-context-protocol"],
  "license": "MIT"
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": false,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create `tsup.config.ts`**

```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  target: "node20",
  banner: { js: "#!/usr/bin/env node" },
  clean: true,
  sourcemap: true,
  splitting: false,
  bundle: true,
});
```

- [ ] **Step 4: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["test/setup.ts"],
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
    },
  },
});
```

- [ ] **Step 5: Create `eslint.config.js` (flat config)**

```js
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

export default [
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 2022, sourceType: "module" },
    },
    plugins: { "@typescript-eslint": tseslint },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": ["error", { allow: ["error", "warn"] }],
    },
  },
];
```

- [ ] **Step 6: Create stub `src/server.ts`**

```ts
export {};
```

- [ ] **Step 7: Create stub `test/setup.ts`**

```ts
export {};
```

- [ ] **Step 8: Create `.npmignore`**

```
src/
test/
docs/
.scratch/
.github/
tsconfig.json
tsup.config.ts
vitest.config.ts
eslint.config.js
```

- [ ] **Step 9: Install dependencies**

Run: `pnpm install`
Expected: `node_modules/` populated, lockfile `pnpm-lock.yaml` written.

- [ ] **Step 10: Verify tooling works**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: typecheck passes (empty src), lint passes, vitest reports "No test files found" exit 0 (or rerun with `--passWithNoTests` if needed — adjust config if it errors).

If vitest fails with "no test files", edit `vitest.config.ts` and add `passWithNoTests: true` to the `test` block.

- [ ] **Step 11: Commit**

```bash
git add package.json tsconfig.json tsup.config.ts vitest.config.ts eslint.config.js .npmignore pnpm-lock.yaml src/server.ts test/setup.ts
git commit -m "Add project scaffold (package.json, tsconfig, tsup, vitest, eslint)"
```

---

## Task 2: ApiError (`src/errors.ts`)

**Files:**
- Create: `src/errors.ts`
- Create: `test/errors.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/errors.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ApiError, formatToText } from "../src/errors.js";

describe("ApiError", () => {
  it("captures kind, message, and optional fields", () => {
    const err = new ApiError({
      kind: "not_found",
      message: "Island '0000-0000-0000' not found",
      status: 404,
      uuid: "e1aad85b-3d70-4f74-a83e-9beb8eb5a237",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe("not_found");
    expect(err.status).toBe(404);
    expect(err.uuid).toBe("e1aad85b-3d70-4f74-a83e-9beb8eb5a237");
    expect(err.message).toBe("Island '0000-0000-0000' not found");
  });

  it("stores retryAfterMs for rate_limited", () => {
    const err = new ApiError({
      kind: "rate_limited",
      message: "Upstream is rate-limiting",
      retryAfterMs: 12000,
    });
    expect(err.retryAfterMs).toBe(12000);
  });
});

describe("formatToText", () => {
  it("renders [kind] message with uuid suffix", () => {
    const err = new ApiError({
      kind: "not_found",
      message: "Island not found",
      uuid: "abc-123",
    });
    expect(formatToText(err)).toBe("[not_found] Island not found (uuid: abc-123)");
  });

  it("omits uuid suffix when absent", () => {
    const err = new ApiError({ kind: "network", message: "ECONNRESET" });
    expect(formatToText(err)).toBe("[network] ECONNRESET");
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm test errors`
Expected: FAIL — module `../src/errors.js` not found.

- [ ] **Step 3: Implement `src/errors.ts`**

```ts
export type ApiErrorKind =
  | "invalid_params"
  | "not_found"
  | "rate_limited"
  | "upstream"
  | "network"
  | "timeout";

export interface ApiErrorInit {
  kind: ApiErrorKind;
  message: string;
  status?: number;
  uuid?: string;
  retryAfterMs?: number;
}

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  readonly uuid?: string;
  readonly retryAfterMs?: number;

  constructor(init: ApiErrorInit) {
    super(init.message);
    this.name = "ApiError";
    this.kind = init.kind;
    this.status = init.status;
    this.uuid = init.uuid;
    this.retryAfterMs = init.retryAfterMs;
  }
}

export function formatToText(err: ApiError): string {
  const suffix = err.uuid ? ` (uuid: ${err.uuid})` : "";
  return `[${err.kind}] ${err.message}${suffix}`;
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `pnpm test errors`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/errors.ts test/errors.test.ts
git commit -m "Add ApiError class with normalized kinds and text formatter"
```

---

## Task 3: Config (`src/config.ts`)

**Files:**
- Create: `src/config.ts`
- Create: `test/config.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/config.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../src/config.js";

const ENV_KEYS = [
  "FORTNITE_API_BASE_URL",
  "FORTNITE_API_TIMEOUT_MS",
  "FORTNITE_API_LOG_LEVEL",
] as const;

describe("loadConfig", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("returns defaults when env is empty", () => {
    const cfg = loadConfig();
    expect(cfg.baseUrl).toBe("https://api.fortnite.com/ecosystem/v1");
    expect(cfg.timeoutMs).toBe(15000);
    expect(cfg.logLevel).toBe("info");
  });

  it("reads overrides from env", () => {
    process.env.FORTNITE_API_BASE_URL = "https://example.test/v1";
    process.env.FORTNITE_API_TIMEOUT_MS = "5000";
    process.env.FORTNITE_API_LOG_LEVEL = "debug";
    const cfg = loadConfig();
    expect(cfg.baseUrl).toBe("https://example.test/v1");
    expect(cfg.timeoutMs).toBe(5000);
    expect(cfg.logLevel).toBe("debug");
  });

  it("falls back to default when timeout is not a positive integer", () => {
    process.env.FORTNITE_API_TIMEOUT_MS = "not-a-number";
    expect(loadConfig().timeoutMs).toBe(15000);
    process.env.FORTNITE_API_TIMEOUT_MS = "-5";
    expect(loadConfig().timeoutMs).toBe(15000);
  });

  it("falls back to default when log level is invalid", () => {
    process.env.FORTNITE_API_LOG_LEVEL = "verbose";
    expect(loadConfig().logLevel).toBe("info");
  });

  it("freezes the config object", () => {
    const cfg = loadConfig();
    expect(() => {
      (cfg as { baseUrl: string }).baseUrl = "x";
    }).toThrow();
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm test config`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/config.ts`**

```ts
export type LogLevel = "silent" | "error" | "info" | "debug";

export interface Config {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly logLevel: LogLevel;
}

const DEFAULTS: Config = Object.freeze({
  baseUrl: "https://api.fortnite.com/ecosystem/v1",
  timeoutMs: 15000,
  logLevel: "info" as LogLevel,
});

const LOG_LEVELS: ReadonlySet<LogLevel> = new Set(["silent", "error", "info", "debug"]);

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return undefined;
  return n;
}

function parseLogLevel(raw: string | undefined): LogLevel | undefined {
  if (raw === undefined) return undefined;
  return LOG_LEVELS.has(raw as LogLevel) ? (raw as LogLevel) : undefined;
}

export function loadConfig(): Config {
  return Object.freeze({
    baseUrl: process.env.FORTNITE_API_BASE_URL ?? DEFAULTS.baseUrl,
    timeoutMs: parsePositiveInt(process.env.FORTNITE_API_TIMEOUT_MS) ?? DEFAULTS.timeoutMs,
    logLevel: parseLogLevel(process.env.FORTNITE_API_LOG_LEVEL) ?? DEFAULTS.logLevel,
  });
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `pnpm test config`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "Add loadConfig with optional env overrides and validation"
```

---

## Task 4: Fixtures + MSW helper

**Files:**
- Create: `test/fixtures/islands-list.json`
- Create: `test/fixtures/island-battle-royale.json`
- Create: `test/fixtures/island-not-found.json`
- Create: `test/fixtures/metrics-day-filtered.json`
- Create: `test/helpers/msw.ts`
- Modify: `test/setup.ts`

These are the real captured upstream responses used by the test suites in Tasks 5–11.

- [ ] **Step 1: Create `test/fixtures/islands-list.json`**

```json
{
  "links": {
    "next": "/ecosystem/v1/islands?after=MTc1NC0wNTIyLTQ2ODU%3D&size=2",
    "prev": null
  },
  "meta": { "count": 2, "page": { "nextCursor": "MTc1NC0wNTIyLTQ2ODU=", "prevCursor": null } },
  "data": [
    {
      "code": "6742-1441-9726",
      "creatorCode": "chill-slide",
      "title": "UNC PARKOUR TRICSHOT EASY",
      "createdIn": "UEFN",
      "tags": ["action", "parkour", "difficulty: easy", "deathrun"],
      "meta": { "page": { "cursor": "Njc0Mi0xNDQxLTk3MjY=" } }
    },
    {
      "code": "1754-0522-4685",
      "creatorCode": "sisibuilds",
      "title": "Club FWC",
      "createdIn": "UEFN",
      "tags": ["role playing", "party world", "party game", "music"],
      "meta": { "page": { "cursor": "MTc1NC0wNTIyLTQ2ODU=" } }
    }
  ]
}
```

- [ ] **Step 2: Create `test/fixtures/island-battle-royale.json`**

```json
{
  "displayName": "battle-royale",
  "code": "experience_br",
  "creatorCode": "epic",
  "title": "Battle Royale",
  "createdIn": "UEFN",
  "tags": []
}
```

- [ ] **Step 3: Create `test/fixtures/island-not-found.json`**

```json
{
  "errorCode": "errors.com.epicgames.fne-public-api.not_found",
  "errorMessage": "Not found",
  "uuid": "e1aad85b-3d70-4f74-a83e-9beb8eb5a237"
}
```

- [ ] **Step 4: Create `test/fixtures/metrics-day-filtered.json`**

```json
{
  "peakCCU": [
    { "value": 2, "timestamp": "2026-05-17T00:00:00.000Z" },
    { "value": null, "timestamp": "2026-05-18T00:00:00.000Z" }
  ],
  "uniquePlayers": [
    { "value": 5, "timestamp": "2026-05-17T00:00:00.000Z" },
    { "value": null, "timestamp": "2026-05-18T00:00:00.000Z" }
  ]
}
```

- [ ] **Step 5: Create `test/helpers/msw.ts`**

```ts
import { setupServer, type SetupServerApi } from "msw/node";
import { http, HttpResponse, type HttpHandler } from "msw";

export const BASE_URL = "https://api.fortnite.com/ecosystem/v1";

export function makeMswServer(handlers: HttpHandler[] = []): SetupServerApi {
  return setupServer(...handlers);
}

export { http, HttpResponse };
```

- [ ] **Step 6: Replace `test/setup.ts`**

```ts
import { afterAll, afterEach, beforeAll } from "vitest";
import { makeMswServer } from "./helpers/msw.js";

export const mswServer = makeMswServer();

beforeAll(() => mswServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());
```

- [ ] **Step 7: Verify nothing broke**

Run: `pnpm test`
Expected: previous tests (errors, config) still PASS. No new tests run.

- [ ] **Step 8: Commit**

```bash
git add test/fixtures/ test/helpers/ test/setup.ts
git commit -m "Add msw test harness and captured upstream fixtures"
```

---

## Task 5: FortniteClient — happy path + 4xx (`src/client.ts`)

**Files:**
- Create: `src/client.ts`
- Create: `test/client.test.ts`

This task covers 200 happy path, 400 → `invalid_params`, 404 → `not_found`, and the upstream error body parsing. Retries are added in Task 6.

- [ ] **Step 1: Write failing tests**

Create `test/client.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { FortniteClient } from "../src/client.js";
import { ApiError } from "../src/errors.js";
import { mswServer } from "./setup.js";
import { http, HttpResponse, BASE_URL } from "./helpers/msw.js";
import islandsList from "./fixtures/islands-list.json" with { type: "json" };
import notFound from "./fixtures/island-not-found.json" with { type: "json" };

function makeClient(): FortniteClient {
  return new FortniteClient({ baseUrl: BASE_URL, timeoutMs: 5000 });
}

describe("FortniteClient.get — happy path", () => {
  it("returns parsed JSON on 200", async () => {
    mswServer.use(
      http.get(`${BASE_URL}/islands`, () => HttpResponse.json(islandsList)),
    );
    const client = makeClient();
    const result = await client.get<typeof islandsList>("/islands");
    expect(result.meta.count).toBe(2);
    expect(result.data[0]!.code).toBe("6742-1441-9726");
  });

  it("appends query string params correctly", async () => {
    let captured: URL | undefined;
    mswServer.use(
      http.get(`${BASE_URL}/islands`, ({ request }) => {
        captured = new URL(request.url);
        return HttpResponse.json(islandsList);
      }),
    );
    await makeClient().get("/islands", { size: 2, after: "abc" });
    expect(captured?.searchParams.get("size")).toBe("2");
    expect(captured?.searchParams.get("after")).toBe("abc");
  });

  it("repeats array query params (style=form, explode=true)", async () => {
    let captured: URL | undefined;
    mswServer.use(
      http.get(`${BASE_URL}/islands/abc/metrics/day`, ({ request }) => {
        captured = new URL(request.url);
        return HttpResponse.json({});
      }),
    );
    await makeClient().get("/islands/abc/metrics/day", { metrics: ["peakCCU", "favorites"] });
    expect(captured?.searchParams.getAll("metrics")).toEqual(["peakCCU", "favorites"]);
  });

  it("skips undefined/null query params", async () => {
    let captured: URL | undefined;
    mswServer.use(
      http.get(`${BASE_URL}/islands`, ({ request }) => {
        captured = new URL(request.url);
        return HttpResponse.json(islandsList);
      }),
    );
    await makeClient().get("/islands", { size: 5, after: undefined, before: null });
    expect(captured?.searchParams.has("after")).toBe(false);
    expect(captured?.searchParams.has("before")).toBe(false);
    expect(captured?.searchParams.get("size")).toBe("5");
  });
});

describe("FortniteClient.get — 4xx errors", () => {
  it("throws ApiError(not_found) on 404 with parsed body", async () => {
    mswServer.use(
      http.get(`${BASE_URL}/islands/x`, () => HttpResponse.json(notFound, { status: 404 })),
    );
    await expect(makeClient().get("/islands/x")).rejects.toMatchObject({
      kind: "not_found",
      status: 404,
      uuid: notFound.uuid,
      message: notFound.errorMessage,
    });
  });

  it("throws ApiError(invalid_params) on 400 with parsed body", async () => {
    mswServer.use(
      http.get(`${BASE_URL}/islands/x/metrics/day`, () =>
        HttpResponse.json(
          { errorCode: "errors.com.epicgames.bad", errorMessage: "Bad date", uuid: "u-1" },
          { status: 400 },
        ),
      ),
    );
    await expect(makeClient().get("/islands/x/metrics/day")).rejects.toMatchObject({
      kind: "invalid_params",
      status: 400,
      uuid: "u-1",
      message: "Bad date",
    });
  });

  it("throws ApiError(upstream) on 403 with body", async () => {
    mswServer.use(
      http.get(`${BASE_URL}/islands`, () => HttpResponse.text("forbidden", { status: 403 })),
    );
    const err = await makeClient().get("/islands").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe("upstream");
    expect((err as ApiError).status).toBe(403);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm test client`
Expected: FAIL — module `../src/client.js` not found.

- [ ] **Step 3: Implement `src/client.ts`**

```ts
import { ApiError, type ApiErrorKind } from "./errors.js";

export interface FortniteClientOptions {
  readonly baseUrl: string;
  readonly timeoutMs: number;
}

export type QueryValue = string | number | boolean | string[] | undefined | null;
export type QueryParams = Record<string, QueryValue>;

interface UpstreamErrorBody {
  errorCode?: string;
  errorMessage?: string;
  uuid?: string;
}

function buildUrl(baseUrl: string, path: string, params?: QueryParams): string {
  const url = new URL(baseUrl.replace(/\/$/, "") + path);
  if (!params) return url.toString();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function statusToKind(status: number): ApiErrorKind {
  if (status === 400) return "invalid_params";
  if (status === 404) return "not_found";
  return "upstream";
}

async function parseErrorBody(res: Response): Promise<UpstreamErrorBody> {
  const text = await res.text();
  try {
    return JSON.parse(text) as UpstreamErrorBody;
  } catch {
    return { errorMessage: text || `HTTP ${res.status}` };
  }
}

export class FortniteClient {
  constructor(private readonly opts: FortniteClientOptions) {}

  async get<T>(path: string, params?: QueryParams): Promise<T> {
    const url = buildUrl(this.opts.baseUrl, path, params);
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    });

    if (res.ok) {
      return (await res.json()) as T;
    }

    const body = await parseErrorBody(res);
    throw new ApiError({
      kind: statusToKind(res.status),
      message: body.errorMessage ?? `HTTP ${res.status}`,
      status: res.status,
      uuid: body.uuid,
    });
  }
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `pnpm test client`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/client.ts test/client.test.ts
git commit -m "Add FortniteClient with happy path and 4xx error normalization"
```

---

## Task 6: FortniteClient — retry on 429 + 5xx

**Files:**
- Modify: `src/client.ts`
- Modify: `test/client.test.ts`

Adds the retry policy from spec §7.1:
- 429 with `Retry-After ≤ 10s` → sleep then retry
- 429 with `Retry-After > 10s` → throw `rate_limited` immediately (no further retries)
- 429 without `Retry-After`, and 500/502/503/504 → backoff schedule (500ms → 2000ms ± 25% jitter), up to 2 retries
- Retry budget exhausted on 429 → `rate_limited`; on 5xx → `upstream`

- [ ] **Step 1: Add failing retry tests**

Append to `test/client.test.ts`:

```ts
import { vi } from "vitest";

describe("FortniteClient.get — 429 handling", () => {
  it("honors Retry-After when ≤10s and retries", async () => {
    let calls = 0;
    mswServer.use(
      http.get(`${BASE_URL}/islands`, () => {
        calls += 1;
        if (calls === 1) {
          return new HttpResponse("rate limited", {
            status: 429,
            headers: { "Retry-After": "1" },
          });
        }
        return HttpResponse.json(islandsList);
      }),
    );
    const client = new FortniteClient({ baseUrl: BASE_URL, timeoutMs: 5000, sleep: vi.fn(async () => {}) });
    const result = await client.get<typeof islandsList>("/islands");
    expect(result.meta.count).toBe(2);
    expect(calls).toBe(2);
  });

  it("throws rate_limited immediately when Retry-After > 10s", async () => {
    let calls = 0;
    mswServer.use(
      http.get(`${BASE_URL}/islands`, () => {
        calls += 1;
        return new HttpResponse("rate limited", {
          status: 429,
          headers: { "Retry-After": "30" },
        });
      }),
    );
    const client = new FortniteClient({ baseUrl: BASE_URL, timeoutMs: 5000, sleep: vi.fn(async () => {}) });
    const err = await client.get("/islands").catch((e) => e);
    expect(err.kind).toBe("rate_limited");
    expect(err.retryAfterMs).toBe(30000);
    expect(calls).toBe(1);
  });

  it("retries on 429 without Retry-After using schedule", async () => {
    let calls = 0;
    mswServer.use(
      http.get(`${BASE_URL}/islands`, () => {
        calls += 1;
        if (calls < 3) return new HttpResponse("rate limited", { status: 429 });
        return HttpResponse.json(islandsList);
      }),
    );
    const sleep = vi.fn(async () => {});
    const client = new FortniteClient({ baseUrl: BASE_URL, timeoutMs: 5000, sleep });
    const result = await client.get<typeof islandsList>("/islands");
    expect(result.meta.count).toBe(2);
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("throws rate_limited after retry budget exhausted on 429", async () => {
    let calls = 0;
    mswServer.use(
      http.get(`${BASE_URL}/islands`, () => {
        calls += 1;
        return new HttpResponse("rate limited", { status: 429 });
      }),
    );
    const client = new FortniteClient({ baseUrl: BASE_URL, timeoutMs: 5000, sleep: vi.fn(async () => {}) });
    const err = await client.get("/islands").catch((e) => e);
    expect(err.kind).toBe("rate_limited");
    expect(calls).toBe(3);
  });
});

describe("FortniteClient.get — 5xx handling", () => {
  it("retries on 503 then succeeds", async () => {
    let calls = 0;
    mswServer.use(
      http.get(`${BASE_URL}/islands`, () => {
        calls += 1;
        if (calls < 2) return new HttpResponse("oops", { status: 503 });
        return HttpResponse.json(islandsList);
      }),
    );
    const client = new FortniteClient({ baseUrl: BASE_URL, timeoutMs: 5000, sleep: vi.fn(async () => {}) });
    const result = await client.get<typeof islandsList>("/islands");
    expect(result.meta.count).toBe(2);
    expect(calls).toBe(2);
  });

  it("throws upstream after retry budget exhausted on 5xx", async () => {
    let calls = 0;
    mswServer.use(
      http.get(`${BASE_URL}/islands`, () => {
        calls += 1;
        return new HttpResponse("oops", { status: 502 });
      }),
    );
    const client = new FortniteClient({ baseUrl: BASE_URL, timeoutMs: 5000, sleep: vi.fn(async () => {}) });
    const err = await client.get("/islands").catch((e) => e);
    expect(err.kind).toBe("upstream");
    expect(err.status).toBe(502);
    expect(calls).toBe(3);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm test client`
Expected: FAIL on new retry tests (existing 7 still pass).

- [ ] **Step 3: Update `src/client.ts` with retry logic**

Replace the full file:

```ts
import { ApiError, type ApiErrorKind } from "./errors.js";

export interface FortniteClientOptions {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxRetries?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export type QueryValue = string | number | boolean | string[] | undefined | null;
export type QueryParams = Record<string, QueryValue>;

interface UpstreamErrorBody {
  errorCode?: string;
  errorMessage?: string;
  uuid?: string;
}

const DEFAULT_MAX_RETRIES = 2;
const BACKOFF_SCHEDULE_MS = [500, 2000];
const RETRY_AFTER_MAX_MS = 10_000;

const RETRYABLE_5XX = new Set([500, 502, 503, 504]);

function buildUrl(baseUrl: string, path: string, params?: QueryParams): string {
  const url = new URL(baseUrl.replace(/\/$/, "") + path);
  if (!params) return url.toString();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function statusToKind(status: number): ApiErrorKind {
  if (status === 400) return "invalid_params";
  if (status === 404) return "not_found";
  return "upstream";
}

async function parseErrorBody(res: Response): Promise<UpstreamErrorBody> {
  const text = await res.text();
  try {
    return JSON.parse(text) as UpstreamErrorBody;
  } catch {
    return { errorMessage: text || `HTTP ${res.status}` };
  }
}

function parseRetryAfterMs(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const dateMs = Date.parse(headerValue);
  if (!Number.isNaN(dateMs)) {
    const diff = dateMs - Date.now();
    return diff > 0 ? diff : 0;
  }
  return undefined;
}

function scheduledDelayMs(attempt: number): number {
  const base = BACKOFF_SCHEDULE_MS[attempt] ?? BACKOFF_SCHEDULE_MS[BACKOFF_SCHEDULE_MS.length - 1]!;
  const jitter = base * 0.25 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class FortniteClient {
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: FortniteClientOptions) {
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  async get<T>(path: string, params?: QueryParams): Promise<T> {
    const url = buildUrl(this.opts.baseUrl, path, params);
    let attempt = 0;
    while (true) {
      const res = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });

      if (res.ok) {
        return (await res.json()) as T;
      }

      if (res.status === 429) {
        const retryAfterMs = parseRetryAfterMs(res.headers.get("Retry-After"));
        if (retryAfterMs !== undefined && retryAfterMs > RETRY_AFTER_MAX_MS) {
          await res.body?.cancel();
          throw new ApiError({
            kind: "rate_limited",
            message: `Upstream is rate-limiting. Retry after ~${Math.round(retryAfterMs / 1000)}s.`,
            status: 429,
            retryAfterMs,
          });
        }
        if (attempt < this.maxRetries) {
          const delay = retryAfterMs ?? scheduledDelayMs(attempt);
          await res.body?.cancel();
          await this.sleep(delay);
          attempt += 1;
          continue;
        }
        await res.body?.cancel();
        throw new ApiError({
          kind: "rate_limited",
          message: "Upstream is rate-limiting and retries are exhausted.",
          status: 429,
          retryAfterMs,
        });
      }

      if (RETRYABLE_5XX.has(res.status) && attempt < this.maxRetries) {
        await res.body?.cancel();
        await this.sleep(scheduledDelayMs(attempt));
        attempt += 1;
        continue;
      }

      const body = await parseErrorBody(res);
      throw new ApiError({
        kind: statusToKind(res.status),
        message: body.errorMessage ?? `HTTP ${res.status}`,
        status: res.status,
        uuid: body.uuid,
      });
    }
  }
}
```

- [ ] **Step 4: Run tests, verify all client tests pass**

Run: `pnpm test client`
Expected: PASS, 13 tests (7 from Task 5 + 6 new).

- [ ] **Step 5: Commit**

```bash
git add src/client.ts test/client.test.ts
git commit -m "Add 429/5xx retry with Retry-After honoring and backoff schedule"
```

---

## Task 7: FortniteClient — timeout + network error

**Files:**
- Modify: `test/client.test.ts`

The implementation already handles these via `AbortSignal.timeout` and `fetch` throwing. We add tests to lock the behavior in.

- [ ] **Step 1: Add failing tests**

Append to `test/client.test.ts`:

```ts
describe("FortniteClient.get — timeout and network errors", () => {
  it("throws timeout when AbortSignal fires", async () => {
    mswServer.use(
      http.get(`${BASE_URL}/islands`, async () => {
        await new Promise((r) => setTimeout(r, 200));
        return HttpResponse.json(islandsList);
      }),
    );
    const client = new FortniteClient({ baseUrl: BASE_URL, timeoutMs: 50 });
    const err = await client.get("/islands").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe("timeout");
  });

  it("throws network for non-HTTP failures", async () => {
    mswServer.use(
      http.get(`${BASE_URL}/islands`, () => HttpResponse.error()),
    );
    const client = new FortniteClient({ baseUrl: BASE_URL, timeoutMs: 5000 });
    const err = await client.get("/islands").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe("network");
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm test client`
Expected: FAIL — `fetch` errors currently bubble up as raw `TypeError`/`AbortError`, not `ApiError`.

- [ ] **Step 3: Wrap `fetch` in `client.ts` to normalize**

Replace the body of the `while (true)` loop's `fetch` call. Change:

```ts
    const url = buildUrl(this.opts.baseUrl, path, params);
    let attempt = 0;
    while (true) {
      const res = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
```

To:

```ts
    const url = buildUrl(this.opts.baseUrl, path, params);
    let attempt = 0;
    while (true) {
      let res: Response;
      try {
        res = await fetch(url, {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(this.opts.timeoutMs),
        });
      } catch (err) {
        if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
          throw new ApiError({ kind: "timeout", message: `Request timed out after ${this.opts.timeoutMs}ms` });
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new ApiError({ kind: "network", message: msg });
      }
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `pnpm test client`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add src/client.ts test/client.test.ts
git commit -m "Normalize fetch timeout/network errors to ApiError"
```

---

## Task 8: zod schemas (`src/schemas.ts`)

**Files:**
- Create: `src/schemas.ts`
- (No dedicated test file — schemas are exercised by tool tests in Tasks 9–11)

- [ ] **Step 1: Create `src/schemas.ts`**

```ts
import { z } from "zod";

export const METRIC_NAMES = [
  "peakCCU",
  "favorites",
  "minutesPlayed",
  "averageMinutesPerPlayer",
  "recommendations",
  "plays",
  "uniquePlayers",
  "retention",
] as const;

export type MetricName = (typeof METRIC_NAMES)[number];

export const INTERVALS = ["day", "hour", "minute"] as const;
export type Interval = (typeof INTERVALS)[number];

export const listIslandsInput = z
  .object({
    size: z.number().int().min(1).max(1000).optional(),
    after: z.string().min(1).optional(),
    before: z.string().min(1).optional(),
  })
  .refine((v) => !(v.after && v.before), {
    message: "'after' and 'before' are mutually exclusive",
    path: ["before"],
  });

export const getIslandInput = z.object({
  code: z.string().min(1),
});

export const getIslandMetricsInput = z.object({
  code: z.string().min(1),
  interval: z.enum(INTERVALS).optional(),
  metrics: z.array(z.enum(METRIC_NAMES)).min(1).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

export type ListIslandsInput = z.infer<typeof listIslandsInput>;
export type GetIslandInput = z.infer<typeof getIslandInput>;
export type GetIslandMetricsInput = z.infer<typeof getIslandMetricsInput>;
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/schemas.ts
git commit -m "Add zod schemas for the three tool inputs"
```

---

## Task 9: `list_islands` tool (`src/tools/listIslands.ts`)

**Files:**
- Create: `src/tools/listIslands.ts`
- Create: `test/tools/listIslands.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/tools/listIslands.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { listIslands } from "../../src/tools/listIslands.js";
import { FortniteClient } from "../../src/client.js";
import { mswServer } from "../setup.js";
import { http, HttpResponse, BASE_URL } from "../helpers/msw.js";
import islandsList from "../fixtures/islands-list.json" with { type: "json" };

function makeClient(): FortniteClient {
  return new FortniteClient({ baseUrl: BASE_URL, timeoutMs: 5000 });
}

describe("listIslands tool", () => {
  it("calls /islands with default size and reshapes the response", async () => {
    let captured: URL | undefined;
    mswServer.use(
      http.get(`${BASE_URL}/islands`, ({ request }) => {
        captured = new URL(request.url);
        return HttpResponse.json(islandsList);
      }),
    );
    const result = await listIslands(makeClient(), {});
    expect(captured?.searchParams.has("size")).toBe(false);
    expect(result.count).toBe(2);
    expect(result.nextCursor).toBe("MTc1NC0wNTIyLTQ2ODU=");
    expect(result.prevCursor).toBeNull();
    expect(result.islands).toHaveLength(2);
    expect(result.islands[0]).toMatchObject({
      code: "6742-1441-9726",
      title: "UNC PARKOUR TRICSHOT EASY",
      cursor: "Njc0Mi0xNDQxLTk3MjY=",
    });
    expect((result.islands[0] as { meta?: unknown }).meta).toBeUndefined();
  });

  it("forwards size, after, before to the upstream call", async () => {
    let captured: URL | undefined;
    mswServer.use(
      http.get(`${BASE_URL}/islands`, ({ request }) => {
        captured = new URL(request.url);
        return HttpResponse.json(islandsList);
      }),
    );
    await listIslands(makeClient(), { size: 50, after: "abc" });
    expect(captured?.searchParams.get("size")).toBe("50");
    expect(captured?.searchParams.get("after")).toBe("abc");
  });

  it("rejects when both after and before are supplied", async () => {
    await expect(
      listIslands(makeClient(), { after: "a", before: "b" }),
    ).rejects.toMatchObject({ kind: "invalid_params" });
  });

  it("rejects when size is out of range", async () => {
    await expect(listIslands(makeClient(), { size: 0 })).rejects.toMatchObject({
      kind: "invalid_params",
    });
    await expect(listIslands(makeClient(), { size: 1001 })).rejects.toMatchObject({
      kind: "invalid_params",
    });
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm test listIslands`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/tools/listIslands.ts`**

```ts
import { ApiError } from "../errors.js";
import type { FortniteClient } from "../client.js";
import { listIslandsInput } from "../schemas.js";

interface UpstreamIsland {
  code: string;
  creatorCode?: string;
  displayName?: string;
  title: string;
  category?: string;
  createdIn?: string;
  tags: string[];
  meta: { page: { cursor: string } };
}

interface UpstreamResponse {
  data: UpstreamIsland[];
  links: { prev: string | null; next: string | null };
  meta: {
    count: number;
    page: { prevCursor: string | null; nextCursor: string | null };
  };
}

export interface IslandSummary {
  code: string;
  creatorCode?: string;
  displayName?: string;
  title: string;
  category?: string;
  createdIn?: string;
  tags: string[];
  cursor: string;
}

export interface ListIslandsResult {
  islands: IslandSummary[];
  count: number;
  nextCursor: string | null;
  prevCursor: string | null;
}

export async function listIslands(
  client: FortniteClient,
  rawInput: unknown,
): Promise<ListIslandsResult> {
  const parsed = listIslandsInput.safeParse(rawInput);
  if (!parsed.success) {
    throw new ApiError({
      kind: "invalid_params",
      message: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
    });
  }
  const { size, after, before } = parsed.data;
  const res = await client.get<UpstreamResponse>("/islands", { size, after, before });

  return {
    islands: res.data.map(({ meta, ...rest }) => ({
      code: rest.code,
      creatorCode: rest.creatorCode,
      displayName: rest.displayName,
      title: rest.title,
      category: rest.category,
      createdIn: rest.createdIn,
      tags: rest.tags,
      cursor: meta.page.cursor,
    })),
    count: res.meta.count,
    nextCursor: res.meta.page.nextCursor,
    prevCursor: res.meta.page.prevCursor,
  };
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `pnpm test listIslands`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/tools/listIslands.ts test/tools/listIslands.test.ts
git commit -m "Add list_islands tool with cursor hoisting"
```

---

## Task 10: `get_island` tool (`src/tools/getIsland.ts`)

**Files:**
- Create: `src/tools/getIsland.ts`
- Create: `test/tools/getIsland.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/tools/getIsland.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { getIsland } from "../../src/tools/getIsland.js";
import { FortniteClient } from "../../src/client.js";
import { mswServer } from "../setup.js";
import { http, HttpResponse, BASE_URL } from "../helpers/msw.js";
import battleRoyale from "../fixtures/island-battle-royale.json" with { type: "json" };
import notFound from "../fixtures/island-not-found.json" with { type: "json" };

function makeClient(): FortniteClient {
  return new FortniteClient({ baseUrl: BASE_URL, timeoutMs: 5000 });
}

describe("getIsland tool", () => {
  it("passes through the displayName lookup", async () => {
    mswServer.use(
      http.get(`${BASE_URL}/islands/battle-royale`, () => HttpResponse.json(battleRoyale)),
    );
    const result = await getIsland(makeClient(), { code: "battle-royale" });
    expect(result).toEqual(battleRoyale);
  });

  it("passes through the island code lookup", async () => {
    mswServer.use(
      http.get(`${BASE_URL}/islands/6742-1441-9726`, () =>
        HttpResponse.json({ code: "6742-1441-9726", title: "x", tags: [], createdIn: "UEFN" }),
      ),
    );
    const result = await getIsland(makeClient(), { code: "6742-1441-9726" });
    expect(result.code).toBe("6742-1441-9726");
  });

  it("surfaces 404 as ApiError(not_found)", async () => {
    mswServer.use(
      http.get(`${BASE_URL}/islands/missing`, () =>
        HttpResponse.json(notFound, { status: 404 }),
      ),
    );
    await expect(getIsland(makeClient(), { code: "missing" })).rejects.toMatchObject({
      kind: "not_found",
      uuid: notFound.uuid,
    });
  });

  it("rejects empty code", async () => {
    await expect(getIsland(makeClient(), { code: "" })).rejects.toMatchObject({
      kind: "invalid_params",
    });
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm test getIsland`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/tools/getIsland.ts`**

```ts
import { ApiError } from "../errors.js";
import type { FortniteClient } from "../client.js";
import { getIslandInput } from "../schemas.js";

export interface IslandMetadata {
  code: string;
  creatorCode?: string;
  displayName?: string;
  title: string;
  category?: string;
  createdIn?: string;
  tags: string[];
}

export async function getIsland(
  client: FortniteClient,
  rawInput: unknown,
): Promise<IslandMetadata> {
  const parsed = getIslandInput.safeParse(rawInput);
  if (!parsed.success) {
    throw new ApiError({
      kind: "invalid_params",
      message: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
    });
  }
  return client.get<IslandMetadata>(`/islands/${encodeURIComponent(parsed.data.code)}`);
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `pnpm test getIsland`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/tools/getIsland.ts test/tools/getIsland.test.ts
git commit -m "Add get_island tool with pass-through metadata"
```

---

## Task 11: `get_island_metrics` tool (`src/tools/getIslandMetrics.ts`)

**Files:**
- Create: `src/tools/getIslandMetrics.ts`
- Create: `test/tools/getIslandMetrics.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/tools/getIslandMetrics.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { getIslandMetrics } from "../../src/tools/getIslandMetrics.js";
import { FortniteClient } from "../../src/client.js";
import { mswServer } from "../setup.js";
import { http, HttpResponse, BASE_URL } from "../helpers/msw.js";
import metricsFixture from "../fixtures/metrics-day-filtered.json" with { type: "json" };

function makeClient(): FortniteClient {
  return new FortniteClient({ baseUrl: BASE_URL, timeoutMs: 5000 });
}

describe("getIslandMetrics tool", () => {
  it("defaults interval to day and forwards all params", async () => {
    let captured: URL | undefined;
    mswServer.use(
      http.get(`${BASE_URL}/islands/abc/metrics/day`, ({ request }) => {
        captured = new URL(request.url);
        return HttpResponse.json(metricsFixture);
      }),
    );
    const result = await getIslandMetrics(makeClient(), { code: "abc" });
    expect(captured?.searchParams.getAll("metrics")).toEqual([]);
    expect(result).toEqual(metricsFixture);
  });

  it("forwards interval, metrics, from, to", async () => {
    let captured: URL | undefined;
    mswServer.use(
      http.get(`${BASE_URL}/islands/abc/metrics/hour`, ({ request }) => {
        captured = new URL(request.url);
        return HttpResponse.json({});
      }),
    );
    await getIslandMetrics(makeClient(), {
      code: "abc",
      interval: "hour",
      metrics: ["peakCCU", "uniquePlayers"],
      from: "2026-05-17T00:00:00.000Z",
      to: "2026-05-18T00:00:00.000Z",
    });
    expect(captured?.searchParams.getAll("metrics")).toEqual(["peakCCU", "uniquePlayers"]);
    expect(captured?.searchParams.get("from")).toBe("2026-05-17T00:00:00.000Z");
    expect(captured?.searchParams.get("to")).toBe("2026-05-18T00:00:00.000Z");
  });

  it("rejects empty metrics array", async () => {
    await expect(
      getIslandMetrics(makeClient(), { code: "abc", metrics: [] }),
    ).rejects.toMatchObject({ kind: "invalid_params" });
  });

  it("rejects invalid metric names", async () => {
    await expect(
      getIslandMetrics(makeClient(), {
        code: "abc",
        metrics: ["bogus"] as unknown as string[],
      }),
    ).rejects.toMatchObject({ kind: "invalid_params" });
  });

  it("rejects invalid interval", async () => {
    await expect(
      getIslandMetrics(makeClient(), { code: "abc", interval: "year" as unknown as "day" }),
    ).rejects.toMatchObject({ kind: "invalid_params" });
  });

  it("rejects non-ISO from/to", async () => {
    await expect(
      getIslandMetrics(makeClient(), { code: "abc", from: "yesterday" }),
    ).rejects.toMatchObject({ kind: "invalid_params" });
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm test getIslandMetrics`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/tools/getIslandMetrics.ts`**

```ts
import { ApiError } from "../errors.js";
import type { FortniteClient } from "../client.js";
import { getIslandMetricsInput, type Interval, type MetricName } from "../schemas.js";

export interface MetricBucket {
  value: number | null;
  timestamp: string;
}

export interface RetentionBucket {
  d1: number | null;
  d7: number | null;
  timestamp: string;
}

export interface IslandMetricsResponse {
  averageMinutesPerPlayer?: MetricBucket[];
  peakCCU?: MetricBucket[];
  favorites?: MetricBucket[];
  minutesPlayed?: MetricBucket[];
  recommendations?: MetricBucket[];
  plays?: MetricBucket[];
  uniquePlayers?: MetricBucket[];
  retention?: RetentionBucket[];
}

export async function getIslandMetrics(
  client: FortniteClient,
  rawInput: unknown,
): Promise<IslandMetricsResponse> {
  const parsed = getIslandMetricsInput.safeParse(rawInput);
  if (!parsed.success) {
    throw new ApiError({
      kind: "invalid_params",
      message: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
    });
  }
  const { code, interval, metrics, from, to } = parsed.data;
  const intervalSegment: Interval = interval ?? "day";
  return client.get<IslandMetricsResponse>(
    `/islands/${encodeURIComponent(code)}/metrics/${intervalSegment}`,
    {
      metrics: metrics as MetricName[] | undefined,
      from,
      to,
    },
  );
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `pnpm test getIslandMetrics`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/tools/getIslandMetrics.ts test/tools/getIslandMetrics.test.ts
git commit -m "Add get_island_metrics tool covering all metric/interval paths"
```

---

## Task 12: MCP server wiring (`src/server.ts`)

**Files:**
- Modify: `src/server.ts` (currently stub)
- Create: `test/server.test.ts`

The server registers the three tools, routes calls through their handlers, and converts `ApiError` into MCP `isError: true` responses with the `[kind] message (uuid: …)` text format from Task 2.

- [ ] **Step 1: Write failing tests**

Create `test/server.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.js";
import { mswServer } from "./setup.js";
import { http, HttpResponse, BASE_URL } from "./helpers/msw.js";
import islandsList from "./fixtures/islands-list.json" with { type: "json" };
import battleRoyale from "./fixtures/island-battle-royale.json" with { type: "json" };
import notFound from "./fixtures/island-not-found.json" with { type: "json" };

async function makeConnectedClient() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer({ baseUrl: BASE_URL, timeoutMs: 5000 });
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return { client, server };
}

describe("MCP server", () => {
  it("lists the three semantic tools", async () => {
    const { client } = await makeConnectedClient();
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(["get_island", "get_island_metrics", "list_islands"]);
  });

  it("routes list_islands and returns parsed JSON content", async () => {
    mswServer.use(http.get(`${BASE_URL}/islands`, () => HttpResponse.json(islandsList)));
    const { client } = await makeConnectedClient();
    const result = await client.callTool({ name: "list_islands", arguments: {} });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    const payload = JSON.parse(text);
    expect(payload.count).toBe(2);
    expect(payload.nextCursor).toBe("MTc1NC0wNTIyLTQ2ODU=");
  });

  it("routes get_island for displayName", async () => {
    mswServer.use(
      http.get(`${BASE_URL}/islands/battle-royale`, () => HttpResponse.json(battleRoyale)),
    );
    const { client } = await makeConnectedClient();
    const result = await client.callTool({
      name: "get_island",
      arguments: { code: "battle-royale" },
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0]!.text,
    );
    expect(payload.displayName).toBe("battle-royale");
  });

  it("surfaces ApiError as isError with [kind] prefix and uuid suffix", async () => {
    mswServer.use(
      http.get(`${BASE_URL}/islands/missing`, () =>
        HttpResponse.json(notFound, { status: 404 }),
      ),
    );
    const { client } = await makeConnectedClient();
    const result = await client.callTool({
      name: "get_island",
      arguments: { code: "missing" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text.startsWith("[not_found] ")).toBe(true);
    expect(text.includes(`(uuid: ${notFound.uuid})`)).toBe(true);
  });

  it("returns invalid_params for malformed args", async () => {
    const { client } = await makeConnectedClient();
    const result = await client.callTool({
      name: "list_islands",
      arguments: { size: 9999 },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text.startsWith("[invalid_params] ")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm test server`
Expected: FAIL — `buildServer` not exported from stub `src/server.ts`.

- [ ] **Step 3: Implement `src/server.ts`**

Replace `src/server.ts` entirely:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadConfig } from "./config.js";
import { FortniteClient } from "./client.js";
import { ApiError, formatToText } from "./errors.js";
import { listIslands } from "./tools/listIslands.js";
import { getIsland } from "./tools/getIsland.js";
import { getIslandMetrics } from "./tools/getIslandMetrics.js";
import { INTERVALS, METRIC_NAMES } from "./schemas.js";

const LIST_ISLANDS_DESC =
  "List public, discoverable Fortnite islands sorted newest-release-first. " +
  "Cursor-paginated; pass `after` (or `before`) from a previous response to get the next/prev page. " +
  "`size` defaults to 100 (max 1000).";

const GET_ISLAND_DESC =
  "Fetch metadata for one Fortnite island. " +
  "`code` accepts either an island code (e.g. '1234-1234-1234') or a displayName alias " +
  "(e.g. 'battle-royale'). Returns 404 via [not_found] error when the code does not exist.";

const GET_ISLAND_METRICS_DESC = [
  "Engagement metrics for one Fortnite island.",
  "Constraints to surface to users:",
  "- Historical data is limited to the last 7 days.",
  "- Buckets with fewer than 5 unique players return value: null.",
  "- `retention` is populated only when interval=day.",
  "- `averageMinutesPerPlayer` is populated only when interval is 'day' or 'hour'.",
  "- Some Epic first-party games return 0 for `favorites` and `recommendations`.",
  "- `code` accepts either an island code or a displayName.",
].join("\n");

type Args = Record<string, unknown> | undefined;

async function wrap<T>(handler: () => Promise<T>) {
  try {
    const result = await handler();
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  } catch (err) {
    if (err instanceof ApiError) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: formatToText(err) }],
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: "text" as const, text: `[upstream] ${message}` }],
    };
  }
}

export interface BuildServerOptions {
  baseUrl: string;
  timeoutMs: number;
}

export function buildServer(opts: BuildServerOptions): McpServer {
  const client = new FortniteClient({ baseUrl: opts.baseUrl, timeoutMs: opts.timeoutMs });
  const server = new McpServer({ name: "fortnite-data-api-mcp", version: "0.1.0" });

  server.registerTool(
    "list_islands",
    {
      description: LIST_ISLANDS_DESC,
      inputSchema: {
        size: z.number().int().min(1).max(1000).optional(),
        after: z.string().optional(),
        before: z.string().optional(),
      },
    },
    (args: Args) => wrap(() => listIslands(client, args ?? {})),
  );

  server.registerTool(
    "get_island",
    {
      description: GET_ISLAND_DESC,
      inputSchema: {
        code: z.string().min(1),
      },
    },
    (args: Args) => wrap(() => getIsland(client, args ?? {})),
  );

  server.registerTool(
    "get_island_metrics",
    {
      description: GET_ISLAND_METRICS_DESC,
      inputSchema: {
        code: z.string().min(1),
        interval: z.enum(INTERVALS).optional(),
        metrics: z.array(z.enum(METRIC_NAMES)).min(1).optional(),
        from: z.string().optional(),
        to: z.string().optional(),
      },
    },
    (args: Args) => wrap(() => getIslandMetrics(client, args ?? {})),
  );

  return server;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const server = buildServer({ baseUrl: cfg.baseUrl, timeoutMs: cfg.timeoutMs });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const isEntryPoint = import.meta.url === `file://${process.argv[1]}`;
if (isEntryPoint) {
  main().catch((err) => {
    console.error("[fortnite-data-api-mcp] fatal:", err);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `pnpm test server`
Expected: PASS, 5 tests.

- [ ] **Step 5: Run the full suite**

Run: `pnpm test`
Expected: PASS, all suites (errors 4, config 5, client 15, listIslands 4, getIsland 4, getIslandMetrics 6, server 5 → 43 total).

- [ ] **Step 6: Commit**

```bash
git add src/server.ts test/server.test.ts
git commit -m "Wire MCP server with the three tools and error surfacing"
```

---

## Task 13: README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace `README.md` entirely**

```markdown
# fortnite-data-api-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for the public **Fortnite Data API** — exposes Fortnite Islands metadata and engagement metrics (peak CCU, favorites, retention, etc.) to MCP-aware clients like Claude Desktop and Claude Code.

**No authentication required.** The upstream API at `https://api.fortnite.com/ecosystem/v1` is public, despite a stray `securityScheme` in its OpenAPI document.

## Install

Run directly without installing:

```sh
npx fortnite-data-api-mcp
```

Or install globally:

```sh
npm install -g fortnite-data-api-mcp
```

## Configure your MCP client

### Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS)

```json
{
  "mcpServers": {
    "fortnite-data-api": {
      "command": "npx",
      "args": ["-y", "fortnite-data-api-mcp"]
    }
  }
}
```

### Claude Code (`.mcp.json` in your project)

```json
{
  "mcpServers": {
    "fortnite-data-api": {
      "command": "npx",
      "args": ["-y", "fortnite-data-api-mcp"]
    }
  }
}
```

## Tools

### `list_islands`

List public Fortnite islands, newest-release-first. Cursor-paginated.

| Field | Type | Notes |
| --- | --- | --- |
| `size` | `number` (1–1000, default 100) | page size |
| `after` | `string` | cursor; mutually exclusive with `before` |
| `before` | `string` | cursor; mutually exclusive with `after` |

### `get_island`

Fetch metadata for one island.

| Field | Type | Notes |
| --- | --- | --- |
| `code` | `string` (required) | island code (e.g. `1234-1234-1234`) or displayName alias (e.g. `battle-royale`) |

### `get_island_metrics`

Engagement metrics for one island. Covers aggregate, interval-bucketed, and per-metric upstream paths.

| Field | Type | Notes |
| --- | --- | --- |
| `code` | `string` (required) | island code or displayName |
| `interval` | `"day" \| "hour" \| "minute"` (default `"day"`) | bucket size |
| `metrics` | array of metric names | subset filter; defaults to all 8 |
| `from` | ISO 8601 string | inclusive start; default depends on interval |
| `to` | ISO 8601 string | exclusive end |

Metric names: `peakCCU`, `favorites`, `minutesPlayed`, `averageMinutesPerPlayer`, `recommendations`, `plays`, `uniquePlayers`, `retention`.

**Upstream constraints to remember:**
- Historical data is limited to **7 days**.
- A bucket with fewer than 5 unique players returns `value: null`.
- `retention` populated only when `interval=day`.
- `averageMinutesPerPlayer` populated only when `interval ∈ {day, hour}`.
- Epic first-party games return `0` for `favorites` / `recommendations`.

## Configuration

All env vars are optional.

| Env var | Default | Purpose |
| --- | --- | --- |
| `FORTNITE_API_BASE_URL` | `https://api.fortnite.com/ecosystem/v1` | override base URL |
| `FORTNITE_API_TIMEOUT_MS` | `15000` | per-request timeout |
| `FORTNITE_API_LOG_LEVEL` | `info` | `silent` \| `error` \| `info` \| `debug` (stderr only) |

## Development

```sh
pnpm install
pnpm test          # vitest
pnpm typecheck
pnpm lint
pnpm build         # produces dist/server.js
```

## License

MIT
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "Add README with install, MCP client config, and tool docs"
```

---

## Task 14: GitHub Actions CI

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create the workflow file**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [20, 22]
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm build
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "Add CI workflow (lint + typecheck + test + build on node 20/22)"
```

---

## Task 15: Build smoke test

**Files:**
- (none — verification only)

- [ ] **Step 1: Run the full pipeline locally**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
Expected: all four pass, `dist/server.js` produced with shebang.

- [ ] **Step 2: Smoke-check the produced binary**

Run:

```sh
node -e "console.log(require('node:fs').readFileSync('dist/server.js','utf8').slice(0,40))"
```

Expected: output begins with `#!/usr/bin/env node`.

- [ ] **Step 3: List-tools handshake against the built binary**

This sends a real MCP `initialize` + `tools/list` over stdio to the built server and verifies the three tools are advertised.

Run:

```sh
node - <<'JS'
import { spawn } from "node:child_process";
const child = spawn("node", ["dist/server.js"], { stdio: ["pipe", "pipe", "inherit"] });
function send(obj) { child.stdin.write(JSON.stringify(obj) + "\n"); }
let buf = "";
child.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  for (const line of buf.split("\n")) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id === 1) {
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      } else if (msg.id === 2) {
        const names = msg.result.tools.map((t) => t.name).sort();
        console.log("tools:", names.join(", "));
        if (names.join(",") !== "get_island,get_island_metrics,list_islands") {
          console.error("UNEXPECTED");
          process.exit(2);
        }
        child.kill();
        process.exit(0);
      }
    } catch {}
  }
  buf = buf.endsWith("\n") ? "" : buf.slice(buf.lastIndexOf("\n") + 1);
});
send({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } },
});
JS
```

Expected: prints `tools: get_island, get_island_metrics, list_islands` and exits 0.

- [ ] **Step 4: Final commit (only if any changes were made during smoke testing)**

If no files changed, skip. Otherwise:

```bash
git add -u
git commit -m "Fix issues found during smoke test"
```

---

## Self-Review Notes (filled in during plan authoring)

**Spec coverage check:** Each spec section maps to at least one task.

| Spec section | Task(s) |
| --- | --- |
| §2 upstream facts | Reflected in fixtures (Task 4) and tool descriptions (Task 12) |
| §3.1 architecture (3 layers) | Tasks 3, 5–7 (client), 8–11 (tools), 12 (server) |
| §3.2 repository layout | Task 1 (configs), Tasks 2–14 (each file) |
| §3.3 tech stack | Task 1 (deps) |
| §3.4 `.gitignore` | Already merged via PR #1 |
| §4.1 `list_islands` contract + reshape | Task 9 |
| §4.2 `get_island` contract | Task 10 |
| §4.3 `get_island_metrics` contract + constraint docs | Tasks 11, 12 (description string) |
| §5 config | Task 3 |
| §6 data flow | Tasks 5–7 (client), 12 (server.wrap) |
| §7 retry + ApiError + MCP surface | Tasks 2, 6, 7, 12 |
| §8 testing matrix | Tasks 2, 3, 5–12 (each layer's tests) |
| §9 distribution (bin, README, CI) | Tasks 1, 13, 14 |

**Placeholder scan:** None — every step contains complete code or exact commands.

**Type consistency:** `IslandSummary` (from `listIslands.ts`) and `IslandMetadata` (from `getIsland.ts`) intentionally diverge — `IslandSummary` includes `cursor`, `IslandMetadata` does not. Metric union (`MetricName`) and interval union (`Interval`) are imported from `schemas.ts` in both `getIslandMetrics.ts` and `server.ts`. `ApiErrorKind` is consistent across `errors.ts`, `client.ts`, and the MCP surface.
