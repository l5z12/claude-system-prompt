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
- ✅ `--block-local-connections` prevents in-VM access to ports 2024/2025 — **but** the local-IP
  set is a one-time startup snapshot (`getifaddrs`), so an IP added post-startup (needs
  `CAP_NET_ADMIN`, which the VM has) bypasses it; verified empirically (doc 04 §8a)

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

### Host-Side Orchestration  *(partially resolved)*
- ✅ **Snapshot template baked 2026-04-18** (root inode birth; matches the base-image build
  date) — restored ~47 days later for this conversation. The full freeze→snapshot→thaw→
  `mount_root` lifecycle is mapped (see `03`/`05`).
- ✅ **Same `filesystem_id` survives an in-session VM restart** — a mid-conversation restart
  restored the same slot/conversation context, i.e. *same conversation ID → same VM slot*
  within a session.
- ✅ JWT `exp` (6h) is the credential-expiry mechanism that bounds a reconnecting session.
- ❓ Pool sizing / warm-pool scheduler; whether VMs are re-pooled across *different*
  conversations; exact termination trigger — all host-side, not observable from inside.

### `dp_mtls` / port-2024 auth  *(RESOLVED for wiggle — see `05`/`07`)*
- ✅ The WS handshake supports an app-layer **EdDSA (Ed25519) JWT** verified against the key
  installed via the control server's `/auth_public_key` endpoint (claims `sub`/`iat`/`exp`).
- ✅ **Confirmed fail-open on wiggle:** `/container_info.json` has **no `auth_public_key`**,
  so `[WARN] Failed to load auth key:` fires at startup and every handshake hits
  *"No auth public key loaded, accepting JWT without verification"* (a plain JSON first
  message skips the JWT entirely). The **only** guard on :2024 is `--block-local-connections`.
- ✅ **dp_mtls substantially explained (in-sandbox):** the base image pre-installs two CA
  families — `swp-ca-*` (the TLS-inspection MITM CA) and `egress-gateway-ca-*` (issued
  Feb 2026). The egress-gateway CA is *almost certainly* the one that signs the **host's
  client cert** for dp_mtls: in dp_mtls mode the host presents a client cert to :2024 that
  process_api verifies at the TLS layer (no JWT needed). See `06`. *(inferred — no
  client-cert material is in the VM; that's host-side.)*

### `mount` vs `mount2`  *(RESOLVED — see `08`)*
- ✅ Both use `hanwen/go-fuse/v2 v2.8.0`. `mount` = upstream rclone (VFS layer); `mount2` =
  Anthropic-custom `mount2direct` (raw go-fuse, bypasses VFS). `multimount` uses `mount2direct`.

### `container.env`  *(schema resolved — see `14`)*
- ✅ Deserializes into the same `MountRootConfig`/`FuseMountConfig`/`EtcFiles` structs as
  the `POST /mount_root` body; top-level field names recovered verbatim from the binary
- ❓ Exact content for a standard session (absent? minimal?); enterprise/private-skills variant

### `--wiggle--`
- ❓ Whether "wiggle" is a cluster name, region, deployment tier, or internal project name
- ❓ Whether other clusters exist and what they're called

### Model Tools  *(RESOLVED — in-sandbox check)*
- ✅ **Absent in standard consumer sessions** — `/mnt/sandboxing` does not exist at all;
  `mount_model_tools` is false, so init skips it. It's an operator/deployment feature.
- ✅ When present it's a Python env at `/mnt/sandboxing/model_tools_env/v1/python`. The CA-
  injection paths process_api probes (`pyenv`, `uv`, `conda`, plus Chrome/Firefox policy
  dirs) imply it's a pyenv/uv/conda Python env, optionally with Chromium/Firefox for
  browser-automation operator deployments.
- ❓ Exact package contents (never provisioned in any captured consumer session)

### Memory Backend  *(largely resolved — see `12-memory-api.md`)*
- ✅ **RPC-only in a standard session — NOT FUSE-mounted.** `memory_store_id` is `null` on
  every mount; the FUSE memory mount only appears when the backend provisions a store.
- ✅ Transport is **Connect RPC** (`connectrpc.com/connect`), service
  `anthropic.memory.api.v1alpha.MemoryInternalService` (WriteMemory / ReadMemoryByPath /
  MoveMemory / DeleteMemoryByPath / ListMemories / SearchMemories)
- ✅ Token format `sk-ant-mem-*`; guardrails `memory_content_too_large` / `memory move rejected`
- ❓ How the `sk-ant-mem-*` token is provisioned; internal hostname of the memory service

### Private Skills (Enterprise)  *(packaging RESOLVED — see `11`)*
- ✅ `.skill` = standard **deflate ZIP** of the skill tree; official packager
  `skill-creator/scripts/package_skill.py` (excludes `__pycache__`/`*.pyc`/`evals/`).
  Pipeline: package → validate → build squashfs → attach as `/dev/vde` → mount at
  `/mnt/skills/private`. The squashfs is just the extracted ZIP (md5-verified).
- ❓ Whether there's a hosted skill *upload* API; how workspace-scoped filestore JWTs differ

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

- **`/dev/mem`** — kernel RAM blocked by `CONFIG_STRICT_DEVMEM`, but the legacy low-1 MB
  reserved region and device MMIO remain readable (used to read the vmclock / VM-Gen-ID; see doc 07)
- **`strace`** — not installed
- **gRPC reflection** — server doesn't support it
- **Memory API gRPC** — not reachable from public `api.anthropic.com`
- **rclone config restart** — auth tokens not recoverable after scrub; needed env var workaround
- **`init_on_free=1`** — physical memory forensics on freed initramfs pages impossible
