# Contributing

Thanks for helping keep this archive accurate. Because everything here is captured and reconstructed from observed Claude sessions, the single most important thing a contribution can carry is **evidence that the content is real** — not paraphrased from memory, invented, or hallucinated.

## Every PR must cite the source conversation

Every PR that adds or changes prompt content **must link to the shared conversation it came from** so reviewers can verify the information is genuine.

- Use a public share link (e.g. a claude.ai share URL) or another durable, openable transcript. A screenshot alone is not enough — link the conversation so the surrounding context and the exact wording can be checked.
- Point to where in the conversation the content appears (which turn, which block) when it isn't obvious.
- If the content was reconstructed across **multiple** sessions, link all of them and say briefly how they were combined.
- If a verbatim share link genuinely can't be produced, say so explicitly in the PR and explain how else the content can be verified. Expect extra scrutiny — unverifiable content may be declined.

Put the link(s) in the PR description under a heading like `## Source conversation`.

## What reviewers check

- The linked conversation actually contains the added/changed text (verbatim, not summarized).
- The text lands in the right surface and model folder (`code/` vs `web/`, correct model version) and the right numbered block.
- Block splits and filenames follow the conventions in the [README](README.md) — concatenating a folder's files in order should still reconstruct the prompt.
- Captured runtime/environment details (working directory, OS, model ID, dates) are labeled as capture-specific and not presented as universal.

## A few conventions

- Keep content **verbatim**. Don't clean up wording, fix Anthropic's typos, or normalize formatting — fidelity to what was observed is the whole point.
- One logical block per file; keep block names consistent across model versions where possible so `diff` across versions stays meaningful.
- Note in the PR if a capture may be incomplete or paraphrased, so it can be flagged rather than trusted as exact.

This is an unofficial, community-maintained archive (see the disclaimer in the [README](README.md)). Contributions are accepted on the understanding that the content is offered for research and educational purposes.
