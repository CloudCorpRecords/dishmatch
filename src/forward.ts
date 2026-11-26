/**
 * dishmatch core: a forwarding client for the hosted
 * eatmundo MCP server.
 *
 * Nothing about the dish corpus is computed here.
 * tools/list is answered from the literal definitions
 * below, which reproduce a live capture of the upstream
 * server word for word (name, title, description and
 * inputSchema exactly as captured; the capture carries
 * title keys on every tool, and two tools --
 * search_dishes and weekly_menu -- carry no
 * `required` key, so none is served for them). A
 * tools/call travels upstream over a streamable-HTTP
 * JSON-RPC session: an initialize POST, a
 * notifications/initialized POST, then the tools/call
 * POST, carrying the Mcp-Session-Id response header on
 * later requests when the upstream issues one. The
 * session opens lazily on the first forwarded call and
 * is reused for the client's lifetime.
 *
 * The endpoint is pinned to
 * https://www.eatmundo.com/api/mcp and may be replaced
 * with the DISHMATCH_MCP_URL environment variable
 * (that override is a labelled reconstruction). The
 * registry record declares NO headers on the upstream
 * remote, so no auth header is ever sent, under any
 * environment.
 *
 * A successful upstream result is returned exactly as
 * received, isError flag and extra fields included.
 * Failures -- an upstream JSON-RPC error, a non-2xx
 * status, a body that cannot be parsed, or a fetch
 * that throws or times out -- become an isError result
 * whose text begins with `dishmatch error:` (that
 * rendering is a labelled reconstruction). Replies may
 * be plain JSON or SSE (`data:` lines); the JSON-RPC
 * message whose id matches the request wins.
 */
import type {
  FetchFn,
  FetchResponseLike,
  ForwardDeps,
  ToolArgs,
  ToolDef,
  ToolResult,
} from "./types.js";

export const VERSION = "0.1.0";

export const DEFAULT_ENDPOINT_URL = "https://www.eatmundo.com/api/mcp";

export const DEFAULT_TIMEOUT_MS = 30000;

export const PROTOCOL_VERSION = "2025-03-26";

/* ------------------------------------------------------------------ */
/* Tool definitions (tools/list literals, verbatim from the live       */
/* capture in harness/fixtures/eatmundo-tools.json; generated           */
/* programmatically by parsing and re-serialising the fixture JSON,     */
/* never retyped). All 6 captured tools are built.                      */
/* ------------------------------------------------------------------ */

