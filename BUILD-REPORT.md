# BUILD REPORT — dishmatch

Clean-room rebuild of `com.eatmundo/dishes` v0.1.0 (remote-only
MCP server at `https://www.eatmundo.com/api/mcp`), built
2026-10-28 as a forwarding client. Package:
`@reneturcios/dishmatch` 0.1.0, registry name
`io.github.CloudCorpRecords/dishmatch`.

## Surface built

Full surface: **6 of 6 captured tools built**, none omitted.

| Tool | Required fields as served |
|------|---------------------------|
| `find_similar_dishes` | `dish` |
| `search_dishes` | NO `required` key in the capture — served verbatim, none invented |
| `get_recipe` | `slug` |
| `compare_dishes` | `a`, `b` |
| `weekly_menu` | NO `required` key in the capture — served verbatim, none invented |
| `substitute_ingredient` | `ingredient` |

Each served tool carries exactly the keys `name`, `title`,
`description`, `inputSchema`, exactly as captured: the capture
carries `title` keys on every tool and they are served verbatim.
The tool literals were generated programmatically from
`harness/fixtures/eatmundo-tools.json` by the script at
`/tmp/b50-dishmatch-scratch/gen.py` (parse + re-serialise; the
generator's round-trip assertions confirmed the emitted literals
parse back to the fixture's tool objects; generated literal
13815 chars, sha256
`7ca3dace5a0caf46b2ad1dfcef957383d3c3adb065f0ce2c6335bc63e2e6ecc8`)
— never retyped — and the registration-integrity test suite plus
the parity harness confirmed the served literals deep-equal the
fixture's 6 tool objects, in order. Tools are registered via the
MCP SDK low-level Server API (`ListToolsRequestSchema` /
`CallToolRequestSchema` handlers), not McpServer+zod.

## Fixture conflicts

**None.** The spec and the fixture agree on all 6 tools' names,
titles, descriptions, required fields (including the two tools
with no `required` key: `search_dishes` and `weekly_menu`) and
property shapes.

## Labelled reconstructions (from the spec's Wire section)

- Upstream endpoint pinned: `https://www.eatmundo.com/api/mcp`.
- Env override `DISHMATCH_MCP_URL` — labelled reconstruction.
- The registry record declares NO headers on the remote: no auth
  header is ever sent. Tests assert that no `Authorization`
  header is sent under any environment — including with key-like
  env vars (`DISHMATCH_API_KEY`, `API_KEY`, `AUTHORIZATION`) set —
  and that no `X-API-Key` header is ever sent; upstream requests
  carry only `Content-Type`, `Accept` and, when issued,
  `Mcp-Session-Id`.
- Error rendering `dishmatch error:` text for upstream failures —
  labelled reconstruction.
- Upstream results pass through verbatim, including
  `structuredContent`, `isError` and extra fields. tools/call is
  forwarded as streamable-HTTP JSON-RPC: initialize
  (protocolVersion `2025-03-26`) → notifications/initialized →
  tools/call, honouring `Mcp-Session-Id` when issued; plain-JSON
  and SSE replies are both parsed. The forwarding core takes an
  injectable fetch; tests stub the upstream — no live network
  calls in tests.

## Deviations

**Lockfile generation route (process deviation, recorded
honestly).** Both prescribed routes were attempted first:
(1) `npm install --package-lock-only --ignore-scripts --offline`
failed with ENOTCACHED (no cached packument for
`@modelcontextprotocol/sdk`); (2) the proxy fallback route
(`HTTPS_PROXY=http://hatch-egress-proxy:3128 npm install
--package-lock-only --ignore-scripts --registry
https://registry.npmjs.org`) died once with an npm
permissions-style error during a VM write-guard window (~163 s),
was then killed mid-run by a VM replacement (system boot
2026-10-28 19:53 UTC, /tmp wiped), and a further detached attempt
ran over 11 minutes without completing under fleet-wide proxy
load (no sibling build in the batch had landed a lockfile in that
window either; a single proxied packument fetch measured ~17 s).
The shipped lockfile was therefore derived from duescope's
npm-generated lockfile — duescope is a sibling rebuild whose
`package.json` carries a byte-identical dependency set (same
dependencies, devDependencies and engines) — changing only the
root package identity (`name` → `@reneturcios/dishmatch`, `bin`
→ `dishmatch`), by the script at
`/tmp/b50-dishmatch-scratch/make-lockfile.py`. The result was
then validated end-to-end: a clean `npm ci --offline` installed
101 packages from it with exit 0, and the full build, test suite
and parity run below all pass against it. No other deviations.

## Lockfile

- Parses as JSON; `name` == `@reneturcios/dishmatch`.
- Package entries: **128**.
- sha256: `ead6ce91d1a58030fd67565cdbbd4006370a7e80d7e8e1bdd9e982f910384c60`
  (re-verified unchanged after the subsequent offline `npm ci`).
- Route: see Deviations above — offline route attempted and
  failed (ENOTCACHED); proxy route attempted repeatedly and did
  not complete (write-guard error, VM replacement, proxy load);
  final lockfile derived from the sibling duescope lockfile for
  the identical dependency tree and validated by `npm ci`.

## server.json

- Description exactly: "Dish equivalence graph and recipes across 26 cuisines: search, compare, menus, substitutes." —
  **91 characters** (verified programmatically).
- npm package entry carries `"version": "0.1.0"`; the OCI entry
  (`ghcr.io/cloudcorprecords/dishmatch:0.1.0`) carries **no**
  `version` field. Both entries carry packageArguments
  `[{type: positional, value: mcp}]` and transport stdio.
  Dockerfile (node:20-alpine, both stages) carries the label
  `io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/dishmatch"`.
  Container workflow `IMAGE` is `ghcr.io/cloudcorprecords/dishmatch`
  and its smoke test asserts the server name `dishmatch`.

## Verification (all run 2026-10-28)

Build and test steps ran in a setsid-detached pipeline (the
in-session route was blocked by the VM write-guard window; see
Deviations), calling the direct `tsc`/`tsx` binaries; `npm test`
was additionally re-run in-session afterwards and passed
identically.

1. `tsc --noEmit` (direct binary) → exit 0.
2. Build (`tsc`) → exit 0; real `dist/` produced (cli, forward,
   index, mcp, types — .js, .d.ts, .js.map each).
3. `node dist/cli.js --version` → `0.1.0`.
4. `npm test` → **58 tests, 58 pass, 0 fail** (registration-integrity
   suite deep-equals the served tools/list against the fixture's 6
   tools, including title verbatim and required-key exactness
   assertions — search_dishes and weekly_menu have NO required
   key — plus session handling/reuse, env override, the
   no-Authorization / no-X-API-Key assertions under any
   environment, verbatim per-tool argument forwarding for all 6
   tools and result pass-through including structuredContent and
   upstream isError, SSE parsing, error rendering for both the
   JSON-RPC-error and transport-failure paths, MCP-layer
   validation, and CLI behaviour including a working subcommand
   for every one of the 6 tools against a local stub server).
5. Parity: `python3 /home/hatch/workspace/mcp-rebuild-100/harness/parity.py --original /home/hatch/workspace/mcp-rebuild-100/harness/fixtures/eatmundo-tools.json --rebuild "stdio:node /home/hatch/workspace/mcp-rebuild-100/builds/dishmatch/dist/cli.js mcp" --out /home/hatch/workspace/mcp-rebuild-100/builds/dishmatch/parity-out` → **verdict PASS, parity 100.0**
   (6/6 identical, 0 missing, 0 extra, no schema diffs). Output in
   `parity-out/`.
