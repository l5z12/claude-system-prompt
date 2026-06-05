# Storage — rclone-filestore

## Binary

```
Path:     /opt/rclone/rclone-filestore   (mounted from squashfs on /dev/vdb, RO)
Type:     ELF 64-bit LSB executable, x86-64, dynamically linked, stripped
Size:     30,182,360 bytes (~30 MB)
Language: Go (fork of github.com/rclone/rclone)
Source:   github.com/anthropics/anthropic/api-go  (gen/proto + filestore)
BuildID:  58d2ccb0478242b16a2161212c63e9be1f9a051c   ← verified against the actual binary
```

> **The BuildID is capture-time-specific.** The `/opt/rclone` squashfs is re-attached fresh
> on every snapstart restore (i.e. per tool-turn — doc 03), so the build hash drifts between
> turns (e.g. `58d2ccb0…`, `5e06cfce…`, `5c205e4a…`, `94d27ecf…` have all been seen) while the
> **byte-size stays 30,182,360** — consistent with deterministic `-trimpath` rebuilds of the
> same source. Shipping rclone via RO `/dev/vdb` lets Anthropic refresh the storage client
> independently of the rootfs, and they do so frequently. All builds: main package
> `github.com/anthropics/anthropic/api-go/filestore/cmd/rclone (devel)`, `-trimpath`,
> `CGO_ENABLED=1`, `GOAMD64=v1`, go1.25.x. Newer packs also carry an expanded memory API the
> rootfs baseline lacks (see `12-memory-api.md`): `memory.api.v1` (`CreateMemoryParams`,
> `ApiActor`, `ListOrder`), `MemoryPreconditionFailedError`, **`AADScheme`**, **`DeltaHunk`**.

A custom fork of rclone with two proprietary backends (`rclone-filestore`,
`rclone-memory`) plus a trimmed command set. Live `--help` shows only:
`completion`, `help`, `ls`, `mount`, `mount2`, `multimount` (no `copy`/`sync`/`cat`/`rc`/
`config`/`obscure`/`reveal`/`serve`/`version`/…).

Registered backends are **`local`, `crypt`, `rclone-filestore`, `rclone-memory`** (the first
two upstream, the last two proprietary). The library is not stripped down — the whole rclone
tree is compiled in; only the *exposed command set* (the 6 above) is trimmed. Backend config:
filestore takes `url`/`filesystem_id`/`auth_token` (url default `http://localhost:9112`,
*"handles file metadata + GCS operations internally"*); memory takes `url`/`memory_store_id`
(`memstore_…`)/`auth_token` (`sk-ant-mem-…`).