export const TOOL_DEFS: ToolDef[] = [
  {
    "name": "find_similar_dishes",
    "title": "Find similar dishes",
    "description": "Find dishes from other cuisines that are equivalent to a given dish, from eatmundo's scored equivalence graph (over 10,000 edges across nearly 2,000 recipes from 26 countries). Every edge is evidence-based - shared canonical ingredients - not a language-model guess, and every edge crosses country lines. Use it for \"what is the Greek counterpart of lahmacun, and why\".",
    "inputSchema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "country": {
          "description": "Restrict matches to one cuisine, ISO 3166-1 alpha-2 (e.g. \"GR\"). 26 countries are covered.",
          "maxLength": 2,
          "minLength": 2,
          "type": "string"
        },
        "dish": {
          "description": "Dish to start from: an eatmundo slug (e.g. \"lahmacun\") or a plain name (\"rice pudding\"). Names are resolved through site search; check resolved_by in the result.",
          "minLength": 2,
          "type": "string"
        },
        "lang": {
          "default": "en",
          "description": "Language for titles, ingredient names and URLs.",
          "enum": [
            "en",
            "tr",
            "de",
            "fr",
            "es",
            "it",
            "el"
          ],
          "type": "string"
        },
        "limit": {
          "default": 5,
          "description": "How many matches to return, best score first. The default of 5 is enough to see whether a cuisine has one clear counterpart or several competing ones.",
          "maximum": 20,
          "minimum": 1,
          "type": "integer"
        },
        "min_score": {
          "default": 0,
          "description": "Minimum match score. Defaults to 0 on purpose: 320 dishes only have below-threshold nearest matches, and a default of 50 would silently return nothing for them.",
          "maximum": 100,
          "minimum": 0,
          "type": "integer"
        }
      },
      "required": [
        "dish"
      ],
      "type": "object"
    }
  },
  {
    "name": "search_dishes",
    "title": "Search dishes",
    "description": "Search nearly 2,000 dishes from 26 cuisines by text, country, category, preparation technique, or canonical ingredient. Every ingredient in the corpus is linked to a canonical entity, so an ingredient filter also catches translations and spelling variants. Use it to get a slug for the other tools.",
    "inputSchema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "category": {
          "description": "Dish type. DRINK covers both alcoholic and non-alcoholic; DESSERT is separate from FOOD, so a query for a sweet dish returns nothing under FOOD.",
          "enum": [
            "FOOD",
            "DESSERT",
            "DRINK"
          ],
          "type": "string"
        },
        "country": {
          "description": "ISO 3166-1 alpha-2 cuisine filter.",
          "maxLength": 2,
          "minLength": 2,
          "type": "string"
        },
        "form": {
          "description": "Preparation technique. One of: soup, stew, stir-fry, grill-roast, fritter, dumpling, stuffed-vegetable, flatbread-pastry, noodle, rice, cold-salad, dip-spread, pickle-ferment, egg, sandwich-wrap, porridge-mash, casserole-bake, cured-preserved, composed-plate, meat-salad, pancake-batter, marinated-cooked, syrup-pastry, fried-dough-sweet, cake, cookie, custard-pudding, sweet-pie-tart, fruit-dessert, frozen, confection, sweet-porridge, glutinous-dumpling, sweet-bread, layered-assembly, filled-pastry, sweet-pancake, starch-gel, hot-infusion, cold-cooler, juice, smoothie-shake, hot-milk-drink, fermented-drink, alcoholic-mixed, alcoholic-brew.",
          "type": "string"
        },
        "ingredients": {
          "description": "Canonical ingredient names (e.g. [\"tomato\",\"garlic\"]). A dish matches if it has ANY of them, but results are ranked by how many it has, then by how large a share of the dish's ingredient list they make up (matched / total ingredient lines - among equal matches, dishes with shorter lists come first). Unrecognised names are reported back, not ignored.",
          "items": {
            "type": "string"
          },
          "maxItems": 10,
          "type": "array"
        },
        "lang": {
          "default": "en",
          "description": "Language for titles, ingredient names and URLs.",
          "enum": [
            "en",
            "tr",
            "de",
            "fr",
            "es",
            "it",
            "el"
          ],
          "type": "string"
        },
        "limit": {
          "default": 10,
          "description": "Results per page (max 25).",
          "maximum": 25,
          "minimum": 1,
          "type": "integer"
        },
        "offset": {
          "default": 0,
          "description": "Rows to skip for paging. Pass back the `next_offset` from the previous response; it is null when there is no further page.",
          "maximum": 5000,
          "minimum": 0,
          "type": "integer"
        },
        "query": {
          "description": "Free text; needs at least 2 characters to take effect.",
          "type": "string"
        }
      },
      "type": "object"
    }
  },
  {
    "name": "get_recipe",
    "title": "Get recipe",
    "description": "Full recipe for one dish: steps, FAQ, image credit, and ingredients with PARSED quantities (amount, unit, and a normalised base in grams or millilitres where the quantity is measurable). Count-based lines like \"3 onions\" carry a gram estimate only where a per-item weight is known. Pass servings to rescale the ingredient quantities; the steps keep the original amounts. adaptations lists the diets (vegan, vegetarian, halal, dairy-free, pescatarian) the dish can be fully converted to, with each swap marked substitute (same dish) or adaptation (a different dish).",
    "inputSchema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "lang": {
          "default": "en",
          "description": "Language for titles, ingredient names and URLs.",
          "enum": [
            "en",
            "tr",
            "de",
            "fr",
            "es",
            "it",
            "el"
          ],
          "type": "string"
        },
        "servings": {
          "description": "Rescale ingredient quantities to this many servings. The dish's own count is returned as original_servings. Steps are NOT rescaled: they keep the amounts of the original recipe.",
          "maximum": 100,
          "minimum": 1,
          "type": "integer"
        },
        "slug": {
          "description": "Recipe slug in any of the 7 languages, or a dish name (resolved by search).",
          "minLength": 2,
          "type": "string"
        }
      },
      "required": [
        "slug"
      ],
      "type": "object"
    }
  },
  {
    "name": "compare_dishes",
    "title": "Compare two dishes",
    "description": "Compare two dishes ingredient by ingredient: shared items, what is unique to each, a match score, and - for the pairs that have one (nearly 900) - an editorial comparison paragraph in the requested language. Works for any two dishes in the corpus, whether or not they are an edge in the equivalence graph.",
    "inputSchema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "a": {
          "description": "First dish: slug or name.",
          "minLength": 2,
          "type": "string"
        },
        "b": {
          "description": "Second dish: slug or name.",
          "minLength": 2,
          "type": "string"
        },
        "lang": {
          "default": "en",
          "description": "Language for titles, ingredient names and URLs.",
          "enum": [
            "en",
            "tr",
            "de",
            "fr",
            "es",
            "it",
            "el"
          ],
          "type": "string"
        }
      },
      "required": [
        "a",
        "b"
      ],
      "type": "object"
    }
  },
  {
    "name": "weekly_menu",
    "title": "Build a weekly menu",
    "description": "Build a menu of up to 7 dinners, either one cuisine per day (\"world\") or all from one country. Honours diet exclusions (pork, beef, meat, fish, dairy, egg, alcohol), vegetarian/vegan/pescatarian requirements, a prep-time ceiling and a budget mode that reuses ingredients. When a constraint cannot be met it is relaxed and the relaxation is reported, never hidden.",
    "inputSchema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "budget": {
          "default": false,
          "description": "Favour weeks that reuse ingredients across days.",
          "type": "boolean"
        },
        "country": {
          "description": "Required when mode is \"single\".",
          "maxLength": 2,
          "minLength": 2,
          "type": "string"
        },
        "days": {
          "default": 7,
          "description": "How many days to plan, 1-7.",
          "maximum": 7,
          "minimum": 1,
          "type": "integer"
        },
        "exclude": {
          "description": "Ingredient attributes to avoid entirely: pork, beef, meat, fish, dairy, egg, alcohol.",
          "items": {
            "enum": [
              "pork",
              "beef",
              "meat",
              "fish",
              "dairy",
              "egg",
              "alcohol"
            ],
            "type": "string"
          },
          "type": "array"
        },
        "exclude_countries": {
          "description": "Cuisines to keep out of the plan, ISO 3166-1 alpha-2. Only meaningful when mode is \"world\"; excluding too many leaves the generator with too few cuisines to fill the week.",
          "items": {
            "maxLength": 2,
            "minLength": 2,
            "type": "string"
          },
          "maxItems": 30,
          "type": "array"
        },
        "include_extras": {
          "default": true,
          "description": "Add 2 desserts and 2 drinks (never alcoholic).",
          "type": "boolean"
        },
        "lang": {
          "default": "en",
          "description": "Language for titles, ingredient names and URLs.",
          "enum": [
            "en",
            "tr",
            "de",
            "fr",
            "es",
            "it",
            "el"
          ],
          "type": "string"
        },
        "mode": {
          "default": "world",
          "description": "\"world\" = a different cuisine each day; \"single\" = one country.",
          "enum": [
            "world",
            "single"
          ],
          "type": "string"
        },
        "require": {
          "description": "Diet every dish must satisfy. This is a WHITELIST and differs from `exclude`, which only removes single ingredient attributes: \"vegan\" is not the same as excluding meat.",
          "enum": [
            "vegetarian",
            "vegan",
            "pescatarian"
          ],
          "type": "string"
        },
        "seed": {
          "description": "Same seed + same options = same menu.",
          "maximum": 9007199254740991,
          "minimum": 1,
          "type": "integer"
        },
        "time_limit": {
          "description": "Max prep time in minutes; closed set (30/45/60). The generator relaxes it automatically if too few cuisines qualify, and reports that in relaxations.",
          "maximum": 9007199254740991,
          "minimum": -9007199254740991,
          "type": "integer"
        }
      },
      "type": "object"
    }
  },
  {
    "name": "substitute_ingredient",
    "title": "Find an ingredient substitute",
    "description": "Find what can replace a single ingredient, optionally under a dietary constraint (vegan, vegetarian, halal, dairy-free, pescatarian). Each result is marked \"substitute\" (same dish) or \"adaptation\" (result is a meaningfully different dish) - most swaps forced by a diet exclusion are adaptations, and the tool says so rather than overselling a swap as if the dish stayed the same. Precomputed and model-verified, not generated on the fly.",
    "inputSchema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "context": {
          "description": "Dietary constraint the substitute must satisfy. Omit for the single best general substitute with no diet filter. Other constraints (gluten-free, allergen-free) are not supported - the corpus has no gluten/allergen data, so the tool would have to guess, and it does not.",
          "enum": [
            "vegan",
            "vegetarian",
            "halal",
            "dairy-free",
            "pescatarian"
          ],
          "type": "string"
        },
        "ingredient": {
          "description": "Ingredient name in any of the 7 site languages, or its English canonical form (e.g. \"pork belly\", \"domuz göbeği\", \"Schweinebauch\").",
          "minLength": 1,
          "type": "string"
        },
        "lang": {
          "default": "en",
          "description": "Language for titles, ingredient names and URLs.",
          "enum": [
            "en",
            "tr",
            "de",
            "fr",
            "es",
            "it",
            "el"
          ],
          "type": "string"
        },
        "limit": {
          "default": 3,
          "description": "Max substitutes to return, best first.",
          "maximum": 5,
          "minimum": 1,
          "type": "integer"
        }
      },
      "required": [
        "ingredient"
      ],
      "type": "object"
    }
  }
];
export const TOOL_NAMES = TOOL_DEFS.map((t) => t.name);

