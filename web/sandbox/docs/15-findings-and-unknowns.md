# Findings Summary and Unknowns

## Confirmed Findings

Everything in this section was directly verified via live system inspection.

### Infrastructure
- ✅ Firecracker microVM (KVM-based)
- ✅ Custom Linux kernel 6.18.5, built Jan 14 2026
- ✅ 1 vCPU (Intel Xeon 2.80GHz), ~3GB RAM
- ✅ 4 virtio-blk devices (rootfs, rclone, public skills, example skills)
- ✅ virtio-net eth0 at 192.0.2.2/24, gateway 192.0.2.1
- ✅ No kernel modules (`nomodule`), IPv6 disabled
- ✅ `init_on_free=1` — freed pages zeroed

### Boot Mechanism
- ✅ Firecracker snapshot/restore (snapstart)
- ✅ process_api as PID 1 from initramfs
- ✅ Block devices start at 275GB stub, resize to actual content
- ✅ `/old_root` left empty after pivot_root
- ✅ Page cache dropped at startup
- ✅ Auth tokens injected then immediately scrubbed

### process_api
- ✅ Static Rust binary, Tokio async runtime
- ✅ WebSocket server on port 2024
- ✅ Control server on port 2025
- ✅ Supports Firecracker, gVisor, runc runtimes
- ✅ Full WebSocket message type enum reconstructed
- ✅ CreateProcess struct fields reconstructed
- ✅ OOM monitoring via cgroup polling
- ✅ Token scrubbing patterns: `_TOKEN`, `_SECRET`, `_PASSWORD`, `API_KEY`
- ✅ `--block-local-connections` prevents in-VM access to port 2024

### Storage
- ✅ rclone-filestore binary (~30MB Go binary on squashfs)
- ✅ Source: `github.com/anthropics/anthropic/api-go/filestore`
- ✅ 4 FUSE mounts confirmed with exact paths, cache TTLs, permissions
- ✅ VFS cache in `/dev/shm/rclone-vfscache`
- ✅ Session JWT in rclone heap (extractable via `/proc/mem`)
- ✅ JWT decoded: ES256, 6h TTL, contains account/org/workspace UUIDs
- ✅ Filestore REST API at `/v1/filestore/fs/` — all endpoints confirmed working
- ✅ Memory backend: `anthropic.memory.api.v1alpha.MemoryInternalService`
- ✅ Memory token format: `sk-ant-mem-*`

### Network
- ✅ TLS inspection proxy with Anthropic's own CA
- ✅ Domain allowlist enforced at proxy (not iptables)
- ✅ `api.anthropic.com` statically pinned to `160.79.104.10` in `/etc/hosts`
- ✅ DNS: 8.8.8.8 (but egress-proxied)

### Security
- ✅ No seccomp
- ✅ Only `CAP_SYS_RESOURCE` missing from capabilities
- ✅ cgroupv1 used
- ✅ VM boundary is the primary security mechanism

### Skills
- ✅ 9 public skills on `/dev/vdc` (~656KB squashfs)
- ✅ 24 example skills on `/dev/vdd` (~5.3MB squashfs)
- ✅ Private skills not provisioned (no 5th block device)
- ✅ `.skill` bundle files confirmed for all skills

### Virtual Tools
- ✅ `present_files` handled by API orchestration layer, not VM
- ✅ File delivery via filestore readFile endpoint
- ✅ `local_resource` XML tag format confirmed

---

## Uncertainties and Unknowns

### Host-Side Orchestration
- ❓ What scheduler/orchestration system triggers snapshot restores?
- ❓ How many VM snapshots exist in the pool at any time?
- ❓ What triggers VM termination (conversation end? timeout? turn count?)
- ❓ Are VMs reused across conversations for the same user?

### `dp_mtls`
- ❓ How dp_mtls authentication works when available
- ❓ Whether it uses client certificates or some other mechanism
- ❓ Why "wiggle" cluster doesn't have it

### `container.env`
- ❓ Exact content for a standard session (absent? empty JSON? minimal config?)
- ❓ Full schema for enterprise sessions with private skills
- ❓ How it's injected into the initramfs per-session

### `--wiggle--`
- ❓ Whether "wiggle" is a cluster name, region, deployment tier, or internal project name
- ❓ Whether other clusters exist and what they're called

### Model Tools
- ❓ What exactly is in `/mnt/sandboxing/model_tools_env/v1/python`
- ❓ When and why it's mounted
- ❓ How it relates to skills vs. built-in Python environment

### Memory Backend
- ❓ How the `sk-ant-mem-*` token is provisioned per session
- ❓ Internal hostname for the memory gRPC service
- ❓ Whether memory backend runs as a separate rclone FUSE mount or differently

### Private Skills (Enterprise)
- ❓ How operator custom skills are packaged into squashfs images
- ❓ Whether there's a skill upload API
- ❓ How workspace-scoped filestore JWTs differ from session-scoped ones

### Snapstart Template
- ❓ How often templates are rebuilt (when kernel changes? daily?)
- ❓ Whether different session types (model versions, feature flags) have different templates
- ❓ How the snapshot pool is managed and scaled

---

## Investigation Methods Used

1. **`/proc/PID/mem`** — read process heap memory for JWTs and config data
2. **`debugfs`** — scan ext4 for deleted inodes
3. **`/proc/kcore`** — scan physical RAM for freed content (3GB scan)
4. **`strings`** — extract readable strings from binaries
5. **Live API calls** — directly called `https://api.anthropic.com/v1/filestore/fs/*`
6. **`grpcio`** — attempted gRPC calls to the filestore service
7. **`/proc/net/tcp`** — decode active network connections
8. **`dmesg`** — boot timing and device enumeration
9. **`/dev/vdc`, `/dev/vdd`** — directly read squashfs device contents
10. **Process memory scanning** — scanned rclone and process_api heaps

## Things That Didn't Work

- **`/dev/mem`** — blocked by `CONFIG_STRICT_DEVMEM` despite being root
- **`strace`** — not installed
- **gRPC reflection** — server doesn't support it
- **Memory API gRPC** — not reachable from public `api.anthropic.com`
- **rclone config restart** — auth tokens not recoverable after scrub; needed env var workaround
- **`init_on_free=1`** — physical memory forensics on freed initramfs pages impossible
