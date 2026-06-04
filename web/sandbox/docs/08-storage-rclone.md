# Storage — rclone-filestore

## Binary

```
Path:     /opt/rclone/rclone-filestore
          (mounted from squashfs on /dev/vdb)
Type:     ELF 64-bit LSB executable, x86-64, dynamically linked, stripped
Size:     ~30 MB
Language: Go
Source:   github.com/anthropics/anthropic/api-go/filestore/cmd/rclone
BuildID:  8c32c598df86f6b4f0a67ddaac9dee09a6313f4d
```

A custom fork of rclone with two additional proprietary backends. Standard rclone commands (obscure, lsjson, etc.) are stripped out; only relevant commands remain: `ls`, `mount`, `mount2`, `multimount`.

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

### rclone-filestore Backend

Talks to `https://api.anthropic.com/v1/filestore/fs/` using the session JWT. See `09-filestore-api.md` for full API documentation.

Proto source: `github.com/anthropics/anthropic/api-go/filestore/cmd/rclone/proto/filestore/v1alpha`

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
- **Auth token**: the `auth_token` field in the multimount config is intentionally missing — tokens are injected via a separate mechanism (process_api writes them directly to the config before spawning rclone, then overwrites/scrubs).