/** Whether `name` belongs to the captured built surface. */
export function isKnownTool(name: string): boolean {
  return TOOL_NAMES.includes(name);
}

/* ------------------------------------------------------------------ */
/* Forwarding client                                                   */
/* ------------------------------------------------------------------ */

function errorResult(detail: string): ToolResult {
  return {
    content: [{ type: "text", text: `dishmatch error: ${detail}` }],
    isError: true,
  };
}

function rpcErrorMessage(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message !== "") return message;
    return JSON.stringify(error);
  }
  return String(error);
}

/**
 * Read a JSON-RPC response body, tolerating SSE framing.
 * Returns the message whose id matches `expectedId` when
 * present, otherwise the last parseable message, otherwise
 * null when nothing in the body parses.
 */
export function parseRpcBody(
  text: string,
  expectedId?: number,
): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const candidates: Record<string, unknown>[] = [];
  const tryPush = (payload: string): void => {
    try {
      const parsed: unknown = JSON.parse(payload);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        candidates.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Not a JSON payload; skip this candidate.
    }
  };
  if (trimmed.includes("data:")) {
    for (const line of trimmed.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice("data:".length).trim();
      if (payload !== "" && payload !== "[DONE]") tryPush(payload);
    }
  } else {
    tryPush(trimmed);
  }
  if (candidates.length === 0) return null;
  if (expectedId !== undefined) {
    const match = candidates.find((c) => c.id === expectedId);
    if (match !== undefined) return match;
  }
  return candidates[candidates.length - 1];
}

