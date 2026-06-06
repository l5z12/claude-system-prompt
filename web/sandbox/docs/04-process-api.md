# process_api — The VM Init Process (Exhaustive, End-to-End)

> The PID-1 binary that runs every Claude code-execution VM. This document is a
> route-by-route walkthrough: every boot step, every control endpoint, every WebSocket
> branch, every supervisor/OOM path — grounded in strings/symbols recovered from the
> actual binary (`BuildID edebff2c28de76238c95c299ba3401a9098c9e17`). Log lines quoted
> in `code` are verbatim from the binary. Inferences are marked *(inferred)*.

---

## 0. What it is, in one paragraph

`process_api` is a single static Rust/Tokio binary that is **PID 1** inside the
Firecracker microVM. It does three things: **(1)** boots the VM — mounts pseudo-filesystems,
makes device nodes, configures the network, mounts storage, injects the egress CA, drops a
capability, and restores from a snapshot; **(2)** exposes a **WebSocket "process server" on
TCP :2024** the host drives to run tool processes and stream their IO; **(3)** supervises
those processes — wall/CPU timeouts, a container OOM-killer, and zombie reaping. A separate
**control server on :2025** drives the snapshot/restore lifecycle. Critically, the binary
has **no notion of "tools"** — it only runs processes and streams bytes; the tool
vocabulary lives entirely on the host.

---

## 1. Binary facts

```
Path:     /process_api  (sole binary in the initramfs; rdinit=/process_api → PID 1)
Type:     ELF 64-bit x86-64, static-pie, stripped, ~4.4 MB
Language: Rust + Tokio (async); bundles hyper (HTTP/1.1), a WS stack, jsonwebtoken
          (ES256/EdDSA/HS/RS/PS), a zstd codec, and an HTTP client — zero shared libs
Source:   artifactory.infra.ant.dev cargo registry; tokio-vsock 0.7.2
BuildID:  edebff2c28de76238c95c299ba3401a9098c9e17
```

Reachable in a live VM as `/proc/1/exe`. Static-pie + stripped → no dynamic deps, no
symbols.

---

## 2. CLI / environment surface

clap parser; every flag has an env twin. Observed PID-1 cmdline:

```
/process_api --firecracker-init --addr 0.0.0.0:2024 \
             --max-ws-buffer-size 32768 --block-local-connections
```

| Flag | Env | Default | Effect |
|---|---|---|---|
| `--firecracker-init` | `FIRECRACKER_INIT` | — | run the VM-init path (PID-1 mode); enables `/mount_root` on the control server |
| `--addr` | — | **required** | TCP listen addr for the WS process server |
| `--max-ws-buffer-size` | `MAX_WS_BUFFER_SIZE` | 32768 | per-stream WS write-buffer bound (backpressure) |
| `--block-local-connections` | `BLOCK_LOCAL_CONNECTIONS` | false | reject WS clients from localhost / the VM's own IP |
| `--control-server-addr` | `CONTROL_SERVER_ADDR` | — | control-server TCP addr (`0.0.0.0:2025`); **when set, the SIGINT handler is disabled** (host owns shutdown) |
| `--listen-vsock-port` | `LISTEN_VSOCK_PORT` | — | serve WS over vsock (Firecracker native) |
| `--control-vsock-port` | `CONTROL_VSOCK_PORT` | — | serve control over vsock |
| `--listen-uds` | `LISTEN_UDS` | — | serve WS over a Unix socket (gVisor) |
| `--dial-uds` / `--host-uds=open` | `DIAL_UDS` | — | gVisor: dial out to a host UDS bridge instead of binding (§7.1) |
| `--memory-limit-bytes` | `MEMORY_LIMIT_BYTES` | — | container memory cap (observed: unset → unlimited) |
| `--cpu-shares` | `CPU_SHARES` | — | cgroup CPU shares/weight |
| `--oom-polling-period-ms` | `OOM_POLLING_PERIOD_MS` | 100 | OOM monitor poll interval |
| `--cgroupv2` | `CGROUPV2` | — | use the cgroup-v2 hierarchy |

