# Changelog

## 0.1.0 (2026-10-28)

- First release: a forwarding client for the hosted eatmundo MCP server. All 6 captured tools are answered locally for tools/list, and every tools/call is forwarded upstream over a streamable-HTTP JSON-RPC session (initialize, notifications/initialized, tools/call, honouring the Mcp-Session-Id header when the upstream issues one).
- Tools: `find_similar_dishes`, `search_dishes`, `get_recipe`, `compare_dishes`, `weekly_menu`, `substitute_ingredient`. The capture carries `title` keys on every tool and they are served verbatim; `search_dishes` and `weekly_menu` carry no `required` key in the capture and none is served.
- Upstream results pass through verbatim, including the isError flag; upstream failures surface as `dishmatch error:` text results.
- One bin serves the CLI (one subcommand per tool, plus `--version`) and the stdio MCP server (`mcp` subcommand). The upstream endpoint can be overridden via `DISHMATCH_MCP_URL`. The upstream record declares no headers, so no auth header is ever sent.