async function defaultFetch(
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
): Promise<FetchResponseLike> {
  return fetch(url, init) as unknown as FetchResponseLike;
}

/**
 * A forwarding client holding a single upstream session,
 * opened lazily on first use and reused from then on
 * (for the process lifetime in the MCP server, or for a
 * single invocation in the CLI).
 */
export class DishmatchClient {
  private readonly deps: ForwardDeps;
  private sessionId: string | null = null;
  private ready = false;
  private sessionPromise: Promise<void> | null = null;
  private idCounter = 0;

  constructor(deps: ForwardDeps = {}) {
    this.deps = deps;
  }

  private fetchFn(): FetchFn {
    return this.deps.fetchFn ?? defaultFetch;
  }

  private endpointUrl(): string {
    if (this.deps.url && this.deps.url.trim() !== "") return this.deps.url.trim();
    const raw = (this.deps.env ?? process.env).DISHMATCH_MCP_URL;
    if (raw && raw.trim() !== "") return raw.trim();
    return DEFAULT_ENDPOINT_URL;
  }

  private timeoutMs(): number {
    if (typeof this.deps.timeoutMs === "number" && this.deps.timeoutMs > 0) {
      return this.deps.timeoutMs;
    }
    return DEFAULT_TIMEOUT_MS;
  }

