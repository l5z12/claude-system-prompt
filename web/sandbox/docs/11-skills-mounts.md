# Skills — Squashfs Mounts

## Overview

Skills are read-only instruction files mounted from squashfs block devices. They are separate from the user-data filestore — they're pre-built images attached to the VM at boot.

## Mount Points

| Device | Mount | Contents |
|---|---|---|
| `/dev/vdc` (~656 KiB) | `/mnt/skills/public` | 9 production skills |
| `/dev/vdd` (~5.3 MiB) | `/mnt/skills/examples` | 24 example skills |
| *(not provisioned)* | `/mnt/skills/private` | Workspace-custom skills (Enterprise only) |

Both are mounted read-only with squashfs (`ro,relatime,errors=continue`).

## Public Skills (`/mnt/skills/public`)

These are the production skills shown in the `<available_skills>` system prompt block:

| Skill | Location | Description |
|---|---|---|
| `docx` | `public/docx/` | Word document creation/editing |
| `pdf` | `public/pdf/` | PDF creation, filling, manipulation |
| `pptx` | `public/pptx/` | PowerPoint presentations |
| `xlsx` | `public/xlsx/` | Excel spreadsheets |
| `frontend-design` | `public/frontend-design/` | Web UI / React components |
| `product-self-knowledge` | `public/product-self-knowledge/` | Anthropic product facts |
| `file-reading` | `public/file-reading/` | Router for reading uploaded files |
| `pdf-reading` | `public/pdf-reading/` | PDF content extraction |

Each skill has a `SKILL.md` (the main instruction file), a `LICENSE.txt`, and may include supporting docs and a `scripts/` directory with helper Python/shell scripts.

Supporting files include:
- `pdf/FORMS.md`, `pdf/REFERENCE.md`
- `pdf-reading/REFERENCE.md`
- `pptx/editing.md`, `pptx/pptxgenjs.md`

The `scripts/` directories contain significant Python code (~1.1MB each for docx/pptx/xlsx), helper binaries, fonts (`.ttf`), and XML schemas (`.xsd`).

## Example Skills (`/mnt/skills/examples`)

24 consumer/operator example skills:

```
algorithmic-art        benepass-reimbursement  brand-guidelines
call-to-book           cancel-unsubscribe       canvas-design
doc-coauthoring        event-planning           file-expenses
file-form              financial-calculator     grocery-shopping
hire-help              internal-comms           learn
mcp-builder            meal-delivery            prescription-refill
return-refund          skill-creator            slack-gif-creator
theme-factory          web-artifacts-builder
```

Each has a `SKILL.md` and `LICENSE.txt`. Larger ones also have `agents/`, `references/`, `scripts/`, `themes/`, or `examples/` subdirectories.

Notable:
- `skill-creator` — for building new skills (with eval framework)
- `mcp-builder` — for building MCP servers (with 4 reference docs)
- `theme-factory` — 10 theme files + PDF showcase
- `canvas-design` — canvas fonts directory

## Skill File Bundles (`.skill` files)

Each skill has a corresponding `.skill` file (e.g., `docx.skill`) adjacent to its directory. These are packaged archive versions of the skill, likely used for distribution and versioning. Total: 31 `.skill` files across both mounts.

## Private Skills

`/mnt/skills/private` is referenced in the filesystem config as a read-only mount but is **not provisioned** for standard claude.ai consumer sessions:

- No corresponding block device (`/dev/vde` etc.) was attached
- The directory doesn't exist on the filesystem
- `debugfs` confirms 0 deleted inodes — it never existed in this session

**For Enterprise/Teams workspaces** with operator-uploaded custom skills:
- A custom squashfs image would be built from the operator's skill files
- Attached as an additional block device (e.g., vde)
- Mounted at `/mnt/skills/private` at boot via `container.env` config
- The `private` directory would appear and contain workspace-specific skills

## device index System

From process_api binary strings, skills are managed via a device index system:

```
readonly_dev_start_index  — first device index for readonly mounts (skills etc.)
rclone_tools_dev_index    — which device index is the rclone binary (vdb)
readonly_mounts           — array of squashfs device configs in container.env
```

The block device assignment is:
- `vdb` (index 1) = rclone tools
- `vdc` (index 2) = public skills
- `vdd` (index 3) = example skills
- `vde` (index 4) = private skills (if provisioned)

## `.skill` bundle format & private-skill pipeline *(in-sandbox)*

A `.skill` file is a **standard deflate ZIP** of the skill directory tree rooted at the skill
name (`file docx.skill` → `Zip archive data … method=deflate`). The squashfs on `vdc`/`vdd`
is the *extracted* content of these ZIPs — verified: `md5(docx.skill:docx/SKILL.md) ==
md5(/mnt/skills/public/docx/SKILL.md)`. The `.skill` ZIP is the canonical source artifact.

The official packaging tool ships inside the examples volume at
`skill-creator/scripts/package_skill.py`:
```python
with zipfile.ZipFile(skill_filename, 'w', zipfile.ZIP_DEFLATED) as zipf:
    for file_path in skill_path.rglob('*'):
        if not file_path.is_file(): continue
        arcname = file_path.relative_to(skill_path.parent)
        if should_exclude(arcname): continue   # excludes __pycache__, *.pyc, evals/
        zipf.write(file_path, arcname)
```

**Reconstructed enterprise private-skill pipeline:**
1. Operator builds a skill dir (`SKILL.md` + optional `scripts/`, `references/`, …).
2. `python package_skill.py <dir>` → `<name>.skill` (ZIP); validated via `quick_validate.py`.
3. Anthropic extracts it and builds a **squashfs** image from the contents.
4. That squashfs is attached as an additional virtio-blk device (**`/dev/vde`**, index 4)
   for the operator's workspace VMs.
5. process_api mounts it at **`/mnt/skills/private`** during init (from `readonly_mounts`).

## Model Tools

The process_api also references a separate "model tools" mount:

```
/mnt/sandboxing/model_tools_env/v1/python
[INIT] Model tools mounted from /dev/vdb
[INIT] WARNING: Failed to mount model tools: ...
```

This is a Python environment for model-side tools, distinct from the skills. In this session it either failed to mount or is unused. The warning suggests it's optional.