**`mount` vs `mount2` (in-sandbox, from the embedded module list):** both use
`github.com/hanwen/go-fuse/v2 v2.8.0` (there is **no** bazil/fuse dep — the bazil mention
is only a deprecation-warning string). `mount` = upstream `rclone/cmd/mount` (goes through
rclone's VFS cache layer). `mount2` = **`github.com/anthropics/anthropic/api-go/filestore/
cmd/rclone/mount2direct`** — an Anthropic-custom package that implements the raw
hanwen/go-fuse node/file interface **directly, bypassing rclone's VFS layer** (methods seen:
`mount2direct.(*FS).Root/SetDebug/setAttrOut/setEntryOut`, `(*FileHandle).Flush/Fsync/
Getattr`). The **`multimount`** command that actually runs uses `mount2direct` under the
hood.

The `obscure`/`reveal` CLI subcommands are not exposed, but the obscure algorithm is
**upstream rclone AES-256-CTR** under a hard-coded key (symbols
`fs/config/obscure.{Obscure,Reveal,cryptKey,cryptRand}`; no custom marker) — so an `auth_token`
written to a config is recoverable by any rclone build's `reveal`. It is obfuscation-at-rest,
not a secret boundary. See `16-binary-analysis-process-api-rclone.md` §2.5.

## Invocation

```sh
/opt/rclone/rclone-filestore multimount --config /tmp/rclone-mount-config.json
```

## Config File

`/tmp/rclone-mount-config.json`:

```json
{
  "mounts": [
    {
      "cache_duration_s": 3600.0,
      "destination": "/mnt/user-data/outputs",
      "dir_perms": "0755",
      "file_perms": "0644",
      "filesystem_id": "claude_chat_<id>",
      "gid": 1000,
      "readonly": false,
      "source": "/outputs",
      "uid": 999,
      "vfs_cache_max_size": "1G",
      "vfs_cache_mode": "full"
    },
    {
      "cache_duration_s": 1.0,
      "destination": "/mnt/user-data/uploads",
      "filesystem_id": "claude_chat_<id>",
      "readonly": true,
      "source": "/uploads",
      ...
    },
    {
      "cache_duration_s": 10.0,
      "destination": "/mnt/transcripts",
      "filesystem_id": "claude_chat_<id>",
      "readonly": true,
      "source": "/transcripts",
      ...
    },
    {
      "cache_duration_s": 3.0,
      "destination": "/mnt/user-data/tool_results",
      "filesystem_id": "claude_chat_<id>",
      "readonly": true,
      "source": "/tool_results",
      ...
    }
  ],
  "ready_file": "/tmp/rclone-mounts/ready",
  "service_url": "https://api.anthropic.com",
  "state_dir": "/tmp/rclone-mounts"
}
```

## FUSE Mounts

| Mount Point | Source Path | R/W | Cache TTL | Purpose |
|---|---|---|---|---|
| `/mnt/user-data/outputs` | `/outputs` | **RW** | 3600s (1h) | Files presented to user |
| `/mnt/user-data/uploads` | `/uploads` | RO | 1s | User-uploaded files |
| `/mnt/transcripts` | `/transcripts` | RO | 10s | Conversation transcript |
| `/mnt/user-data/tool_results` | `/tool_results` | RO | 3s | Tool result data |

All mounts use `vfs_cache_mode: full` — rclone maintains a local copy in `/dev/shm/rclone-vfscache`.

**In-sandbox observation:** mid-conversation, `/mnt/transcripts` and `/mnt/user-data/tool_results`
are **empty** (the filestore API also returns `{}` for them). Their short TTLs (10s / 3s vs.
outputs' 3600s) indicate they're designed to be polled for live updates; content appears to be
written by the backend out-of-band (e.g. at/after turn boundaries), not by the model.

## VFS Cache

```
/dev/shm/rclone-vfscache/
├── vfs/<filesystem_id>_<mount_path>/   — cached file data
└── vfsMeta/<filesystem_id>_<mount_path>/ — cached file metadata
```

Each metadata entry (`.json`) contains:
```json
{
  "ModTime": "2026-06-04T07:12:28Z",
  "ATime": "2026-06-04T07:12:28Z",
  "Size": 571,
  "Rs": [{"Pos": 0, "Size": 571}],
  "Fingerprint": "571,<md5>",
  "Dirty": false
}
```

`Dirty: false` = file is synced to remote. `Dirty: true` = pending upload.

Cache lives in shared memory (tmpfs). It's lost when rclone restarts and not persisted to disk.

## Custom Backends

**Transport:** both backends speak **Connect RPC** (`connectrpc.com/connect`, with
the `Connect-Protocol-Version` header) over the protobufs in
`github.com/anthropics/anthropic/api-go/gen/proto/...`. This is why earlier gRPC
*reflection* probes failed — it is Connect, not a reflection-enabled gRPC server.

### rclone-filestore Backend

Talks to `https://api.anthropic.com/v1/filestore/fs/` using the session JWT. See `09-filestore-api.md` for full API documentation.

Proto source: `anthropic/filestore/v1alpha/{filestore,filesystem,validate}.proto`

### rclone-memory Backend

Talks to the Claude memory API:
- Service: `anthropic.memory.api.v1alpha.MemoryInternalService`
- Auth: `sk-ant-mem-*` tokens (different from the filestore JWT)
- Methods include: `ReadMemoryByPath`, `DeleteMemoryByPath`, `SearchMemories`, `ListMemories`, `UpdateMemory`
- **Not accessible via the public API endpoint** — internal service only

## Authentication

The session JWT is:
- Stored **only in rclone's process heap** (never written to disk or config files)
- Injected by process_api at startup, then scrubbed from config files
- Accessible via `/proc/<rclone_pid>/mem` (readable as root)
- ES256 signed, 6-hour TTL

See `10-jwt-auth.md` for JWT details.

## Network Connection

rclone maintains one persistent HTTPS connection to `160.79.104.10:443` (api.anthropic.com) for filestore operations. This goes through the TLS inspection proxy.

## Key Behaviours

- **Directory cache TTL**: rclone's in-memory directory listing has a separate TTL (default 5 minutes) from the file data cache. Files created via the REST API directly won't appear in FUSE until the directory cache expires or is invalidated.
- **Write-through**: writes to FUSE mounts are synced to the filestore backend before the VFS cache expires.
- **Auth token**: the captured `rclone-mount-config.json` (multimount) has **no** `auth_token` per mount — it's delivered out-of-band in the `POST /mount_root` body (whose schema *does* include `auth_token`) and scrubbed from any persistent config after rclone starts. When the token *is* placed in a per-remote config it is stored **obscured** (the `RC…` blob in `tmp/rclone.conf`) using upstream rclone's standard reversible AES-256-CTR obscure — decodable by any rclone build's `reveal`, so obfuscation-at-rest rather than real encryption. See `16-binary-analysis-process-api-rclone.md` §2.5 and `10`.
