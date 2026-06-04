# Claude Memory System — Backend API

## Overview

The `rclone-filestore` binary bundles a second backend for Claude's memory system — the `rclone-memory` backend. This handles persistent memories (facts about users, preferences, etc.) that Claude can access across conversations.

## Proto Service

```
Package:  anthropic.memory.api.v1alpha
Service:  MemoryInternalService
```

Confirmed method paths (embedded as strings in binary):
```
/anthropic.memory.api.v1alpha.MemoryInternalService/ReadMemoryByPath
/anthropic.memory.api.v1alpha.MemoryInternalService/DeleteMemoryByPath
```

Other methods discovered from proto message types:
- `SearchMemoriesRequest` / `ListMemoriesResponse`
- `DeleteMemoryResponse`
- `UpdateMemoryResponse`
- `InternalMemory`, `MemoryVersion`, `MemoryVersionMetadata`
- `SessionActor`
- `MemoryPrefix`
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
