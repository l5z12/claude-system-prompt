# WebSocket Tool Execution Protocol

## Connection

The host (192.0.2.1) connects to the VM (192.0.2.2:2024) over TCP WebSocket.

In production, the transport uses **dp_mtls** (dataplane mutual TLS). When restored on a
host without it, the transport falls back to plain TCP:

```
restored on a server without dp_mtls. TCP :2024 remains available.
```

**…but the application layer still authenticates.** Even without dp_mtls, the WS
handshake is gated by an **EdDSA (Ed25519) JWT** that `process_api` verifies (see
Handshake). So "plain TCP" describes only the *transport*, not "unauthenticated."

## Handshake & app-layer auth

The first WebSocket message can be **either** an auth JWT or a `ProcessConnection`
JSON directly. `process_api` branches on the first byte: `'{'` → JSON, `'e'` → a JWT
(`eyJ…`). Verified strings:

```
[DEBUG] Received JWT token, verifying...
[DEBUG] JWT verified successfully: sub='...'
[DEBUG] JWT verification failed: ...
[DEBUG] No auth public key loaded, accepting JWT without verification   ← fail-open
Invalid JWT signature / JWT token has expired / Invalid JWT claims
Empty first message
```

- The verification key is the **Ed25519 public key installed via the control server's
  `/auth_public_key` endpoint** (`Auth public key must be exactly 32 bytes (raw
  Ed25519)`). If no key was installed, the JWT is **accepted without verification**
  (fail-open).
- **In-sandbox check — the wiggle cluster is fail-open in practice.** Its
  `/container_info.json` has **no `auth_public_key` field** (only `container_name`), so at
  startup `[WARN] Failed to load auth key:` fires and every handshake takes the
  `No auth public key loaded, accepting JWT without verification` path. Equivalently, a
  first message that is plain `ProcessConnection` JSON (`{…`) skips JWT entirely. So on
  this cluster the **only** access control on :2024 is `--block-local-connections`; the
  Ed25519 design exists but isn't armed here (it's redundant on dp_mtls clusters and was
  simply not provisioned on wiggle).
- The auth JWT's claims are a minimal `struct TokenClaims with 3 elements` = **`sub`,
  `iat`, `exp`** — distinct from the ES256 filestore JWT (doc 10). The embedded
  `jsonwebtoken` validator supports ES256/EdDSA/HS*/RS*/PS*, but the installed key here
  is Ed25519 → **EdDSA**.

Sequence:
1. Host opens a **fresh TCP connection + HTTP Upgrade per tool call** (not a persistent WS).
   Each tool call → new TCP SYN from the host → HTTP `GET / HTTP/1.1` Upgrade.
2. **HTTP Upgrade headers carry the JWT** in production: `Authorization: Bearer <JWT>`
   (EdDSA signed by the sandbox gateway). The first-byte branching ('{' / 'e') described
   above is the fallback for direct connections — on the wiggle cluster it never triggers
   because process_api is fail-open (no auth key loaded), and the gateway sends via HTTP
   header anyway.
3. After the 101 Switching Protocols, the **first WS text message** from the host is the
   `ProcessConnection` JSON (not the JWT — that was already in the HTTP header):
   ```json
   {
     "process_id": "<uuid>",
     "create_req": {
       "name": "/bin/sh", "uid": 0, "gid": 0,
       "args": ["-c", "<the exact bash command>"],
       "clear_env": false, "env_vars": {},
       "timeout": 300,
       "memory_limit_bytes": null,
       "reattachable": false,
       "allow_process_id_reuse": false
     },
     "expected_container_name": "container_<REDACTED>--<REDACTED>--<REDACTED>",
     "accept_zstd": true
   }
   ```
   Note: shell is `/bin/sh` (not bash), **timeout = 300 s** (5 min), env NOT cleared.
4. process_api responds: `{"ProcessCreatedV2":{"supports_trace":true,"supports_zstd":true}}`
5. Process runs. On completion, the exact output sequence (confirmed by pcap):
   ```
   proc_api→host: "StdErrEOF"          (text, stderr already closed — stderr sent earlier if any)
   proc_api→host: "ExpectStdOut"        (text, stdout is coming)
   proc_api→host: [BIN frame]           (binary: 3-byte prefix + raw stdout bytes)
   proc_api→host: "StdOutEOF"          (text)
   proc_api→host: {"ProcessExited": 0} (text JSON, exit code)
   host→proc_api: WS CLOSE 1000        (normal closure)
   proc_api→host: WS CLOSE 1000
   ```
6. TCP FIN exchange — connection fully closed. Next tool call → new TCP SYN (step 1).

```
First message should be text json CreateProcess
Client closed connection after JWT
Second message after JWT should be text json CreateProcess
```

## Message Types (Server → Client)

Full enum discovered from binary strings:

| Message | Meaning |
|---|---|
| `ProcessCreated` | Process successfully spawned |
| `ProcessCreatedV2` | V2 spawn ack (with capability negotiation) |
| `AttachedToProcess` | Reconnected to existing reattachable process |
| `AttachedToProcessV2` | V2 attach (with capability negotiation) |
| `ProcessNotRunning` | Requested process doesn't exist |
| `ProcessAlreadyAttached` | Another connection already attached |
| `FailedToStartProcessWithSameId` | process_id collision |
| `RunningInfraError` | Infrastructure error during execution |
| `ExpectStdOut` | Stdout data follows |
| `StdOutEOF` | Stdout closed |
| `ExpectStdErr` | Stderr data follows |
| `StdErrEOF` | Stderr closed |
| `ProcessExited` | Process terminated normally |
| `ProcessTimedOut` | Wall-clock timeout exceeded |
| `ProcessCpuTimedOut` | CPU time limit exceeded |
| `ProcessOutOfMemory` | Process exceeded memory limit |
| `ContainerOutOfMemory` | Container-level OOM |
| `InvalidSignal` | Bad signal number |
| `FailedToSendSignal` | Signal delivery failed |
| `SignalSent` | Signal delivered |
| `ShuttingDown` | VM is shutting down |
| `TraceEvent` | Distributed tracing event |

## Message Types (Client → Server)

| Message | Meaning |
|---|---|
| `CreateProcess` | Spawn a new process |
| `SendSignal` | Send signal to running process |
| `ExpectStdIn` | Send stdin data |
| `StdInEOF` | Close stdin |

## Connection Capabilities

Negotiated at connect time (V2):

```
supports_traces   bool  — distributed tracing enabled
supports_zstd     bool  — zstd compression for payloads
```

## ProcessInfo Fields

Included in process lifecycle events:

```
pid                   int
start_time            timestamp
start_wallclock_micros int64
cmd_summary           string   (truncated command for logging)
stdin_bytes           int64
stdout_bytes          int64
stderr_bytes          int64
trace_emitted         bool
trace_outcome         string
```

## Stdin Framing

Binary stdin frames use a specific decode protocol:
```
stdin frame decode
Expected binary message after ExpectStdIn
No message received after ExpectStdIn
Error receiving message after ExpectStdIn
```

## Trace Events

The `TraceEvent` message carries distributed tracing data (likely OpenTelemetry spans) for observability into tool execution timing and errors.

## Control Server (Port 2025)

Separate HTTP server on port 2025. This is **the snapshot/restore lifecycle API** —
the host drives it to turn a frozen, generic template VM into a session-specific one.
Endpoints/actions below are all confirmed from `[CONTROL]`/`[DEBUG]` log strings in
the binary (this corrects the earlier "only `/mount_root`" description).

| Endpoint / action | Evidence | Purpose |
|---|---|---|
| `POST /mount_root` | `mount_root succeeded/failed/task panicked` | apply the per-session mount config (mounts, IDs, auth token) after restore |
| `/auth_public_key` | `Auth public key set successfully` | install the public key used to authenticate the session/host |
| `/write_etc_files` | `/write_etc_files: append_ca_cert failed` | write `/etc/resolv.conf`, `/etc/hosts`, append the egress CA |
| `/fs_freeze` | `/fs_freeze: freezing / ...`, `done (frozen ...)`, `already frozen (EBUSY)` | `FIFREEZE` ioctl the rootfs so the template snapshots clean (pre-snapshot) |
| `/fs_thaw` | `/fs_thaw: thawing / ...`, `done`, `was not frozen (EINVAL)` | `FITHAW` the rootfs after the snapshot/restore |
| clock sync | `Clock synced (unix_nanos=...)`, `clock_settime failed` | correct the wall clock after restore (from `realtime_unix_nanos`) |
| drop caches | `Dropping page caches...` | drop the template's page cache |
| `POST /shutdown` | `Received shutdown request via HTTP`, `Shutdown signal sent successfully` | graceful shutdown |

Container naming is **not** a control route. The control server exposes **six** endpoints
(`/mount_root`, `/auth_public_key`, `/write_etc_files`, `/fs_freeze`, `/fs_thaw`,
`/shutdown`); the per-conversation name arrives as the `expected_container_name` field in the
WS `ProcessConnection` handshake and is validated/persisted to `/container_info.json`
(`Updated container name to:` / `Container name mismatch: expected '…'`).

### Inferred snapstart sequence

```
build template VM → /fs_freeze (FIFREEZE) → Firecracker snapshot
   ↓ (restore, per conversation)
clock sync → /auth_public_key → /write_etc_files → POST /mount_root
   → set container name → drop page caches → ready
```

### Shutdown

Handles graceful shutdown signals. When `--control-server-addr` is set, the `SIGINT`
handler is disabled to prevent duplicate shutdown signals
(`[DEBUG] SIGINT handler enabled (control server disabled)` is logged only in the
no-control-server case).
