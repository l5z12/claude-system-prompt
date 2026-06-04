# WebSocket Tool Execution Protocol

## Connection

The host (192.0.2.1) connects to the VM (192.0.2.2:2024) over TCP WebSocket.

In production, this connection uses **dp_mtls** (dataplane mutual TLS) for authentication. In this deployment, plain TCP is used as fallback:

```
restored on a server without dp_mtls. TCP :2024 remains available.
```

## Handshake

1. Host connects via HTTP Upgrade to WebSocket
2. First message: **text JSON** — JWT authentication
3. Second message: **text JSON** — `CreateProcess`
4. Connection proceeds with bidirectional message exchange

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

Separate HTTP server on port 2025. Known endpoints:

### `POST /mount_root`

Used during snapstart to configure session-specific mounts after snapshot restore:

```
[CONTROL] Received mount_root request
[CONTROL] mount_root succeeded: ...
[CONTROL] mount_root failed: ...
[CONTROL] mount_root task panicked: ...
```

The body contains the session mount configuration (filesystem IDs, auth tokens, etc.).

### Shutdown

Handles graceful shutdown signals. When `--control-server-addr` is set, `SIGINT` handler is disabled to prevent duplicate shutdown signals.

### Container Name Update

Allows the host to update the container name after snapshot restore (to inject the conversation ID).
