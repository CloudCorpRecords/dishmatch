# dishmatch

What is the Greek counterpart of lahmacun, and why? dishmatch is a local forwarding client for the hosted eatmundo MCP service: it answers `tools/list` locally from the captured tool definitions and forwards every call to the service, returning the answers exactly as the service sends them back.

All six tools are read-only queries over a published dish corpus spanning 26 cuisines and nearly 2,000 recipes: an evidence-based equivalence graph, full recipes with parsed quantities, side-by-side comparisons, weekly menu planning, and ingredient substitutes. There is no write, signup, or send tool in this surface.

## The tools

- **`find_similar_dishes`** — Dishes from other cuisines equivalent to a given `dish`, from the scored equivalence graph (over 10,000 edges). Optional `country`, `lang`, `limit` and `min_score`. `dish` is required.
- **`search_dishes`** — Search dishes by `query` text, `country`, `category`, `form` (preparation technique), or canonical `ingredients`; `limit` and `offset` page the results. No parameters are required.
- **`get_recipe`** — Full recipe for one dish: steps, FAQ, image credit, and ingredients with parsed quantities; `servings` rescales the quantities. `slug` is required.
- **`compare_dishes`** — Two dishes compared ingredient by ingredient: shared items, what is unique to each, a match score, and an editorial paragraph where one exists. `a` and `b` are required.
- **`weekly_menu`** — A menu of up to 7 dinners, one cuisine per day (`world`) or all from one country (`single`), honouring diet exclusions, requirements, a prep-time ceiling and a budget mode. No parameters are required.
- **`substitute_ingredient`** — What can replace an `ingredient`, optionally under a dietary `context`; each result is marked substitute (same dish) or adaptation (a different dish). `ingredient` is required.

## Install and run

As an MCP server via npm:

```bash
npx -y @reneturcios/dishmatch mcp
```

MCP client configuration:

```json
{
  "mcpServers": {
    "dishmatch": {
      "command": "npx",
      "args": ["-y", "@reneturcios/dishmatch", "mcp"]
    }
  }
}
```

As a container:

```bash
docker run -i ghcr.io/cloudcorprecords/dishmatch
docker run --rm ghcr.io/cloudcorprecords/dishmatch search_dishes '{"query":"rice pudding"}'
```

## CLI

One binary serves both the command line and the MCP server. Each tool is a subcommand taking a single JSON string with that tool's arguments:

```bash
dishmatch find_similar_dishes '{"dish":"lahmacun"}'
dishmatch search_dishes '{"query":"rice pudding","limit":10}'
dishmatch get_recipe '{"slug":"lahmacun"}'
dishmatch compare_dishes '{"a":"lahmacun","b":"pizza"}'
dishmatch weekly_menu '{"mode":"world","days":5}'
dishmatch substitute_ingredient '{"ingredient":"pork belly"}'
dishmatch --version
```

Exit codes: `0` when the forwarded call succeeds, `1` when the upstream result is an error, and `2` for usage problems such as an unknown subcommand or a malformed JSON argument.

## Configuration

- `DISHMATCH_MCP_URL` — Overrides the upstream endpoint. The default is the pinned hosted endpoint, `https://www.eatmundo.com/api/mcp`. (The override variable is a reconstruction added by this rebuild.)

The upstream registry record declares no headers, so no authentication header is ever sent; the tool surface was captured keyless.

Upstream failures — a JSON-RPC error from the service, a non-2xx response, an unreadable body, or a request that fails outright — are reported to the caller as an error result whose text starts with `dishmatch error:`.

## How forwarding works

The first forwarded call opens a session: an `initialize` request (protocol version `2025-03-26`), followed by a `notifications/initialized` notification, then the `tools/call` itself. If the service answers the initialize request with an `Mcp-Session-Id` header, that value is carried on every later request, and the open session is reused for the rest of the process. Replies are accepted either as plain JSON or as server-sent events. Successful results pass through verbatim, including any `isError` flag and any extra fields the service includes.

## Development

```bash
npm install
npm run build   # tsc -> dist/ (dist/cli.js is the bin)
npm test        # tsx --test test/*.test.ts — stubbed upstream, no network
npm run dev     # run the CLI from source
```

The test suite checks the served tool list against the captured surface (all 6 tools, deep-equal, in order, with titles served verbatim and no `required` key added to the two tools that carry none), exercises the session handshake and its reuse, verifies that no `Authorization` or `X-API-Key` header is ever sent under any environment, and verifies that arguments go upstream untouched and results come back untouched.

## License

MIT — see `LICENSE`. Copyright (c) 2026 Rene Turcios.
