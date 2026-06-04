# Archive viewer (Cloudflare Worker + Vite)

A Cloudflare Worker that lets you **browse**, **search**, and **diff** the system-prompt archive in `../code` and `../web`.

Built with [`@cloudflare/vite-plugin`](https://developers.cloudflare.com/workers/vite-plugin/): `vite dev` runs the Worker in the real Workers runtime (workerd) with client HMR, and `vite build` produces the deployable Worker + assets. The whole archive (~260 `.txt` blocks) is bundled into the Worker at build time as a Vite virtual module, so there's no database or KV — search and diff run in-memory on the edge.

## Develop

```sh
cd worker
bun install
bun run dev        # vite — http://localhost:5173
```

## Deploy

```sh
bun run deploy     # vite build && wrangler deploy
```

`vite build` writes the bundle to `dist/` and a redirect so `wrangler deploy` picks up the built Worker automatically. You'll need a Cloudflare account (`bunx wrangler login` once).

Deploys to the custom domain **https://claude.l5z12.dev** (configured as a `custom_domain` route in `wrangler.jsonc`). This requires the `l5z12.dev` zone on the same Cloudflare account — `wrangler deploy` then provisions the DNS record and certificate automatically.

## Layout

| Path | What |
| --- | --- |
| `vite.config.mjs` | Wires `archive()` + `cloudflare()` plugins. |
| `archive-plugin.mjs` | Two Vite plugins. `archive()` bundles prompt blocks (`../code` + `../web` `*.txt`, excluding `web/skills/`) as `virtual:archive`. `skills()` bundles skill *metadata* (name/description + file manifest) as `virtual:skills`, and serves the raw skill files as static assets at `/skills/<source>/<name>/<path>` (emitted at build, proxied from disk in dev) — so file contents aren't bundled into the Worker. Re-run dev/build to pick up changes. |
| `src/index.js` | The Worker — JSON API; everything else falls through to static assets. |
| `index.html`, `src/client/*` | The vanilla-JS front-end (Vite client root). |
| `wrangler.jsonc` | Worker name, ASSETS binding, and the `claude.l5z12.dev` custom-domain route. The plugin injects the assets directory — don't set `assets.directory`. |

## API

- `GET /api/tree` — light surface → model → block tree (no content).
- `GET /api/file?path=code/opus-4-8/03_harness.txt` — one block with content.
- `GET /api/search?q=memory&surface=code` — case-insensitive line search (`surface` optional).
- `GET /api/diff?left=<path>&right=<path>` — line diff (LCS) with `add`/`del` counts and per-line ops.
- `GET /raw?path=<path>` — a prompt block as `text/plain` (backs the Browse **Raw** button).
- `GET /api/skills` — skill list (`id`, `source`, `name`, `description`, `fileCount`).
- `GET /api/skill?id=public/docx` — one skill's metadata + file manifest (`path` + `size`). File contents come from the static assets below.
- `GET /skills/<source>/<name>/<path>` — raw skill file (static asset). The Skills tab is a GitHub-like file explorer that fetches these on demand and renders Markdown (via `marked`).