Clap also emits `the following required argument was not provided: <addr|max_ws_buffer_size|
oom_polling_period_ms|cgroupv2|block_local_connections|firecracker_init>` if misconfigured.

### Process-wide signal setup
- **Ignores `SIGPIPE`** (`signal(SIGPIPE, handler) != SIG_ERR`, else aborts) — a closed
  stdout pipe must not kill PID 1.
- Registers `pthread_atfork` handlers (`libc::pthread_atfork failed with code …`) so forking
  children leaves the Tokio runtime consistent.
- Installs a `SIGINT` handler **only when no control server is configured**
  (`[DEBUG] SIGINT handler enabled (control server disabled)`).
- Carries the full signal-name table (SIGHUP…SIGSYS, SIGSTKFLT, SIGPWR) for `SendSignal`.

---

## 3. VM init — every boot route (`--firecracker-init`)

Banner: `[INIT] Starting Firecracker VM initialization...`. Help text, verbatim: *"Run as
Firecracker VM init (PID 1). Mounts /proc, /sys, /dev, sets up networking, then either reads
`/mount_config.json` (fresh boot) or waits for `POST /mount_root` (snapstart)."*

### 3.1 Filesystems & device nodes
```
[INIT] Mounting essential filesystems...
[INIT] Essential filesystems mounted
[INIT] devtmpfs remount restored device nodes
[INIT] Created device nodes via mknod        |  [INIT] WARNING: mknod /dev/fuse failed: …
[INIT] Creating /dev/fuse device node...      |  [INIT] /dev/fuse already exists
[INIT] Created /dev/fuse
```
Mounts `/proc`, `/sys`, `/dev` (devtmpfs), `/dev/shm`, `/dev/pts`; ensures `/dev/fuse`
exists (the FUSE backends need it). Reads `/proc/mounts`, `/proc/self/mountinfo`.

### 3.2 Networking & hostname
```
[INIT] Setting up networking...
[INIT] Network configured: IP=192.0.2.2/24, GW=192.0.2.1, MTU=1400
[INIT] FATAL: socket() failed: …            |  [INIT] sethostname failed: errno=…
```
Brings up `eth0` at `192.0.2.2/24`, default route via `192.0.2.1`, MTU 1400; sets hostname.

### 3.3 Environment
```
[INIT] ENV <k>=<v>
[INIT] Environment variables loaded
```
Loads the environment that spawned tool processes will inherit (including the CA-bundle
vars from §5).

### 3.4 Config: fresh boot vs snapstart (same `MountRootConfig` type)
```
# fresh boot (template creation)
[INIT] Fresh boot: reading /mount_config.json...
[INIT] Failed to parse container.env as JSON: …     # generic: absent OR invalid

# snapstart restore (every real conversation)
[INIT] Snapstart template mode: signaling ready...
 resumed from frozen full-checkpoint snapshot
SNAPSTART_READY
[INIT] Thawed /                                       # un-freeze rootfs after restore
```
On fresh boot it parses `/mount_config.json`; on snapstart it signals ready and waits for
`POST /mount_root` (§7). Config deserializes into `MountRootConfig` / `FuseMountConfig` /
`EtcFiles` / `TokenClaims`.

### 3.5 Mounting storage devices
```
[INIT] Mounted /dev/vda at /
[INIT] Mounted rclone_tools from <dev>        |  [INIT] WARNING: Failed to mount rclone_tools from …
[INIT] Model tools mounted from /dev/vdb       |  [INIT] WARNING: Failed to mount model tools: …
[INIT] Mounted readonly <dev> at <dest>        |  [INIT] WARNING: Readonly device … / rclone_tools device …
[INIT] filestore mount: dest=<…>               # FUSE: /mnt/user-data/*
[INIT] memory mount: dest=<…>                  # FUSE: the memory store  ← memory IS FUSE-mounted
[INIT] FUSE service_url: https://api.anthropic.com
[INIT] FUSE daemon(s) spawned in <dur>         |  [INIT] FUSE daemon spawn failed: …
[INIT] FUSE_MOUNT_STATUS count=<n>
[INIT] FUSE mount wait failed (non-fatal): …
rclone_tools ok; readonly_mounts ok; fuse_spawn FAILED;   # per-stage status summary
```
Notes recovered here:
- The `memory mount: dest=` code path **exists**, but **in-sandbox testing shows memory is
  RPC-only in a standard consumer session** — `memory_store_id` is `null` and no memory
  FUSE mount is present (see `12-memory-api.md`). The FUSE memory mount only materializes
  when the backend provisions a `memory_store_id` (memories enabled / other deployments).
