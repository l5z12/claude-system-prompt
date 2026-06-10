# web/fable-5

System prompt of **Claude Fable 5** (claude.ai web/mobile chat), captured from a live session on **June 10, 2026**. Layout follows the repo's convention: numbered `.txt` blocks; concatenating in order reconstructs the prompt body. Built to slot into github.com/l5z12/claude-system-prompt as `web/fable-5/`.

## Model identity (from block 01)
Claude Fable 5 is the first model in the **Claude 5 family**, in a new **Mythos-class** tier above Opus. Fable 5 and Mythos 5 share the same underlying model; Fable 5 is the generally available variant with additional dual-use safety measures, Mythos 5 is restricted to approved organizations. Knowledge cutoff: **end of January 2026** (vs Sonnet 4.6's August 2025).

## Structural notes
- Blocks 01–12 are wrapped in a `<claude_behavior>` XML tag in the actual prompt (flattened here per repo convention).
- Block 03 (child safety) sits inside the refusal_handling block in the live prompt.
- Blocks 24–28 are inside/after the `<computer_use>` wrapper.
- Citation instructions, anthropic_api_in_artifacts, available_skills, and network/filesystem config match `web/more-context/` and are not duplicated; session-specific values are summarized in `32_session_context.txt`.

## Deltas vs web/sonnet-4-6 (excluding dates)

**New/changed model & product info (01):** Fable 5 / Mythos 5 family replaces the Sonnet 4.6 description; "Claude Mythos Preview / Project Glasswing" paragraph is gone; adds Claude Cowork as a named product and mobile remote access for Code/Cowork.

**Refusal handling (02/04):** Sonnet's long weapons paragraph ("This applies to conventional weapons as much as CBRN… cumulative output…") is replaced by a shorter weapons rule plus two additions: a "say less when the conversation feels risky" principle and a rule declining illicit-drug dosage/administration guidance (while keeping life-saving info). Adds: respect a user's wish to end the conversation.

**Responding to mistakes (10):** Adds end_conversation guidance ("single warning before ending") — though no end_conversation tool was present in this session's tool list.

**Knowledge cutoff (12):** Jan 2026 instead of Aug 2025.

**Sections present here but absent from the sonnet-4-6 capture:**
- 24 package_management + examples (computer-use sub-blocks)
- 25 artifact_usage_criteria (haiku-4-5 has a version; sonnet-4-6 capture lacks it)
- 26 request_evaluation_checklist (visual-output routing)
- 27 when_to_use_visualizer_for_inline_visuals
- 28 visualizer_examples

**Sections with materially different wording (full live text included here):**
- 29 search_instructions — adds the UNRECOGNIZED ENTITY RULE, different call-scaling (3–5/5–10, 20+ → Research vs repo's 3–8/8–20, 30+), full 4-part copyright block with self-check and examples, full harmful-content list, and a critical_reminders block absent from the repo capture.
- 30 image_search — adds a 5-example worked-examples block, more detailed content-safety sub-bullets, and the multi-item interleaving rule with named-product exception.

All blocks verified verbatim against the live session except where noted; blocks 14–23 are byte-identical to the sonnet-4-6 capture and were copied from it after verification.
