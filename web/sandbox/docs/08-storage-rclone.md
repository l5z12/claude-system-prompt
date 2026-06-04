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

> **The BuildID is capture-time-specific — the squashfs rclone is rebuilt/swapped often.**
> Three distinct builds of `/opt/rclone/rclone-filestore` have been observed:
> | Capture | BuildID | Go | Provenance |
> |---|---|---|---|
> | **live session 2026-06-04** (in-sandbox check) | **`8c32c598…`** | — | the one actually serving that session |
> | static pack `/opt/rclone` | `58d2ccb0…` | go1.25.10 | no VCS stamp (CI/export build) |
> | static pack `/usr/local/bin` (rootfs baseline) | `3fe76ce4…` | go1.25.9 | `vcs.revision=23e9fa9…`, `vcs.time=2026-04-18`, `vcs.modified=false` |
>
> So the original `8c32c598…` in this doc was **not stale** — it was correct for the live
> session; the static pack simply captured *different* builds at a different time. Shipping
> rclone via the read-only `/dev/vdb` squashfs lets Anthropic refresh the storage client
> independently of the rootfs, and they evidently do so frequently. Main package for all:
> `github.com/anthropics/anthropic/api-go/filestore/cmd/rclone (devel)`, `-trimpath`,
> `CGO_ENABLED=1`, `GOAMD64=v1`. Newer pack builds also carry an expanded memory API the
> rootfs baseline lacks (see `12-memory-api.md`): `memory.api.v1` (`CreateMemoryParams`,
> `ApiActor`, `ListOrder`), `MemoryPreconditionFailedError`, **`AADScheme`**, **`DeltaHunk`**.

A custom fork of rclone with two proprietary backends (`rclone-filestore`,
`rclone-memory`) and **everything else stripped**. Live `--help` shows only:
`completion`, `help`, `ls`, `mount`, `mount2`, `multimount` (no `copy`/`sync`/`cat`/`rc`/
`config`/`obscure`/`reveal`/`serve`/`version`/…). Backends list (`rclone help backends`)
is just the two proprietary ones — no S3/GCS/local/crypt/etc.

**`mount` vs `mount2` (in-sandbox, from the embedded module list):** both use
`github.com/hanwen/go-fuse/v2 v2.8.0` (there is **no** bazil/fuse dep — the bazil mention
is only a deprecation-warning string). `mount` = upstream `rclone/cmd/mount` (goes through
rclone's VFS cache layer). `mount2` = **`github.com/anthropics/anthropic/api-go/filestore/
cmd/rclone/mount2direct`** — an Anthropic-custom package that implements the raw
hanwen/go-fuse node/file interface **directly, bypassing rclone's VFS layer** (methods seen:
`mount2direct.(*FS).Root/SetDebug/setAttrOut/setEntryOut`, `(*FileHandle).Flush/Fsync/
Getattr`). The **`multimount`** command that actually runs uses `mount2direct` under the
hood.

**Correction (from live test):** although the `obscure` *package* is linked, the
`obscure`/`reveal` **CLI subcommands are stripped**, and the algorithm is **not** upstream
rclone's AES-CTR. The `auth_token` is a **custom ChaCha20** obscure — see *Authentication*.

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
- **Auth token**: the captured `rclone-mount-config.json` (multimount) has **no** `auth_token` per mount — it's delivered out-of-band in the `POST /mount_root` body (whose schema *does* include `auth_token`) and scrubbed from any persistent config after rclone starts. When the token *is* placed in a per-remote config it is stored **obscured** (the `RC…` blob in `tmp/rclone.conf`). **Corrected by in-sandbox test (round-tripped against the real heap JWT):** this fork's obscure is a **custom ChaCha20** scheme, not upstream rclone's AES-CTR:
  ```python
  key = sha256(b"!RCLONE!OBSCURE!DATA!").digest()        # 32-byte key
  # RC = base64url( IV[16] || ChaCha20(key, nonce=IV[:12]).encrypt(jwt) ), no padding
  ```
  It was round-tripped against the real heap JWT in a live session. It is reversible (so
  obfuscation-at-rest, not real encryption) **but upstream `rclone reveal` will not decode
  it** — different algorithm and key — and the `reveal` CLI is stripped anyway. See `10`.