- **Model tools come from `/dev/vdb`** (same squashfs as the rclone binary), mounted at
  `/mnt/sandboxing/model_tools_env/v1/python` **only when `mount_model_tools` is set** —
  which it is **not** in a standard session: live, `/mnt/sandboxing` does not exist at all.
  This is an operator/deployment feature.
- Readonly squashfs devices (skills) are mounted per `readonly_mounts` /
  `readonly_dev_start_index`.

### 3.6 Wait for mounts to be ready
```
[INIT] Waiting for ready_file(s)... (<paths>)
[INIT] All ready_file(s) found after <dur>
```
Init **blocks** until rclone signals its mounts are live (`/tmp/rclone-mounts/ready`) before
proceeding — so no tool can run against a half-mounted filesystem.

### 3.7 Capability drop *(security)*
```
[INIT] Dropped CAP_SYS_RESOURCE from bounding set
[INIT] FATAL: Failed to drop CAP_SYS_RESOURCE: …
```
process_api **deliberately drops `CAP_SYS_RESOURCE` from its own bounding set** via
`prctl(PR_CAPBSET_DROP, 24)` during init. Binary RE confirms:

- A **prctl dispatch wrapper** exists at ~`0x368f80`; it loads up to 5 args from a caller-
  supplied struct and issues `mov eax, 0x9d; syscall` (prctl = syscall 157). Three call sites.
- **Zero `capset()` syscall sites** in the binary — all capability management is through
  `prctl`, never the raw `capset` syscall.

The resulting capability split is intentional:

| | process\_api itself | every child exec |
|---|---|---|
| CapPrm/CapEff | has `sys_resource` | does not |
| **CapBnd** | **does NOT** have it | does not |

process_api retains `sys_resource` in its permitted/effective sets (it needs it to enforce
cgroup resource limits and use ext4 reserved blocks), but since it dropped it from its own
bounding set, the bounding set it inherits to children also lacks it. The bounding set is a
one-way ratchet — once dropped, no exec in the lineage can ever restore it (confirmed by
empirical tests: `F_SETPIPE_SZ` above `pipe-max-size` and hard-rlimit raises both return
`EPERM` in the tool shell). Full analysis in `07-security.md §7`.

### 3.8 Page cache + token scrub + status
```
drop_caches ok; config written; model_tools ok;
[INIT] Auth tokens scrubbed from config(s)
```
Writes `3` to `/proc/sys/vm/drop_caches`; scrubs `_TOKEN`/`_SECRET`/`_PASSWORD`/`API_KEY`
from configs.

### 3.9 Root pivot
```
[INIT] MS_MOVE+chroot ok                      # move mounts + chroot…
[INIT] pivot_root ok                          # …then pivot_root to ext4
[INIT] pivot_root failed (…)                  |  [INIT] FATAL: mount_root_and_pivot failed: …
[INIT] Removing non-directory at <p>          |  [INIT] WARNING: chown <p> …
```
Moves essential mounts and `pivot_root`s from the initramfs to the ext4 root; the old root
is left as an empty `/old_root`. `init_on_free=1` zeroes the freed initramfs pages.

### 3.10 Spawn services & complete
```
[INIT] Spawning: <cmd>     |  [INIT] Spawned <…>
[INIT] Setting up <…>
[INIT] Fresh boot init complete: <…>
[INIT] Firecracker init complete, starting process_api services...
```
After init, it starts the WS server, the control server, and the background monitors
(§9–§12).

---

## 4. cgroup setup (every route)

