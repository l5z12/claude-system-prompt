# process_api — The VM Init Process

## Binary

```
Path:     /process_api  (in initramfs; accessible via /proc/1/exe)
Type:     ELF 64-bit LSB pie executable, x86-64, static-pie linked, stripped
Size:     ~4.4 MB
Language: Rust (async, built on Tokio)
Source:   Anthropic internal repo (artifactory.infra.ant.dev)
BuildID:  edebff2c28de76238c95c299ba3401a9098c9e17
```

The binary is **static-pie linked** (no shared libraries) and **stripped** (no debug symbols). It's the only binary in the initramfs.

## Invocation

```sh
/process_api --firecracker-init --addr 0.0.0.0:2024 --max-ws-buffer-size 32768 \
             --block-local-connections
```

### All Known Flags

| Flag | Env Var | Default | Description |
|---|---|---|---|
| `--firecracker-init` | `FIRECRACKER_INIT` | — | Run as Firecracker VM PID 1 |
| `--addr` | — | — | TCP address for WebSocket server (e.g. `0.0.0.0:2024`) |
| `--max-ws-buffer-size` | `MAX_WS_BUFFER_SIZE` | 32768 | Max WebSocket write buffer |
| `--block-local-connections` | `BLOCK_LOCAL_CONNECTIONS` | false | Reject connections from `127.x` and own IP |
| `--listen-vsock-port` | `LISTEN_VSOCK_PORT` | — | Listen on vsock instead of TCP (Firecracker alt mode) |
| `--control-vsock-port` | `CONTROL_VSOCK_PORT` | — | Control server on vsock |
| `--control-server-addr` | `CONTROL_SERVER_ADDR` | — | Control server TCP addr (e.g. `0.0.0.0:2025`) |
| `--listen-uds` | `LISTEN_UDS` | — | Listen on Unix domain socket (gVisor mode) |
| `--memory-limit-bytes` | `MEMORY_LIMIT_BYTES` | — | Container memory limit |
| `--cpu-shares` | `CPU_SHARES` | — | CPU shares for cgroup |
| `--oom-polling-period-ms` | `OOM_POLLING_PERIOD_MS` | 100 | OOM check interval |

## Ports

| Port | Protocol | Purpose |
|---|---|---|
| 2024 | TCP/WebSocket | Tool execution — host connects here to run bash, manage processes |
| 2025 | TCP/HTTP | Control server — graceful shutdown, container name updates, `POST /mount_root` |

`--block-local-connections` ensures only the host (192.0.2.1) can connect to port 2024. Processes inside the VM cannot reach it.

## Supported Runtimes

process_api supports three container runtimes (selectable at deployment):

1. **Firecracker** — current mode. Uses TCP WebSocket. `--firecracker-init` sets up the VM.
2. **gVisor** — uses Unix domain socket bridge (`--listen-uds`). The host side dials a UDS bridge; the connection is handed to the WebSocket handshake.
3. **runc** — standard OCI containers. process_api has no effect on rootfs setup (host does it).

## Security Responsibilities

- **Auth token injection**: writes auth tokens into rclone config at startup
- **Auth token scrubbing**: immediately scrubs `_TOKEN`, `_SECRET`, `_PASSWORD`, `API_KEY` from all configs and spawned process environments
- **`/proc/sys/vm/drop_caches`**: writes `3` at startup to clear page cache from snapshot template
- **OOM monitoring**: polls cgroup memory usage every 100ms; kills OOM'd processes and notifies host
- **Local connection blocking**: rejects WebSocket connections from localhost/VM's own IP

## Process Lifecycle Management

Processes are identified by a `process_id` string. Key struct fields in `CreateProcess`:

```
process_id          string
uid                 int
gid                 int
timeout             duration (wall clock)
cpu_timeout         duration (CPU time)
clear_env           bool
reattachable        bool    -- host can reconnect to this process across turns
allow_process_id_reuse bool
env_vars            map[string]string  -- additional environment variables
```

`reattachable` processes persist between WebSocket connections — this is how bash sessions survive across tool call roundtrips in a conversation.

## OOM Monitor

```
container_oom_monitor: Container memory usage X
container_oom_monitor: Memory reclaimed to X
container_oom_monitor: Killed process X
killed by container OOM killer
oom_killed.log  (written on OOM events)
```

Polls the process's memory cgroup at configurable intervals. On OOM:
1. Kills the process tree
2. Writes to `oom_killed.log`
3. Sends `ProcessOutOfMemory` or `ContainerOutOfMemory` event over WebSocket

## Cgroup Setup

```
/proc/self/cgroup:
7:pids:/
6:blkio:/
5:freezer:/
4:devices:/
3:memory:/process_api/<REDACTED>
2:cpuacct:/
1:cpu:/
0::/
```

Uses cgroupv1. Memory cgroup path includes a hash unique to the session.

## Capabilities

```
CapEff: 0x000001fffeffffff
```

Only `CAP_SYS_RESOURCE` (bit 24) is absent. Everything else is present, including:
- `CAP_SYS_ADMIN` — full system administration
- `CAP_SYS_PTRACE` — can ptrace any process
- `CAP_SYS_MODULE` — can load kernel modules (though `nomodule` cmdline prevents it)
- `CAP_SYS_RAWIO` — raw I/O access (including `/dev/mem`)

This is intentional: the security boundary is the VM, not Linux capabilities.

## Seccomp

None. `Seccomp: 0`. No syscall filtering at all.

## Virtual Tool Handling

**process_api does NOT handle virtual tools** like `present_files`, `ask_user_input`, `message_compose_v1`, etc. These are intercepted by Anthropic's API orchestration layer before reaching the VM. process_api only handles execution tools: `bash_tool`, `create_file`, `str_replace`, `view`.
