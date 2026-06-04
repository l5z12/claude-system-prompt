# Binary-Level Analysis: process_api & rclone-filestore

> Verified directly against the two binaries in `sandbox_artifacts/binaries/`
> (`process_api`, `rclone-filestore`) via `strings`/`file`. This extends and in
> places corrects docs 04, 05, 08, 09, 10, 12. Where this doc and an earlier one
> disagree, prefer this one — it is sourced from the shipped binaries.

| Binary | Type | BuildID | Language |
|---|---|---|---|
| `process_api` | ELF x86-64, **static-pie**, stripped | `edebff2c28de76238c95c299ba3401a9098c9e17` | Rust / Tokio |
| `rclone-filestore` | ELF x86-64, **dynamically linked**, stripped | `58d2ccb0478242b16a2161212c63e9be1f9a051c` | Go (fork of rclone) |

Build provenance for `process_api`: cargo registry path
`artifactory.infra.ant.dev-7db23613d841872b`, uses `tokio-vsock 0.7.2`.

---

## Part 1 — process_api (VM init + tool executor)

### 1.1 Role
PID 1 inside the microVM. Help string for `--firecracker-init`:

> Run as Firecracker VM init (PID 1). Mounts /proc, /sys, /dev, sets up
> networking, then **either reads `/mount_config.json` (fresh boot) or waits for
> `POST /mount_root` (snapstart)**. Also enables the `/mount_root` endpoint on the
> control server. Has no effect on gVisor/runc where the rootfs is already set up
> by the host.

Network is configured by init itself:
`[INIT] Network configured: IP=192.0.2.2/24, GW=192.0.2.1, MTU=1400`.

### 1.2 CLI / env flags (from embedded clap help)
| Flag | Env | Default | Purpose |
|---|---|---|---|
| `--firecracker-init` | `FIRECRACKER_INIT` | — | run as VM PID 1 |
| `--addr` | — | — | TCP WS listen addr (`0.0.0.0:2024`) |
| `--max-ws-buffer-size` | `MAX_WS_BUFFER_SIZE` | `32768` | WS write buffer |
| `--memory-limit-bytes` | `MEMORY_LIMIT_BYTES` | — | cgroup mem cap |
| `--cpu-shares` | `CPU_SHARES` | — | cgroup cpu shares |
| `--oom-polling-period-ms` | `OOM_POLLING_PERIOD_MS` | `100` | OOM poll interval |
| `--block-local-connections` | `BLOCK_LOCAL_CONNECTIONS` | — | reject localhost / own-IP WS clients |
| `--control-server-addr` | `CONTROL_SERVER_ADDR` | — | control HTTP addr (`0.0.0.0:2025`); **when set, SIGINT handler is disabled** |
| `--listen-vsock-port` | `LISTEN_VSOCK_PORT` | — | WS over vsock (Firecracker alt) |
| `--control-vsock-port` | `CONTROL_VSOCK_PORT` | — | control server over vsock |
| `--listen-uds` | `LISTEN_UDS` | — | WS over Unix socket (gVisor) |
| `--dial-uds` / `--host-uds=open` | — | — | gVisor bridge: dial out to a host-side UDS instead of binding |
| `--cgroupv2` | — | — | use cgroup v2 hierarchy |