```
[DEBUG] Detected cgroup version: <1|2>
[DEBUG] process_api: current_controllers: <…>
[DEBUG] Enabled memory controller in process_api cgroup
[DEBUG] memory controller already enabled in process_api cgroup
[DEBUG] Failed to enable memory controller in process_api cgroup: …
[DEBUG] Set process_api/cgroup.procs permissions to 0o666
[DEBUG] Failed to set permissions on process_api/cgroup.procs: …
[DEBUG] Moved current process (PID <n>) …
 Removed cgroup directory  |  Failed to remove cgroup directory: …
Cgroup is not ready
Cgroup v2 detected but not enabled. Please use --cgroupv2 flag to enable cgroup v2 support
```
- Detects v1 vs v2 by reading `/sys/fs/cgroup/cgroup.controllers`. The observed VM is
  **cgroup v1**; if it sees v2 without `--cgroupv2`, it refuses to start.
- Creates `/sys/fs/cgroup/memory/process_api/<session-hash>/` (e.g.
  `…/7c751cd73d722821a209f67fe8ae768e/`), enables `+memory` in the subtree, **chmods
  `cgroup.procs` to `0o666`** so it can place children, and moves itself in.
- Reads usage via `memory.usage_in_bytes` (v1) / `memory.current` (v2); CPU via
  `cpu.shares` (v1) / `cpu.weight` (v2); `cpu.cfs_period_us`.
- Removes each child's cgroup dir on exit.
- In the captured VM all memory limits are `INT64_MAX` → the cgroup is for **measurement**
  (OOM), not a hard cap; the real ceiling is the VM's ~3 GB RAM.

---

## 5. Egress-CA injection — transparent MITM into *every* trust store

So the TLS-inspecting egress proxy is invisible to all runtimes, init installs the
`sandboxing-egress-ca` everywhere it can:

```
# system bundle
/etc/ssl/certs/sandboxing-egress-ca.pem ; /usr/local/share/ca-certificates/…
[INIT] WARNING: append_ca_cert failed: …

# Java JKS (keytool), across jvm/jre/sdkman paths, default password "changeit"
keytool -importcert -keystore <cacerts> -storepass changeit -noprompt -alias …
[INIT] cacerts at <p>  |  [INIT] keytool -importcert failed: …
[INIT] WARNING: cacerts write failed at <p>  |  "… not JKS v2 changeit and keytool unavailable/failed; skipped"
[INIT] WARNING: egress CA PEM unparseable; skipping JKS inject

# NSS DB (Chromium/Firefox): certutil into cert9.db / key4.db / pkcs11.txt
certutil -N -d <dir>            (create)
certutil -A -n <name> -t C,, -d <dir>   (add trusted CA)
paths probed: .pki/nssdb, .local/share/pki/nssdb
[INIT] certutil unavailable (…)  |  [INIT] WARNING: certutil -A failed at … / -N failed / -A wait failed

# Chrome/Firefox enterprise policies
[INIT] WARNING: chrome policies write failed at …  |  firefox policies write failed at …

# Python certifi
certifi/cacert.pem ; pip/_vendor/certifi/cacert.pem ; botocore/cacert.pem

# env vars exported for non-system TLS stacks
REQUESTS_CA_BUNDLE SSL_CERT_FILE SSL_CERT_DIR CURL_CA_BUNDLE NODE_EXTRA_CA_CERTS
GIT_SSL_CAINFO AWS_CA_BUNDLE HTTPLIB2_CA_CERTS CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE
NIX_SSL_CERT_FILE PIP_CERT  + NO_PROXY

# sudoers: keep those env vars across sudo
Defaults env_keep += "…"   → /etc/sudoers.d/…
[INIT] WARNING: sudoers env_keep write failed: …
```
The `sudoers env_keep` line is notable: it ensures the CA-bundle env vars **survive a
`sudo`**, so even privilege-changing tools still trust the proxy. This whole step is also
reachable post-restore via the control server's `/write_etc_files`.

---

## 6. Background monitors (started after init)

Three long-lived Tokio tasks run for the VM's lifetime:

1. **`monitor_orphans`** — PID-1's reaper. Adopts processes re-parented to PID 1 and reaps
   zombies: `Found orphan process …`, `Failed to adopt orphan process …`, `Found new
   zombie PID …`, `Reaping zombie PID …`, `Reaping tracked orphaned zombie …`,
   `monitor_orphans: Received shutdown signal, exiting`.
