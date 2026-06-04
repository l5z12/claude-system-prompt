# Claude Memory System — Backend API

## Overview

The `rclone-filestore` binary bundles a second backend for Claude's memory system — the `rclone-memory` backend. This handles persistent memories (facts about users, preferences, etc.) that Claude can access across conversations.

> **Live finding (in-sandbox `/proc/mounts` + mount config):** in a **standard consumer session, memory is
> RPC-only — not FUSE-mounted.** All four FUSE mounts are `filesystem_id`-keyed and every
> mount entry has `"memory_store_id": null`. The `rclone-memory` backend and the
> `MemoryInternalService` methods are compiled in, but the FUSE memory mount only
> materializes when the backend provisions a `memory_store_id`.
>
> **Per-entry rule (validation strings):** each multimount entry must have **exactly one**
> of `filesystem_id` or `memory_store_id` — *both set* → error, *neither set* → error. When
> `memory_store_id` is populated, rclone adds a **5th FUSE mount** via the `rclone-memory`
> backend, appearing in `/proc/mounts` as
> `rclone-memory:<memory_store_id>:<dest> on <dest> type fuse.rclone (…)` (with the
> `sk-ant-mem-*` token in that entry's config). So the memory FUSE mount is conditional,
> not default.

## Proto Service

```
Package:  anthropic.memory.api.v1alpha
Service:  MemoryInternalService
```

**Transport:** Connect RPC (`connectrpc.com/connect`), same as the filestore backend
— not a reflection-enabled gRPC server.

Confirmed `MemoryInternalService` method paths (full strings in the binary):
```
/anthropic.memory.api.v1alpha.MemoryInternalService/WriteMemory
/anthropic.memory.api.v1alpha.MemoryInternalService/ReadMemoryByPath
/anthropic.memory.api.v1alpha.MemoryInternalService/MoveMemory
/anthropic.memory.api.v1alpha.MemoryInternalService/DeleteMemoryByPath
/anthropic.memory.api.v1alpha.MemoryInternalService/ListMemories
/anthropic.memory.api.v1alpha.MemoryInternalService/SearchMemories
```

REST routes also present: `/v1/memory_stores/{memory_store_id}/memory_versions`,
`/v1/memory_stores/{memory_store_id}/memories/{memory_id}`. Public-facing message
types seen: `WriteMemory`, `DeleteMemory`, `ListMemories`, `UpdateMemory`,
`SearchMemories` (`v1alpha`) and `ListMemoryVersions` (`v1`).

**Behaviour (from strings):** the store is **path-addressed and hierarchical** —
`ListMemories` with a `depth` returns rolled-up directory markers for entries deeper
than requested. Writes use optimistic concurrency via `ContentSha256Precondition`
and `NotExistsPrecondition`. Guardrails: `memory_content_too_large`,
`memory move rejected: %s`.

Other message types from the protos:
- `InternalMemory`, `MemoryVersion`, `MemoryVersionMetadata`, `InternalMemoryListItem`
- `SessionActor` — which session created/modified a memory
- `MemoryPrefix` — the directory-rollup marker
- `SearchLine`, `SearchMatch`

## Authentication

Uses a different token format than the filestore JWT:

```
sk-ant-mem-<alphanumeric>
```

Found as a partial string in rclone's heap — not fully recoverable. This token is provisioned separately from the filestore JWT.

## Accessibility

The memory gRPC API is **not accessible via the public `api.anthropic.com` endpoint**. All gRPC calls to the MemoryInternalService return `UNIMPLEMENTED`. It's an internal service only, likely on a separate internal hostname not reachable from the sandbox.

## What the Memory System Stores

From the proto message types:
- `InternalMemory` — a single memory entry
- `MemoryVersion` + `MemoryVersionMetadata` — versioning of memory updates
- `SessionActor` — identifies which session created/modified a memory
- `MemoryPrefix` — hierarchical organization of memories

## Encryption & Versioning (active build only)

The **active squashfs build** (go1.25.10) carries memory features the older rootfs
build (go1.25.9, `/usr/local/bin`) lacks — evidence the memory system was evolving
between the two builds shipped in this image:

- **`AADScheme` / `aadScheme`** — memory content appears to be stored under
  **authenticated encryption with Additional Authenticated Data (AEAD/AAD)**, i.e.
  encrypted-at-rest with bound metadata, not plaintext.
- **`DeltaHunk`** — memory versions are stored as **delta hunks** (diffs), not full
  copies per version — consistent with the `MemoryVersion`/`ListMemoryVersions` surface.
- **`MemoryPreconditionFailedError`** with a descriptive blocked-path string:
  *"Path of the existing memory that blocked this write. May be the same as the
  requested path (occupied), an ancestor of it, or a descendant."* — i.e. writes fail
  if any occupied/ancestor/descendant path conflicts (path-tree exclusivity).
- A second **`memory.api.v1`** surface (`CreateMemoryParams`, `ApiActor`, `ListOrder`,
  `ContentSha256Precondition`) alongside the original `v1alpha`.

## System Prompt Note

When the user has enabled memory, the system prompt contains:

```
Claude has a memory system which provides Claude with access to derived
information (memories) from past conversations with the user
```

When disabled:
```
Claude has no memories of the user because the user has not enabled
Claude's memory in Settings
```

## Relationship to rclone

The rclone-memory backend is compiled into the same `rclone-filestore` binary but handles a completely different backend. It may be configured via the `memory_store_id` field in the multimount config (alternative to `filesystem_id` for memory-backed mounts).

From the multimount config schema:
```
memory_store_id  — alternative to filesystem_id for memory backend mounts
```