  private nextId(): number {
    this.idCounter += 1;
    return this.idCounter;
  }

  private async post(
    body: unknown,
    withSession: boolean,
  ): Promise<FetchResponseLike> {
    // The registry record declares NO headers on the upstream
    // remote: no Authorization header is ever sent.
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (withSession && this.sessionId !== null) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs());
    try {
      return await this.fetchFn()(this.endpointUrl(), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async ensureSession(): Promise<void> {
    if (this.ready) return;
    if (this.sessionPromise === null) {
      this.sessionPromise = (async () => {
        const initId = this.nextId();
        const initRes = await this.post(
          {
            jsonrpc: "2.0",
            id: initId,
            method: "initialize",
            params: {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: "dishmatch", version: VERSION },
            },
          },
          false,
        );
        const sessionId = initRes.headers.get("mcp-session-id");
        if (sessionId) this.sessionId = sessionId;
        const initText = await initRes.text();
        const initParsed = parseRpcBody(initText, initId);
        if (initParsed !== null && initParsed.error) {
          throw new Error(rpcErrorMessage(initParsed.error));
        }
        if (initRes.status < 200 || initRes.status >= 300) {
          throw new Error(`HTTP ${initRes.status}`);
        }
        if (initParsed === null && initText.trim() !== "") {
          throw new Error("malformed response");
        }
        const initializedRes = await this.post(
          { jsonrpc: "2.0", method: "notifications/initialized" },
          true,
        );
        try {
          await initializedRes.text();
        } catch {
          // Nothing needed from the notification response body.
        }
        this.ready = true;
      })();
    }
    try {
      await this.sessionPromise;
    } catch (err) {
      this.sessionPromise = null;
      this.sessionId = null;
      throw err;
    }
  }

  /** Forward one tool call; upstream failures come back as isError results. */
  async callTool(name: string, args: ToolArgs): Promise<ToolResult> {
    try {
      await this.ensureSession();
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }

    const callId = this.nextId();
    let callRes: FetchResponseLike;
    try {
      callRes = await this.post(
        {
          jsonrpc: "2.0",
          id: callId,
          method: "tools/call",
          params: { name, arguments: args ?? {} },
        },
        true,
      );
    } catch (err) {
      return errorResult(
        `request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const parsed = parseRpcBody(await callRes.text(), callId);
    if (parsed !== null && parsed.error) {
      return errorResult(rpcErrorMessage(parsed.error));
    }
    if (callRes.status < 200 || callRes.status >= 300) {
      return errorResult(`HTTP ${callRes.status}`);
    }
    if (parsed === null) return errorResult("malformed response");
    const result = parsed.result as ToolResult | undefined;
    if (result === undefined || result === null || typeof result !== "object") {
      return errorResult("malformed response");
    }
    // Hand the upstream result back exactly as received.
    return result;
  }
}

/** Build a forwarding client; tests inject a fake fetch and env through deps. */
export function createClient(deps: ForwardDeps = {}): DishmatchClient {
  return new DishmatchClient(deps);
}

/** One-shot helper: a fresh client for a single call (the CLI path). */
export async function callTool(
  name: string,
  args: ToolArgs,
  deps: ForwardDeps = {},
): Promise<ToolResult> {
  return new DishmatchClient(deps).callTool(name, args);
}