2. **`container_oom_monitor`** — the container OOM-killer (§12).
3. **`per_process_memory_monitor`** — per-process memory checks
   (`per_process_memory_monitor: Failed to check memory usage for process …`).

---

## 7. The two listeners & transports

### 7.1 Transport modes
- **TCP** (observed): WS `0.0.0.0:2024`, control `0.0.0.0:2025`.
- **vsock** (Firecracker native): `--listen-vsock-port` / `--control-vsock-port`; rejects
  non-host CIDs (`[SECURITY] Rejecting vsock connection from non-host CID …`,
  `[CONTROL] [SECURITY] Rejected connection from non-host CID …`).
- **gVisor UDS bridge**: `--listen-uds`, or `--dial-uds`/`--host-uds=open` where init dials
  out to a host UDS because `bind()` on gofer paths is unreachable; the host-side Router
  sends the HTTP Upgrade so the direction reversal is transparent to the WS handler
  (`[DEBUG] --dial-uds enabled: …`, `dial-uds not ready (…)`).

dp_mtls fallback string: `restored on a server without dp_mtls. TCP :2024 remains
available.` — the transport may be plaintext, but app-layer auth still applies (§8).

### 7.2 Control server (:2025) — every endpoint/route
```
[CONTROL] Control server listening on <addr> | on vsock port <n>
[CONTROL] Failed to bind control server to <addr> | to vsock port <n>
[CONTROL] Error serving connection: …  | Failed to accept connection: …
[CONTROL] Failed to read request body: …  | Invalid UTF-8 in request body: …
[CONTROL] [SECURITY] Rejected connection from <ip> | non-host CID <n>
```
| Route | Log lines | Purpose |
|---|---|---|
| `POST /mount_root` | `Received mount_root request`; `mount_root succeeded/failed/task panicked` | apply per-session `MountRootConfig` after restore |
| `/auth_public_key` | `Auth public key set successfully`; `Invalid auth public key:`; `Failed to persist auth key to container_info.json:` | install the **Ed25519** WS-verification key (§8); also persisted to `/container_info.json` |
| `/write_etc_files` | `/write_etc_files: hosts <…>`; `append_ca_cert failed:`; `write failed:` | (re)write `/etc/resolv.conf`, `/etc/hosts`, append egress CA |
| `/fs_freeze` | `/fs_freeze: freezing / ...`; `done (frozen <…>)`; `FIFREEZE failed, returning 500`; `/ already frozen (EBUSY)`; `open(/) failed:` | `FIFREEZE` ioctl the rootfs for a clean snapshot |
| `/fs_thaw` | `/fs_thaw: thawing / ...`; `done`; `failed, returning 500`; `/ was not frozen (EINVAL), nothing to thaw`; `open(/) for thaw failed:` | `FITHAW` the rootfs after snapshot/restore |
| clock sync | `Clock synced (unix_nanos=<…>)`; `clock_settime failed:` | set wall clock from `realtime_unix_nanos` |
| drop caches | `Dropping page caches...` | drop the template page cache |
| container name | `Received … ; Updated container name to: <…>`; `Failed to persist container name to container_info.json:` | **not a route** — set via the `expected_container_name` field in the WS `ProcessConnection` handshake and persisted to `/container_info.json` |
| shutdown | `Received shutdown request via HTTP`; `Shutdown signal sent successfully`; `Failed to send shutdown signal:`; `Control server shutting down`; `shutdown complete` | graceful stop |

**Inferred restore order:** clock sync → `/auth_public_key` → `/write_etc_files` →
`POST /mount_root` → container name → drop caches → `/fs_thaw` → ready.

---

## 8. WS process server (:2024) — connection & auth routes

