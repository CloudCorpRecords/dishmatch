import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  DishmatchClient,
  callTool,
  createClient,
  DEFAULT_ENDPOINT_URL,
  isKnownTool,
  parseRpcBody,
  PROTOCOL_VERSION,
  TOOL_DEFS,
  TOOL_NAMES,
  VERSION,
} from "../src/forward.js";
import { handleCallTool } from "../src/mcp.js";
import type {
  FetchFn,
  FetchResponseLike,
  ToolDef,
  ToolResult,
} from "../src/types.js";

const FIXTURE_URL = new URL(
  "../../../harness/fixtures/eatmundo-tools.json",
  import.meta.url,
);
const FIXTURE_AVAILABLE = existsSync(FIXTURE_URL);
const fixture = (
  FIXTURE_AVAILABLE
    ? JSON.parse(readFileSync(FIXTURE_URL, "utf-8"))
    : { tools: [] }
) as {
  tools: ToolDef[];
};
/**
 * Publish-survival guard (Wave 29 P1 preflight, proven Wave 24 pattern):
 * the parity fixture lives in the build harness, outside the published
 * repo tree, so fixture-dependent tests skip cleanly when it is absent;
 * with the fixture present they run in full, with no skips.
 */
function skipWithoutFixture(t: {
  skip: (message: string) => void;
}): boolean {
  if (FIXTURE_AVAILABLE) return false;
  t.skip("parity fixture lives in the build harness, not the repo tree");
  return true;
}


const PRIMARY = "find_similar_dishes";
const ALL_TOOLS = [
  "find_similar_dishes",
  "search_dishes",
  "get_recipe",
  "compare_dishes",
  "weekly_menu",
  "substitute_ingredient",
];
const NO_REQUIRED = ["search_dishes", "weekly_menu"];
const REQUIRED: Record<string, string[]> = {
  find_similar_dishes: ["dish"],
  get_recipe: ["slug"],
  compare_dishes: ["a", "b"],
  substitute_ingredient: ["ingredient"],
};

const SAMPLE_RESULT = {
  content: [
    {
      type: "text",
      text: "{\"slug\":\"lahmacun\",\"score\":42}",
    },
  ],
  structuredContent: { slug: "lahmacun", score: 42 },
};

const SAMPLE_ARGS = { dish: "lahmacun", limit: 5 };

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface FakeOptions {
  callResult?: Record<string, unknown>;
  callBodyText?: string;
  callError?: Record<string, unknown>;
  callStatus?: number;
  initError?: Record<string, unknown>;
  throwOn?: "initialize" | "tools/call";
  sessionId?: string | null;
  hangOnCall?: boolean;
  sse?: boolean;
}

function makeResponse(
  status: number,
  bodyText: string,
  headers: Record<string, string> = {},
): FetchResponseLike {
  const lowered = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lowered.get(name.toLowerCase()) ?? null },
    text: async () => bodyText,
  };
}

function jsonResponse(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  return makeResponse(status, JSON.stringify(payload), headers);
}