**gVisor bridge detail (new):** with `--host-uds=open`, `bind()` on gofer-backed
paths fails (sentry-synthetic dentry the host can't reach), so init *dials out* to
a host-side UDS bridge. The Router on the other end sends the HTTP Upgrade, so the
TCP-direction reversal is transparent to the WS handler.

**dp_mtls fallback (confirmed string):**
`restored on a server without dp_mtls. TCP :2024 remains available.`

### 1.3 Control server (port 2025) — full endpoint set
The prior docs only listed `/mount_root`. The binary actually exposes a whole
**snapshot lifecycle API**:

| Endpoint / action | Log evidence | Purpose |
|---|---|---|
| `POST /mount_root` | `[CONTROL] mount_root succeeded/failed/task panicked` | apply per-session mounts after restore |
| `/auth_public_key` | `[CONTROL] Auth public key set successfully` | install the public key used to verify the session |
| `/write_etc_files` | `[CONTROL] /write_etc_files: append_ca_cert failed` | write `/etc/resolv.conf`, `/etc/hosts`, append egress CA |
| `/fs_freeze` | `[CONTROL] Freezing / ...`, `FIFREEZE`/`FITHAW`, `/fs_freeze: done (frozen ...)` | `FIFREEZE` ioctl the rootfs so the template can be snapshotted clean |
| clock sync | `[CONTROL] Clock synced (unix_nanos=...)`, `clock_settime failed` | fix wall-clock after restore |
| drop caches | `[CONTROL] Dropping page caches...` | drop template page cache |
| container name | `Using container name from control server`, `Container name mismatch: Expected container '...'`, `persist ... to container_info.json` | inject/verify the per-conversation container name |

**Inferred snapstart sequence:** build template → `/fs_freeze` (FIFREEZE) →
Firecracker snapshot → on restore: clock sync → `/auth_public_key` →
`/write_etc_files` → `/mount_root` → set container name → drop page caches → ready.

### 1.4 mount config schema (`/mount_config.json` / `mount_root` body)
Struct fields recovered verbatim:
```
destination, filesystem_id, memory_store_id, auth_token, service_url,
vfs_cache_mode, backend_cache_ttl, resolv_conf, etc_hosts, ca_cert_pem,
mount_model_tools, mount_rclone_tools, rclone_tools_dev_index,
fuse_mounts, readonly_mounts, readonly_dev_start_index, realtime_unix_nanos
```
Note `memory_store_id` sits right next to `filesystem_id` — the memory store is
provisioned through the *same* mount config as the file mounts (see Part 2).

### 1.5 WebSocket tool protocol (port 2024) — complete enum
**Server→client:** `ProcessCreated`, `ProcessCreatedV2`, `AttachedToProcess`,
`AttachedToProcessV2`, `ProcessNotRunning`, `ProcessAlreadyAttached`,
`FailedToStartProcessWithSameId`, `RunningInfraError`, `ExpectStdOut`,
`StdOutEOF`, `ExpectStdErr`, `StdErrEOF`, `ProcessExited`, `ProcessTimedOut`,
`ProcessCpuTimedOut`, `ProcessOutOfMemory`, `ContainerOutOfMemory`,
`InvalidSignal`, `FailedToSendSignal`, `SignalSent`, `ShuttingDown`, `TraceEvent`.
**Client→server:** `CreateProcess`, `SendSignal`, `ExpectStdIn`, `StdInEOF`.

`CreateProcess` fields: `process_id, uid, gid, timeout, cpu_timeout,
clear_env, reattachable, allow_process_id_reuse` (+ env map).
`ConnectionCapabilities`: `supports_trace`, `supports_zstd`.
`ProcessInfo`: `pid, start_time, start_wallclock_micros, cmd_summary,
stdin_bytes, stdout_bytes, stderr_bytes, trace_emitted, trace_outcome`.

Notes: `cpu_timeout` falls back to wall-clock if not enforceable
(`cpu_timeout not enforced, falling back to wall-clock timeout only`).
`process_id` is validated: non-empty, length-bounded, **no control chars**, and
**may not contain the trace marker `##TRACE##`**. Process listing is done via
`ps --no-headers`; `/proc/sys/kernel/pid_max` is read.

### 1.6 Token scrubbing & OOM (confirmed)
Scrub patterns: `_TOKEN`, `_SECRET`, `_PASSWORD`, `API_KEY`.
OOM: per-process memory-cgroup poll; on kill writes `[OOM_KILL] process_id=...`
to `oom_killed.log` and emits `ProcessOutOfMemory`/`ContainerOutOfMemory`.

---

## Part 2 — rclone-filestore (storage + memory bridge)

### 2.1 What it actually is
A **fork of rclone** (`github.com/rclone/rclone`) that registers **two custom
backends**, both talking to `https://api.anthropic.com` via **Connect RPC**
(`connectrpc.com/connect`, not plain gRPC — that's why gRPC reflection failed):

- `rclone-filestore` — the user-data file mounts
- `rclone-memory` — the Claude memory store (**new: memory is an rclone backend, not a separate service**)

Generated protobufs live under
`github.com/anthropics/anthropic/api-go/gen/proto/anthropic/{filestore,memory}`.
Proto files referenced: `filestore/v1alpha/{filestore,filesystem,validate}.proto`,
`memory/api/v1alpha/{memory_api,memory_envelope,operation_event}.proto`,
`memory/api/v1/memory_api.proto`.

### 2.2 Filestore surface
REST-ish file ops seen in the binary: `v1/filestore/fs/createFile`,
`v1/filestore/fs/removeFile` (readFile/list exist per doc 09). Each mount is a
FUSE/VFS view keyed by `filesystem_id` (this session:
`claude_chat_016KxrU6BUEWYFyzaMHX2uyc`) with per-mount `cache_duration_s`,
`vfs_cache_mode=full`, cache in `/dev/shm` / `/tmp/rclone-mounts`.

### 2.3 Memory surface (`anthropic.memory.api.v1alpha.MemoryInternalService`)
Methods recovered: **WriteMemory, ReadMemoryByPath, MoveMemory,
DeleteMemoryByPath, ListMemories, SearchMemories** (plus public
`v1alpha`/`v1`: UpdateMemory, ListMemoryVersions, and REST routes
`/v1/memory_stores/{memory_store_id}/memory_versions` and
`/v1/memory_stores/{memory_store_id}/memories/{memory_id}`).
The store is **path-addressed and hierarchical** — `ListMemories` with a `depth`
returns rolled-up directory markers for entries deeper than requested.
Optimistic concurrency via `ContentSha256Precondition` and `NotExistsPrecondition`.
Memory session token format: `sk-ant-mem-…`.

### 2.4 Auth model
Connect RPC with Anthropic auth annotations: **`CustomJwtAuth`** and
**`ObolJwtAuth`** (`anthropic.annotations`), carried in an `AuthorizationMetadata`
message and an `Authorization:` header. The mount config's `auth_token` is the
JWT (doc 10: ES256, ~6h TTL, embeds account/org/workspace UUIDs).

### 2.5 ⚠️ The `auth_token` in `rclone.conf` is *obfuscated, not encrypted*
The binary links `github.com/rclone/rclone/fs/config/obscure` with
`Obscure`/`Reveal`/`MustObscure` and a fixed `cryptKey`. That means the
`RC…`-prefixed `auth_token` in `tmp/rclone.conf` is rclone's **standard
reversible `obscure`** (AES-CTR under a hard-coded upstream key) — recoverable
with `rclone reveal` / any rclone build. The string
`Please note that an obscured version of this password…` confirms it. So it is
*obfuscation to avoid plaintext-at-rest*, **not** a real secret-protection
boundary. (Also supports `_RCLONE_CONFIG_KEY_FILE`/`configKey` for true config
encryption, which is not what's used here.)

---

## Corrections vs. earlier docs
1. **Memory is a second rclone backend (`rclone-memory`)** carried in the same
   `process_api` mount config (`memory_store_id`), not an opaque separate service.
2. **Control server is a full snapshot-lifecycle API** (`/fs_freeze`,
   `/auth_public_key`, `/write_etc_files`, clock sync, drop-caches, container
   name), not just `/mount_root`.
3. **Transport is Connect RPC**, which is why gRPC reflection probes failed.
4. **`auth_token` is reversible rclone-obscure**, not encrypted.
5. Auth uses named schemes **`CustomJwtAuth` / `ObolJwtAuth`** ("Obol" = internal).

## Still unknown
- The fixed public key passed to `/auth_public_key` and how it gates WS/dp_mtls.
- Whether `rclone-memory` is also FUSE-mounted in-VM or only used via RPC.
- `mount_model_tools` / `rclone_tools_dev_index` exact payload (model-tools mount).