```
[DEBUG] New WebSocket connection from <peer>
[SECURITY] Blocking connections from local IPs: <…>
[SECURITY] Rejected WebSocket connection from local IP <ip>
[DEBUG] Failed to get first message: …
Empty first message
[DEBUG] Received ProcessConnection JSON (no JWT)
[DEBUG] Received JWT token, verifying...
[DEBUG] JWT verified successfully: sub='<…>'
[DEBUG] JWT verification failed: …
[DEBUG] No auth public key loaded, accepting JWT without verification   ← fail-open
[DEBUG] Failed to get ProcessConnection after JWT: …
Invalid JWT signature | JWT token has expired | Invalid JWT claims
First message should be text json CreateProcess
Client closed connection after JWT
Second message after JWT should be text json CreateProcess
```
Routes:
1. If `--block-local-connections`, drop peers from localhost / the VM's own IP first.
2. Read the **first text message** and branch on the first byte: `'{'` → a
   `ProcessConnection` JSON (no JWT); `'e'` (`eyJ…`) → a **JWT** to verify.
3. **JWT verification** uses the **Ed25519** key installed via `/auth_public_key` →
   algorithm **EdDSA**. Claims are a minimal `TokenClaims` = `sub`, `iat`, `exp` (distinct
   from the ES256 filestore JWT in doc 10). **Fail-open:** with no key loaded, the JWT is
   accepted unverified — so in the no-dp_mtls path `--block-local-connections` is the
   effective guard.
4. After auth, the next text message must be `CreateProcess`.
5. Capabilities negotiated (V2): `supports_trace` (emit `TraceEvent`), `supports_zstd`
   (compress stdio).

---

## 9. Process management routes

```
[DEBUG] Processing reattach request for process_id: <id>
[DEBUG] Adding process <id>
[DEBUG] Process with same ID already running: <id>
[DEBUG] Process already attached: <id>
[DEBUG] Process not found: <id>
[DEBUG] Reattachable process <id> …
[DEBUG] Non-reattachable process, killing and removing from map: <id>
[DEBUG] Detaching process: <id>
[DEBUG] Moved current process (PID <n>) …       # into the cgroup
[DEBUG] Error starting process: …
[DEBUG] Current process map: <…>
[DEBUG] Handling process cleanup for <id>  |  After cleaning up process <id>
[DEBUG] forward_stdin: Starting stdin forwarding for process <id>
[DEBUG] wait_for_child_to_exit … / Exiting wait_for_child_to_exit for process <id>
[DEBUG] process_ws_message: Starting/Finished WebSocket message processing for process <id>
[DEBUG] process_ws_message returned: … / failed: …
[DEBUG] bad control msg from ws: …
```

### 9.1 `CreateProcess` fields (struct)
```
process_id   string   validated: non-empty, length-bounded, no control chars,
                       must NOT contain the trace marker "##TRACE##"
uid, gid     int      drop to this user/group
cwd          string   chdir before exec  ("chdir <dir>")
clear_env    bool     start from empty env …
env_vars     map      … plus these (token-like vars scrubbed)
timeout      duration wall-clock limit
cpu_timeout  duration CPU-time limit (falls back to wall-clock if unenforceable)
reattachable bool     survive WS disconnects
allow_process_id_reuse bool
```
**Empirically confirmed values (from pcap of live exchange):**
- `name = "/bin/sh"` (not bash — explains why `disown` is unavailable in tool sessions)
- `timeout = 300 s` (5 minutes per tool call — the command-level limit, separate from the
  30 s OOM-kill window for runaway processes)
