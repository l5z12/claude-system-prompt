# Extra sandbox binaries (2026-06-05)

Beyond `process_api` and the `/opt` `rclone-filestore`, the sandbox contains exactly three
more notable executables. A sweep for Anthropic's cargo/go registry
(`artifactory.infra.ant.dev`, `anthropics/anthropic/api-go`) across all PATH dirs found only
these (plus the two already documented).

## 1. rclone-filestore-rootfs  (Anthropic, Go)
The rclone baseline baked into the read-only rootfs at `/usr/local/bin/rclone-filestore`.
- go1.25.9, BuildID `3fe76ce4…`, 29,211,928 bytes.
- This is a *second, older* build coexisting with the per-turn `/opt` squashfs build
  (go1.25.10, `5c205e4a…`, 30,182,360 bytes). The size gap is mostly the expanded memory API:
  | build | `memory.api.v1` (stable) | `DeltaHunk` | `AADScheme` |
  |---|---|---|---|
  | rootfs `/usr/local/bin` | 0 | 0 | 32 |
  | squashfs `/opt` | 52 | 22 | 32 |
  Confirms doc 08: the squashfs pack carries an expanded memory API the rootfs lacks.

## 2. extract-text  (Anthropic, Rust)
`/usr/local/bin/extract-text` — BuildID `ffeeb697…`, built from the same Anthropic cargo
registry as `process_api`. A CLI that extracts plain text from **docx, odt, epub, xlsx, pptx,
rtf, html, ipynb**. Crates include `zip-7.2.0`, `quick-xml-0.38.3`, `deflate64`, `bzip2`,
`serde_json` (20 total).
- New architectural detail from its `--help`: it is the **local twin of a server-side
  "file-parser HTTP service."** The zip-format extractors enforce a per-entry decompressed-size
  cap, a compression-ratio (zip-bomb) threshold, and a total-extracted-text cap; the service
  enables all three, while this binary enforces only a 1 GiB per-entry cap unless
  `--service-limits` is passed. This is what backs document text extraction in the file tools.

## 3. magika  (Google, vendored)
`/usr/local/bin/magika` — **Google Magika 1.0.1**, model `standard_v3_3`, BuildID `d54ca6cab…`,
32.5 MB (not stripped). The ONNX deep-learning file-type classifier; bundles the model and
ONNX Runtime. Public tool, not built from Anthropic's registry — included for completeness
since it ships in the sandbox and is used for content-type detection.

(Also present but not packed: Playwright's bundled `chromium`/`chromium_headless_shell` and
`ffmpeg-linux` under `/opt/pw-browsers` — standard upstream browser binaries.)