function makeUpstream(options: FakeOptions = {}): {
  fetchFn: FetchFn;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    calls.push({ url, headers: init?.headers ?? {}, body });
    const method = body.method as string;
    if (options.throwOn === method) throw new Error("socket hang up");
    if (method === "initialize") {
      if (options.initError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.initError,
        });
      }
      const headers: Record<string, string> = {};
      const sessionId =
        options.sessionId === undefined ? "sess-d1" : options.sessionId;
      if (sessionId !== null) headers["mcp-session-id"] = sessionId;
      return jsonResponse(
        200,
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            serverInfo: { name: "eatmundo", version: "0.1.0" },
          },
        },
        headers,
      );
    }
    if (method === "notifications/initialized") {
      return makeResponse(202, "");
    }
    if (method === "tools/call") {
      if (options.hangOnCall) {
        return new Promise<FetchResponseLike>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            if (signal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }
        });
      }
      if (options.callBodyText !== undefined) {
        return makeResponse(options.callStatus ?? 200, options.callBodyText);
      }
      if (options.callError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.callError,
        });
      }
      const result = options.callResult ?? SAMPLE_RESULT;
      const payload = { jsonrpc: "2.0", id: body.id, result };
      if (options.sse) {
        return makeResponse(
          200,
          `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
        );
      }
      return jsonResponse(options.callStatus ?? 200, payload);
    }
    return jsonResponse(200, {});
  };
  return { fetchFn, calls };
}

function stubClient(options: FakeOptions = {}, extra: Record<string, unknown> = {}) {
  const upstream = makeUpstream(options);
  const c = new DishmatchClient({
    fetchFn: upstream.fetchFn,
    env: {},
    ...extra,
  });
  return { client: c, calls: upstream.calls };
}

function textOf(result: ToolResult): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0].text;
}

function methods(calls: Captured[]): string[] {
  return calls.map((c) => c.body.method as string);
}

function schemaOf(tool: ToolDef): Record<string, any> {
  return tool.inputSchema as Record<string, any>;
}

function hasAuthHeader(call: Captured): boolean {
  return Object.keys(call.headers).some(
    (k) => k.toLowerCase() === "authorization",
  );
}

describe("registration integrity (captured surface)", () => {
  it("serves exactly the fixture's 6 tools, deep-equal, in order", (t) => {
    if (skipWithoutFixture(t)) return;
    assert.equal(fixture.tools.length, 6);
    assert.deepEqual(TOOL_DEFS, fixture.tools);
  });

  it("serves the 6 tool names in fixture order", () => {
    assert.deepEqual(TOOL_NAMES, ALL_TOOLS);
  });

  it("carries exactly the fixture's keys on every tool (title included)", () => {
    for (const tool of TOOL_DEFS) {
      assert.deepEqual(Object.keys(tool).sort(), [
        "description",
        "inputSchema",
        "name",
        "title",
      ]);
    }
  });

  it("carries the fixture's titles verbatim", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < TOOL_DEFS.length; i++) {
      assert.equal(TOOL_DEFS[i].title, fixture.tools[i].title);
    }
    assert.equal(TOOL_DEFS[0].title, "Find similar dishes");
    assert.equal(TOOL_DEFS[5].title, "Find an ingredient substitute");
  });

  it("carries the fixture's descriptions verbatim", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < TOOL_DEFS.length; i++) {
      assert.equal(TOOL_DEFS[i].description, fixture.tools[i].description);
    }
  });

  it("the two tools with NO required key carry none, exactly as captured", () => {
    for (const name of NO_REQUIRED) {
      const tool = TOOL_DEFS.find((t) => t.name === name)!;
      assert.equal("required" in schemaOf(tool), false, name);
    }
  });

  it("the other four tools carry exactly their captured required lists", () => {
    for (const [name, required] of Object.entries(REQUIRED)) {
      const tool = TOOL_DEFS.find((t) => t.name === name)!;
      assert.deepEqual(schemaOf(tool).required, required, name);
    }
  });

  it("carries the $schema marker on every inputSchema, exactly as captured", () => {
    for (const tool of TOOL_DEFS) {
      assert.equal(schemaOf(tool).type, "object");
      assert.equal(
        schemaOf(tool)["$schema"],
        "https://json-schema.org/draft/2020-12/schema",
      );
    }
  });

  it("carries no additionalProperties key anywhere, exactly as captured", () => {
    for (const tool of TOOL_DEFS) {
      assert.equal("additionalProperties" in schemaOf(tool), false, tool.name);
    }
  });

  it("carries every fixture property, in order, for every tool", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < TOOL_DEFS.length; i++) {
      assert.deepEqual(
        Object.keys(schemaOf(TOOL_DEFS[i]).properties),
        Object.keys(schemaOf(fixture.tools[i]).properties),
      );
    }
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[0]).properties), ["country", "dish", "lang", "limit", "min_score"]);
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[1]).properties), ["category", "country", "form", "ingredients", "lang", "limit", "offset", "query"]);
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[2]).properties), ["lang", "servings", "slug"]);
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[3]).properties), ["a", "b", "lang"]);
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[4]).properties), ["budget", "country", "days", "exclude", "exclude_countries", "include_extras", "lang", "mode", "require", "seed", "time_limit"]);
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[5]).properties), ["context", "ingredient", "lang", "limit"]);
  });

  it("carries the captured property constraints across the surface", () => {
    const find = schemaOf(TOOL_DEFS[0]).properties;
    assert.equal(find.dish.type, "string");
    assert.equal(find.dish.minLength, 2);
    assert.equal(find.limit.type, "integer");
    assert.equal(find.limit.minimum, 1);
    assert.equal(find.limit.maximum, 20);
    assert.equal(find.limit.default, 5);
    assert.equal(find.min_score.maximum, 100);
    assert.equal(find.min_score.default, 0);
    assert.equal(find.country.maxLength, 2);
    const search = schemaOf(TOOL_DEFS[1]).properties;
    assert.deepEqual(search.category.enum, ["FOOD", "DESSERT", "DRINK"]);
    assert.equal(search.limit.maximum, 25);
    assert.equal(search.ingredients.maxItems, 10);
    assert.equal(search.ingredients.items.type, "string");
    assert.equal(search.offset.maximum, 5000);
    const recipe = schemaOf(TOOL_DEFS[2]).properties;
    assert.equal(recipe.servings.maximum, 100);
    assert.equal(recipe.slug.minLength, 2);
    const compare = schemaOf(TOOL_DEFS[3]).properties;
    assert.equal(compare.a.minLength, 2);
    assert.equal(compare.b.minLength, 2);
    const menu = schemaOf(TOOL_DEFS[4]).properties;
    assert.equal(menu.days.maximum, 7);
    assert.equal(menu.days.default, 7);
    assert.equal(menu.mode.default, "world");
    assert.deepEqual(menu.mode.enum, ["world", "single"]);
    assert.equal(menu.seed.maximum, 9007199254740991);
    assert.equal(menu.time_limit.minimum, -9007199254740991);
    assert.equal(menu.exclude_countries.maxItems, 30);
    const sub = schemaOf(TOOL_DEFS[5]).properties;
    assert.equal(sub.limit.maximum, 5);
    assert.equal(sub.limit.default, 3);
    assert.equal(sub.ingredient.minLength, 1);
    assert.deepEqual(sub.context.enum, ["vegan", "vegetarian", "halal", "dairy-free", "pescatarian"]);
  });

  it("carries the captured lang enum and defaults across the surface", () => {
    for (const tool of TOOL_DEFS) {
      const lang = schemaOf(tool).properties.lang;
      assert.deepEqual(lang.enum, ["en", "tr", "de", "fr", "es", "it", "el"], tool.name);
      assert.equal(lang.default, "en", tool.name);
      assert.equal(
        lang.description,
        "Language for titles, ingredient names and URLs.",
        tool.name,
      );
    }
  });

  it("isKnownTool recognises all 6 built tools and rejects others", () => {
    for (const name of ALL_TOOLS) assert.equal(isKnownTool(name), true);
    assert.equal(isKnownTool("dish"), false);
    assert.equal(isKnownTool(""), false);
  });
});

describe("session establishment and reuse", () => {
  it("runs initialize, notifications/initialized, then tools/call in order", async () => {
    const { client: c, calls } = stubClient();
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(out.isError, undefined);
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    assert.ok(calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
    assert.equal(DEFAULT_ENDPOINT_URL, "https://www.eatmundo.com/api/mcp");
    for (const call of calls) {
      assert.equal(call.headers["Content-Type"], "application/json");
      assert.equal(call.headers["Accept"], "application/json, text/event-stream");
    }
    assert.equal(calls[0].headers["Mcp-Session-Id"], undefined);
    assert.equal(calls[1].headers["Mcp-Session-Id"], "sess-d1");
    assert.equal(calls[2].headers["Mcp-Session-Id"], "sess-d1");
  });

  it("sends clientInfo name dishmatch and the pinned protocol version on initialize", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(PRIMARY, SAMPLE_ARGS);
    const initParams = calls[0].body.params as Record<string, unknown>;
    assert.equal(initParams.protocolVersion, PROTOCOL_VERSION);
    assert.equal(PROTOCOL_VERSION, "2025-03-26");
    assert.deepEqual(initParams.capabilities, {});
    assert.deepEqual(initParams.clientInfo, { name: "dishmatch", version: VERSION });
  });

  it("establishes the session lazily once and reuses it on later calls", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(PRIMARY, SAMPLE_ARGS);
    await c.callTool("weekly_menu", {});
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
      "tools/call",
    ]);
    assert.equal(calls[3].headers["Mcp-Session-Id"], "sess-d1");
    assert.notEqual(calls[2].body.id, calls[3].body.id);
  });

  it("sends no session header when the upstream issues none", async () => {
    const { client: c, calls } = stubClient({ sessionId: null });
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(out.isError, undefined);
    assert.ok(calls.every((call) => call.headers["Mcp-Session-Id"] === undefined));
  });

  it("honours the DISHMATCH_MCP_URL env override", async () => {
    const upstream = makeUpstream();
    const c = new DishmatchClient({
      fetchFn: upstream.fetchFn,
      env: { DISHMATCH_MCP_URL: "https://staging.example.com/mcp" },
    });
    await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.ok(
      upstream.calls.every((call) => call.url === "https://staging.example.com/mcp"),
    );
  });

  it("honours an explicit url override over the default endpoint", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: {},
      url: "https://alt.example.com/mcp",
    });
    await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.ok(upstream.calls.every((call) => call.url === "https://alt.example.com/mcp"));
  });

  it("prefers an explicit url override over the env override", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: { DISHMATCH_MCP_URL: "https://env.example.com/mcp" },
      url: "https://explicit.example.com/mcp",
    });
    await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.ok(
      upstream.calls.every((call) => call.url === "https://explicit.example.com/mcp"),
    );
  });

  it("falls back to the pinned endpoint when the env override is blank", async () => {
    const upstream = makeUpstream();
    const c = new DishmatchClient({
      fetchFn: upstream.fetchFn,
      env: { DISHMATCH_MCP_URL: "   " },
    });
    await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.ok(upstream.calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
  });
});

describe("no Authorization header is ever sent (record declares no headers)", () => {
  it("sends no Authorization header with an empty environment", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((call) => !hasAuthHeader(call)));
    assert.ok(calls.every((call) => call.headers["Authorization"] === undefined));
  });

  it("sends no Authorization header even when key-like env vars are set", async () => {
    const upstream = makeUpstream();
    const c = new DishmatchClient({
      fetchFn: upstream.fetchFn,
      env: {
        DISHMATCH_API_KEY: "should-never-be-sent",
        API_KEY: "also-ignored",
        AUTHORIZATION: "Bearer planted",
      },
    });
    await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(upstream.calls.length, 3);
    assert.ok(upstream.calls.every((call) => !hasAuthHeader(call)));
  });

  it("never sends an X-API-Key header either", async () => {
    const upstream = makeUpstream();
    const c = new DishmatchClient({
      fetchFn: upstream.fetchFn,
      env: { DISHMATCH_API_KEY: "should-never-be-sent" },
    });
    await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.ok(upstream.calls.every((call) => call.headers["X-API-Key"] === undefined));
  });

  it("sends only Content-Type, Accept and (when issued) Mcp-Session-Id headers", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.deepEqual(Object.keys(calls[0].headers).sort(), ["Accept", "Content-Type"]);
    assert.deepEqual(Object.keys(calls[2].headers).sort(), [
      "Accept",
      "Content-Type",
      "Mcp-Session-Id",
    ]);
  });
});

describe("tools/call forwarding", () => {
  it("forwards a find_similar_dishes call verbatim", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(PRIMARY, SAMPLE_ARGS);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, PRIMARY);
    assert.deepEqual(params.arguments, SAMPLE_ARGS);
  });

  it("forwards every one of the 6 tools under its own name with its arguments untouched", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const cases: Array<[string, Record<string, unknown>]> = [
      ["find_similar_dishes", { dish: "lahmacun" }],
      ["search_dishes", { query: "rice pudding", limit: 10 }],
      ["get_recipe", { slug: "lahmacun" }],
      ["compare_dishes", { a: "lahmacun", b: "pizza" }],
      ["weekly_menu", { mode: "world", days: 5 }],
      ["substitute_ingredient", { ingredient: "pork belly" }],
    ];
    for (const [name, args] of cases) {
      await c.callTool(name, args);
    }
    const callParams = upstream.calls
      .filter((call) => call.body.method === "tools/call")
      .map((call) => call.body.params as Record<string, unknown>);
    assert.equal(callParams.length, 6);
    assert.deepEqual(
      callParams.map((p) => p.name),
      cases.map(([name]) => name),
    );
    for (let i = 0; i < cases.length; i++) {
      assert.deepEqual(callParams[i].arguments, cases[i][1], cases[i][0]);
    }
  });

  it("passes the upstream result through verbatim, including structuredContent and extra fields", async () => {
    const richResult = {
      content: [{ type: "text", text: "{\"slug\":\"lahmacun\",\"score\":42}" }],
      structuredContent: { slug: "lahmacun", score: 42 },
      extraField: "kept",
    };
    const { client: c } = stubClient({ callResult: richResult });
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.deepEqual(out, richResult);
  });

  it("passes the default upstream result through verbatim", async () => {
    const { client: c } = stubClient();
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("passes an upstream isError result through untouched", async () => {
    const upstreamResult = {
      content: [{ type: "text", text: "no matching dishes" }],
      isError: true,
    };
    const { client: c } = stubClient({ callResult: upstreamResult });
    const out = await c.callTool("get_recipe", { slug: "nobody" });
    assert.deepEqual(out, upstreamResult);
  });

  it("reads an SSE-framed tools/call response", async () => {
    const { client: c } = stubClient({ sse: true });
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(out.isError, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("the one-shot callTool helper forwards under the right tool name", async () => {
    const upstream = makeUpstream();
    const out = await callTool(
      "substitute_ingredient",
      { ingredient: "pork belly", limit: 3 },
      { fetchFn: upstream.fetchFn, env: {} },
    );
    assert.equal(out.isError, undefined);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "substitute_ingredient");
    assert.deepEqual(params.arguments, { ingredient: "pork belly", limit: 3 });
  });
});

describe("upstream failures surface as dishmatch error text", () => {
  it("maps a JSON-RPC error to `dishmatch error: <message>`", async () => {
    const { client: c } = stubClient({
      callError: { code: -32000, message: "dish lookup failed upstream" },
    });
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "dishmatch error: dish lookup failed upstream");
  });

  it("maps an initialize JSON-RPC error to dishmatch error text", async () => {
    const { client: c } = stubClient({
      initError: { code: -32600, message: "bad initialize" },
    });
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "dishmatch error: bad initialize");
  });

  it("maps an unparseable upstream response to a malformed-response error", async () => {
    const { client: c } = stubClient({ callBodyText: "<html>oops</html>" });
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "dishmatch error: malformed response");
  });

  it("maps a response with no result object to a malformed-response error", async () => {
    const { client: c } = stubClient({
      callBodyText: '{"jsonrpc":"2.0","id":3,"result":null}',
    });
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "dishmatch error: malformed response");
  });

  it("maps a non-2xx upstream status to dishmatch error text", async () => {
    const { client: c } = stubClient({ callBodyText: "internal error", callStatus: 500 });
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "dishmatch error: HTTP 500");
  });

  it("maps a throwing fetch to dishmatch error text", async () => {
    const { client: c } = stubClient({ throwOn: "tools/call" });
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^dishmatch error: /);
  });

  it("maps a throwing initialize fetch to dishmatch error text", async () => {
    const { client: c } = stubClient({ throwOn: "initialize" });
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "dishmatch error: socket hang up");
  });

  it("maps a timed-out call to dishmatch error text", async () => {
    const { client: c } = stubClient({ hangOnCall: true }, { timeoutMs: 20 });
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^dishmatch error: /);
  });
});

describe("parseRpcBody", () => {
  it("parses plain JSON and picks the message with the matching id", () => {
    const body = '{"jsonrpc":"2.0","id":7,"result":{"ok":true}}';
    assert.deepEqual(parseRpcBody(body, 7), {
      jsonrpc: "2.0",
      id: 7,
      result: { ok: true },
    });
  });

  it("parses SSE data lines", () => {
    const body =
      'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { ok: true },
    });
  });

  it("picks the matching id among several SSE messages", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":1,"result":{"n":1}}\n\n' +
      'data: {"jsonrpc":"2.0","id":2,"result":{"n":2}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { n: 2 },
    });
  });

  it("ignores the SSE [DONE] sentinel", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":4,"result":{"ok":true}}\ndata: [DONE]\n';
    assert.deepEqual(parseRpcBody(body, 4), {
      jsonrpc: "2.0",
      id: 4,
      result: { ok: true },
    });
  });

  it("returns null for empty and unparseable bodies", () => {
    assert.equal(parseRpcBody(""), null);
    assert.equal(parseRpcBody("not json at all"), null);
    assert.equal(parseRpcBody("[1,2,3]"), null);
  });
});

describe("MCP layer validation", () => {
  it("rejects an unknown tool with MethodNotFound before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, "not_a_tool", {}),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.MethodNotFound,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects array arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, PRIMARY, ["nope"]),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects string arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, PRIMARY, "dish=lahmacun"),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("forwards a valid find_similar_dishes call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, PRIMARY, SAMPLE_ARGS);
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, SAMPLE_ARGS);
  });

  it("treats omitted arguments as an empty object", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, "weekly_menu", undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, {});
  });
});

describe("CLI", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

  function runCli(args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
    });
  }

  it("--version prints 0.1.0 and exits 0", () => {
    const res = runCli(["--version"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
    assert.equal(res.stdout.trim(), VERSION);
  });

  it("-v prints 0.1.0 and exits 0", () => {
    const res = runCli(["-v"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
  });

  it("an unknown command prints usage on stderr and exits 2", () => {
    const res = runCli(["not-a-tool"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
    assert.match(res.stderr, /find_similar_dishes/);
    assert.match(res.stderr, /substitute_ingredient/);
  });

  it("a non-JSON argument exits 2", () => {
    const res = runCli([PRIMARY, "not json"]);
    assert.equal(res.status, 2);
  });

  it("a JSON array argument exits 2", () => {
    const res = runCli([PRIMARY, "[]"]);
    assert.equal(res.status, 2);
  });

  it("extra arguments after mcp exit 2", () => {
    const res = runCli(["mcp", "extra"]);
    assert.equal(res.status, 2);
  });

  it("a tool subcommand forwards to the upstream and prints the result", async () => {
    const server = createHttpServer((req, res) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        const body = JSON.parse(data || "{}") as Record<string, unknown>;
        if (body.method === "initialize") {
          res.writeHead(200, { "Content-Type": "application/json", "mcp-session-id": "sess-cli" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, serverInfo: { name: "eatmundo", version: "0.1.0" } } }));
        } else if (body.method === "notifications/initialized") {
          res.writeHead(202);
          res.end("");
        } else if (body.method === "tools/call") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: SAMPLE_RESULT }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as { port: number };
    try {
      const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", cliPath, "get_recipe", JSON.stringify({ slug: "lahmacun" })], {
          cwd: root,
          env: { ...process.env, DISHMATCH_MCP_URL: `http://127.0.0.1:${addr.port}/mcp` },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });
      assert.equal(out.code, 0, out.stderr);
      assert.match(out.stdout, /lahmacun/);
    } finally {
      server.close();
    }
  });

  it("exposes a working CLI subcommand for every one of the 6 tools", async () => {
    const seen: string[] = [];
    const server = createHttpServer((req, res) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        const body = JSON.parse(data || "{}") as Record<string, unknown>;
        if (body.method === "initialize") {
          res.writeHead(200, { "Content-Type": "application/json", "mcp-session-id": "sess-cli-all" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, serverInfo: { name: "eatmundo", version: "0.1.0" } } }));
        } else if (body.method === "notifications/initialized") {
          res.writeHead(202);
          res.end("");
        } else if (body.method === "tools/call") {
          const params = body.params as Record<string, unknown>;
          seen.push(params.name as string);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: SAMPLE_RESULT }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as { port: number };
    const cases: Array<[string, string]> = [
      ["find_similar_dishes", JSON.stringify({ dish: "lahmacun" })],
      ["search_dishes", JSON.stringify({ query: "rice pudding" })],
      ["get_recipe", JSON.stringify({ slug: "lahmacun" })],
      ["compare_dishes", JSON.stringify({ a: "lahmacun", b: "pizza" })],
      ["weekly_menu", "{}"],
      ["substitute_ingredient", JSON.stringify({ ingredient: "pork belly" })],
    ];
    try {
      for (const [tool, argsJson] of cases) {
        const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
          const child = spawn(process.execPath, ["--import", "tsx", cliPath, tool, argsJson], {
            cwd: root,
            env: { ...process.env, DISHMATCH_MCP_URL: `http://127.0.0.1:${addr.port}/mcp` },
          });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (d) => (stdout += d));
          child.stderr.on("data", (d) => (stderr += d));
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, stdout, stderr }));
        });
        assert.equal(out.code, 0, `${tool}: ${out.stderr}`);
        assert.match(out.stdout, /lahmacun/, tool);
      }
      assert.deepEqual(seen, ALL_TOOLS);
    } finally {
      server.close();
    }
  });
});
