# claude-system-prompt

System prompts from Anthropic's Claude products, split into one file per logical block for easy diffing across models and surfaces.

> [!IMPORTANT]
> Unofficial, community-maintained archive. These prompts were captured and reconstructed from observed Claude sessions; they may be incomplete, paraphrased, out of date, or differ from what Anthropic actually ships, and they vary by model, surface, and over time. Treat them as a reference, not a source of truth. Not affiliated with, endorsed by, or supported by Anthropic. "Claude" and related names are trademarks of their respective owners. Provided "as is", without warranty of any kind, for research and educational purposes.

## Layout

```
code/   Claude Code CLI system prompts
  opus-4-6/
  opus-4-7/
  opus-4-8/
  opus-4-8[1m]/   (1M-context variant of opus-4-8)

web/    claude.ai (web / desktop / mobile chat) system prompts
  haiku-4-5/
  opus-4-6/
  opus-4-7/
  opus-4-8/
  sonnet-4-6/
  more-context/   (shared tools / skills / session layer — not a model)
  skills/         (Agent Skill bundles — examples/ and public/, each a SKILL.md + assets)
```

Each model folder contains numbered `.txt` files in the order the blocks appear in the system prompt. Filenames name the block (e.g. `03_harness.txt`, `09_memory_system.txt`). Concatenating the files in order reconstructs the prompt.

## Viewer

`worker/` is a Cloudflare Worker (Vite + `@cloudflare/vite-plugin`) that lets you browse, search, and diff the prompt blocks and browse the `web/skills/` bundles — all content is bundled into the Worker at build time. Live at **https://claude.l5z12.dev**. From `worker/`: `bun install`, then `bun run dev` to preview locally or `bun run deploy` to ship it. See `worker/README.md`.

## Notes

- `code/` and `web/` use different block splits because the two surfaces have different prompts — don't expect file `05_*` to mean the same thing across them.
- Within a surface, block names are kept consistent across model versions where possible, so `diff code/opus-4-7/03_harness.txt code/opus-4-8/03_harness.txt` shows how that section evolved.
- Environment blocks (`code/*/10_environment.txt`, etc.) contain the runtime context as captured at the time of extraction (working directory, OS, model ID) — those will differ even for the same model on a different machine.
- `web/more-context/` is not a model folder. It holds the shared, largely model-independent layer of the claude.ai prompt that's injected at runtime rather than written into any single model's persona: the available-skills catalog (`01`), callable tool definitions (`02`), network and filesystem config (`03`–`04`), search / image-search / citation instructions (`05`–`07`), the Anthropic-API-in-artifacts guide (`08`), session context (`09`), and the end-conversation note (`10`). It's captured once instead of duplicated under each web model, so the session-specific bits in `09_session_context.txt` (location, date, connected MCP servers) reflect that single capture.
- `web/skills/` is not part of the numbered prompt-block archive — it holds Anthropic's Agent Skill bundles (`examples/` and `public/`), each a folder with a `SKILL.md` (name + description frontmatter), `LICENSE.txt`, templates/assets, and a packaged `<name>.skill` zip. The viewer surfaces these in a separate **Skills** tab and excludes them from the prompt Browse/Search/Diff.
- `code/opus-4-8[1m]/` is the 1M-context variant of opus-4-8. The genuine `[1m]`-specific differences from `code/opus-4-8/` are two lines: the model line in `09_environment.txt` (`Opus 4.8 (1M context)` / `claude-opus-4-8[1m]`) and the git co-author line in `14_tool_bash.txt` (`Claude Opus 4.8 (1M context)`). `12_injected_runtime_context.txt` also differs, but only by capture date — not a model difference. `diff -r code/opus-4-8 'code/opus-4-8[1m]'` shows exactly those three blocks.