- `clear_env = false` (env fully inherited from process_api's environment)
- `memory_limit_bytes = null` (no per-process byte cap beyond the cgroup)
- Top-level fields also include `expected_container_name` (security check) and `accept_zstd`
Internals: a `ProcController`/`ProcHandle` with channels (`exit_status_tx/rx`,
`oom_killed_tx/rx`, `stop_waiting_tx/rx`); fork/exec; move into the session cgroup; record
`ProcessInfo { pid, start_time, start_wallclock_micros, cmd_summary, stdin_bytes,
stdout_bytes, stderr_bytes, trace_emitted, trace_outcome }`.

Replies: `ProcessCreated` / `ProcessCreatedV2`; `FailedToStartProcessWithSameId`;
`RunningInfraError`.

### 9.2 Reattach (how shells persist across turns)
A client connecting with an existing **reattachable** id re-binds the streams instead of
spawning: `AttachedToProcess` / `AttachedToProcessV2`; `ProcessAlreadyAttached` (another
connection holds it); `ProcessNotRunning` (gone). This is how a bash session keeps its cwd,
env, and background jobs across separate tool-call roundtrips.

---

## 10. Streaming IO

- **Output**: child stdout/stderr framed as `ExpectStdOut`/`ExpectStdErr` then
  `StdOutEOF`/`StdErrEOF`. Writes bounded by `max_ws_buffer_size` via a `BoundedSink`
  (backpressure). `[DEBUG] stdout/stderr EOF`.
- **Input**: host sends `ExpectStdIn` + a **binary** frame (`stdin frame decode`,
  `Expected binary message after ExpectStdIn`, `No message received after ExpectStdIn`,
  `Error receiving message after ExpectStdIn`), then `StdInEOF`.
- **zstd**: if `supports_zstd` negotiated, stdio payloads are zstd stream
  compressed/decompressed (`ZSTD_c_windowLog`, `ZSTD_d_windowLogMax`).
- PID 1 holds the child stdio over **pipes** (`/proc/1/fd`) rather than `/dev/console`.

---

## 11. Limits, signals, capabilities, seccomp

### 11.1 Timeouts
- Wall-clock → `ProcessTimedOut`.
- CPU → `ProcessCpuTimedOut` (`exceeded cpu_timeout of <n>`; *"cpu_timeout not enforced,
  falling back to wall-clock timeout only"* when cgroup CPU accounting isn't usable).

### 11.2 Signals
`SendSignal` → `SignalSent` | `InvalidSignal` (bad number) | `FailedToSendSignal`. Full
signal-name table embedded.

### 11.3 Capabilities
```
CapEff observed: 0x000001fffeffffff   → only CAP_SYS_RESOURCE missing
[INIT] Dropped CAP_SYS_RESOURCE from bounding set
```
The missing bit is **not** a host default — process_api **drops `CAP_SYS_RESOURCE` itself**
during init (§3.7). Everything else (CAP_SYS_ADMIN, PTRACE, MODULE, RAWIO…) remains, by
design: the VM boundary is the real isolation, so in-VM caps are mostly irrelevant — except
RESOURCE, which it drops so resource limits can't be bypassed.

### 11.4 Seccomp
None (`Seccomp: 0`). No syscall filtering — same rationale.

---

## 12. The container OOM monitor (full algorithm)

A dedicated task polling every `--oom-polling-period-ms` (100 ms):
```
loop:
  [DEBUG] container_oom_monitor: Adopting orphans before memory scan...
  [DEBUG] container_oom_monitor: Container memory usage <X>
  if under pressure:
     [DEBUG] container_oom_monitor: Reading fresh memory usage for ALL processes to find largest...
     pick largest-RSS process
     [DEBUG] container_oom_monitor: Killing process <id>           # SIGKILL the tree
     [DEBUG] Killing process tree OOM killed process <id>
     Phase 1: wait → [DEBUG] container_oom_monitor: Phase 1 timed out: process <pid>
     [DEBUG] container_oom_monitor: Waiting for killed process <pid>
              [DEBUG] container_oom_monitor: Timed out 30s after killing <…>    # hard cap
     [DEBUG] container_oom_monitor: Killed process <id>
     [DEBUG] container_oom_monitor: Memory reclaimed to <Y>
     write oom_killed.log  ("[OOM_KILL] process_id=…")
        (errors: Failed to create directory / open / write to OOM killed log for process …)
     notify host: ProcessOutOfMemory(id) or ContainerOutOfMemory
        (errors: Failed to notify kill / send OOM notification / No channel available …)
  on shutdown:
     container_oom_monitor: Received shutdown signal, exiting container_oom_killer
     container_oom_monitor: Received shutdown signal during post-kill wait, exiting
```
Because the cgroup limit is effectively infinite, this **user-space, whole-container
OOM-killer** (not the kernel's) is what fires: it adopts orphans each cycle (so nothing
escapes accounting by re-parenting), targets the **largest** consumer, kills the **whole
process tree**, escalates with a 30s cap, then reports.

---

## 13. Message protocol reference

**Client → server:** `CreateProcess`, `SendSignal`, `ExpectStdIn`, `StdInEOF`.

**Server → client:** `ProcessCreated`, `ProcessCreatedV2`, `AttachedToProcess`,
`AttachedToProcessV2`, `ProcessNotRunning`, `ProcessAlreadyAttached`,
`FailedToStartProcessWithSameId`, `RunningInfraError`, `ExpectStdOut`, `StdOutEOF`,
`ExpectStdErr`, `StdErrEOF`, `ProcessExited`, `ProcessTimedOut`, `ProcessCpuTimedOut`,
`ProcessOutOfMemory`, `ContainerOutOfMemory`, `InvalidSignal`, `FailedToSendSignal`,
`SignalSent`, `ShuttingDown`, `TraceEvent`.

Dispatch: `process_ws_message: Shutting down | Timeout | CpuTimeout | OOM | Container OOM`.

---

## 14. Shutdown

Triggered by the control server's `/shutdown` (or `SIGINT`, only when no control server is
configured). Routes: `got shutdown channel rx` → emit `ShuttingDown` to clients → stop
accepting → monitors exit (`monitor_orphans … exiting`, `container_oom_monitor … exiting`)
→ control server `shutdown complete`. The host then tears down the VM; `init_on_free=1`
zeroes freed pages (any secret remnants) as it dies.

---

## 15. It does NOT know about tools

Grepping the binary for tool names returns **nothing** — not `present_files`,
`local_resource`, `ask_user_input`, *nor even* `bash_tool`, `create_file`, `str_replace`,
`view`. process_api implements only a generic process protocol (`CreateProcess` /
`process_id` / stdio). The host maps every execution tool into `CreateProcess` calls and
handles all virtual/UI tools itself; they never enter the VM (see `13-present-files.md`).

**Live-confirmed concrete shape (in-sandbox `/proc` inspection):** a `bash_tool` call lands as
`execve("/bin/sh", ["-c", <cmd>], env)` — a **direct PID-1 child**, `/bin/sh → dash` (not
bash), running as **uid 0/gid 0**, inheriting process_api's (token-scrubbed) env.
Reattachable shells persist as PID-1 children across turns. `create_file`/`str_replace`/
`view` follow the same `dash -c` pattern (sometimes a small Python one-liner). So bash-only
syntax needs an explicit `/bin/bash -c`.

---

## 16. End-to-end: a single `bash` tool call

```
model emits a bash tool_use (host side)
      │
host orchestration ──HTTP Upgrade──▶ process_api :2024
      │  ◀── block-local check; first msg = JWT → Ed25519 verify (sub=…)
      ├── text: CreateProcess { process_id:"bash-7", uid:1000, cwd:"/home/claude",
      │                          reattachable:true, timeout, cpu_timeout, env_vars }
      │        fork/exec → move into cgroup → arm wall+cpu timers → record ProcessInfo
      │   ◀── ProcessCreatedV2
      ├── text: ExpectStdIn + binary "ls -la\n"           (zstd if negotiated)
      │   ◀── ExpectStdOut <frames…> ◀── StdOutEOF
      │   ◀── ProcessExited{status:0}   (or ProcessTimedOut / ProcessCpuTimedOut / ProcessOutOfMemory)
      ▼
host returns captured stdout as the tool_result
```
Next turn: a new WS connection `AttachedToProcessV2` re-binds the **same** `bash-7` shell.
Meanwhile `monitor_orphans` reaps zombies, `container_oom_monitor` polls memory, the
control server stands ready, and rclone keeps `/mnt/user-data/*` (and the memory store)
FUSE-mounted. process_api never knew this was a "bash tool" — it ran a process and streamed
bytes.

---

### Cross-references
Snapstart lifecycle: `03-snapstart.md` · WS protocol: `05-websocket-protocol.md` · network
& CA: `06-network.md` · security model: `07-security.md` · storage/rclone: `08` · JWTs:
`10` · memory: `12` · virtual tools: `13` · observed live state: `17`.
