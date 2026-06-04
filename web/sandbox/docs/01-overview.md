# Claude Sandbox Environment — Complete Technical Overview

## What It Is

Every Claude conversation with computer-use tools runs inside a **Firecracker microVM** — a lightweight KVM-based virtual machine developed by AWS, repurposed by Anthropic for sandboxing. Each conversation gets its own isolated VM.

The environment is **not a container** (no Docker, no Kubernetes pods directly). It's a real virtual machine with its own kernel, init process, and hardware-level isolation.

## Key Components

| Component | Role |
|---|---|
| Firecracker | KVM hypervisor providing VM isolation |
| Custom Linux kernel 6.18.5 | VM operating system |
| `process_api` (PID 1) | VM init, WebSocket server, tool execution manager |
| `rclone-filestore` | FUSE filesystem bridge to Anthropic's storage API |
| Squashfs block devices | Read-only mounts for skills and tooling |
| `api.anthropic.com` | Backend for file storage and memory |
| TLS inspection proxy | Intercepts and filters all outbound HTTPS |

## Cluster / Deployment

Container names follow the format:

```
container_<conversation_id>--<cluster>--<hash>
```

Example: `container_<REDACTED>--<REDACTED>--<REDACTED>`

- **`wiggle`** is the internal cluster/deployment identifier
- The conversation ID is embedded directly in the container name
- The host-side orchestration layer ties the container lifecycle to the conversation

## Files in This Documentation

| File | Contents |
|---|---|
| `02-vm-hardware.md` | Kernel, CPU, RAM, block devices |
| `03-snapstart.md` | Snapshot/restore boot mechanism |
| `04-process-api.md` | The PID 1 init binary — exhaustive end-to-end, route-by-route |
| `05-websocket-protocol.md` | Tool execution protocol |
| `06-network.md` | Networking and egress proxy |
| `07-security.md` | Security model and isolation layers |
| `08-storage-rclone.md` | rclone-filestore binary and FUSE mounts |
| `09-filestore-api.md` | REST API endpoints (discovered via live calls) |
| `10-jwt-auth.md` | JWT authentication details |
| `11-skills-mounts.md` | Squashfs skill volumes |
| `12-memory-api.md` | Claude memory system backend |
| `13-present-files.md` | How the present_files tool works |
| `14-container-env.md` | container.env — the initramfs config |
| `15-findings-and-unknowns.md` | What was confirmed vs uncertain |
| `16-binary-analysis-process-api-rclone.md` | Binary-verified deep dive on both binaries; corrections to 04/05/08/09/10/12 |
| `17-runtime-state.md` | Observed live processes, sockets, and cgroups |
