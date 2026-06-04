# Observed Runtime State

> Live snapshot from the captured `runtime/` artifacts (`ps-aux`, `proc-1-fd`,
> `proc-net-tcp`, `cgroup-limits`, `proc-mounts`). This is the steady-state of a real
> session — useful as ground truth for the architecture described in docs 04–08.

## Userspace processes — there are only two

```
PID    CMD
1      /process_api --firecracker-init --addr 0.0.0.0:2024 \
                    --max-ws-buffer-size 32768 --block-local-connections
489    /opt/rclone/rclone-filestore multimount --config /tmp/rclone-mount-config.json
```

That's the entire userspace (plus kernel threads). **No systemd, no shell daemon, no
agent process.** `process_api` *is* PID 1 and it spawns exactly one long-lived child:
the rclone multimount that backs `/mnt/user-data/*` and `/mnt/transcripts`.

- Bash/tool processes are **not** persistent — `process_api` forks them on demand when
  the host sends `CreateProcess` over the `:2024` WebSocket, so they don't appear in a
  steady-state `ps`.
- rclone: `VSZ 1.9 GB` (Go runtime address reservation), `RSS ~34 MB` actual.

### PID 1 open file descriptors
`0/1/2 → /dev/console`; `epoll`/`eventfd` (Tokio reactor); several listening/accepted
**sockets**; and **pipes to rclone's stdout/stderr** — i.e. `process_api` captures its
child's stdio rather than letting it write to console directly.

## Live sockets (`/proc/net/tcp` decoded)

| Local | Remote | State | Meaning |
|---|---|---|---|
| `0.0.0.0:2024` | — | LISTEN | WebSocket tool-execution server |
| `0.0.0.0:2025` | — | LISTEN | control server (TCP in this deployment) |
| `192.0.2.2:2024` | `192.0.2.1:46166` | TIME_WAIT | a finished host tool connection |
| `192.0.2.2:2024` | `192.0.2.1:42020` | TIME_WAIT | a finished host tool connection |
| `192.0.2.2:2024` | `192.0.2.1:44106` | ESTABLISHED | the **current** host ↔ VM tool channel |
| `192.0.2.2:45802` | `160.79.104.10:443` | ESTABLISHED | rclone's **single persistent HTTPS** to `api.anthropic.com` (via egress proxy) |

Reading: the **host (`192.0.2.1`) is the only client** of port 2024, and it opens a
fresh connection per tool roundtrip (hence the TIME_WAITs alongside one ESTABLISHED).
The only outbound flow is rclone's one keep-alive connection to the filestore/memory
API. Control server `:2025` is listening on TCP, confirming the no-`dp_mtls` fallback.

TCP state codes: `01`=ESTABLISHED, `06`=TIME_WAIT, `0A`=LISTEN.

## cgroups (v1)

Per `proc-self-cgroup`, the session lives under a hashed memory cgroup:
`/sys/fs/cgroup/memory/process_api/7c751cd73d722821a209f67fe8ae768e/`.

**All memory limits are `INT64_MAX` (unlimited):**
```
memory.limit_in_bytes        = 9223372036854771712
memory.memsw.limit_in_bytes  = 9223372036854771712
memory.kmem.limit_in_bytes   = 9223372036854771712
memory.kmem.tcp.limit_in_bytes = 9223372036854771712
```
So memory is **not** capped at the cgroup level — the real ceiling is the microVM's
physical RAM (~3 GB, doc 02). The per-session cgroup exists mainly so `process_api`
can **poll** usage for OOM detection (doc 04), not to enforce a hard limit here.
(`--memory-limit-bytes`/`--cpu-shares` exist but aren't applying a finite cap in this
session.)

## Architecture, end to end

```
        host orchestration (192.0.2.1)
            │  WS :2024 (per-turn)         ▲ control :2025 (snapstart lifecycle)
            ▼                               │
   ┌────────────────────────────────────────────────┐
   │ microVM 192.0.2.2                                │
   │   PID 1  process_api ──forks──▶ bash/tool procs  │
   │      │ spawns + pipes stdio                      │
   │      ▼                                           │
   │   PID 489 rclone multimount ──┐                  │
   │   FUSE: /mnt/user-data/{outputs,uploads,         │
   │         tool_results}, /mnt/transcripts          │
   └───────────────────────────────┼──────────────────┘
                                    ▼ one persistent TLS
                       160.79.104.10:443  api.anthropic.com
                       (filestore + memory, via egress MITM proxy)
```
