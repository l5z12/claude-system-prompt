# Security Model

## Primary Boundary: Firecracker VM

The fundamental security guarantee comes from **KVM hardware virtualization**. Code running in the VM cannot escape the VM without a Firecracker/KVM vulnerability.

All Linux-level security mechanisms (capabilities, seccomp, AppArmor) are intentionally minimal because they're irrelevant — the VM boundary is the real constraint.

## Layer-by-Layer Analysis

### 1. VM Isolation

- Firecracker microVM with KVM hardware virtualization
- Minimal device model — only virtio-blk and virtio-net exposed
- No virtio-vsock in current TCP deployment

### 2. Memory Security

**`init_on_free=1`** in kernel cmdline:
- Every freed memory page is immediately zeroed by the kernel
- Prevents reading data from previous VMs if pages are reused
- Makes forensic recovery of freed initramfs content impossible
- Snapshot templates cannot leak session data through freed pages

**Page cache drop at startup**:
- process_api writes `3` to `/proc/sys/vm/drop_caches` during init
- Clears all cached file data from the snapshot template
- Ensures no previous session's file data persists

### 3. Auth Token Scrubbing

process_api performs token scrubbing in two stages:

**Stage 1**: After injecting tokens into rclone config and spawning rclone:
```
[INIT] Auth tokens scrubbed from config(s)
```

**Stage 2**: Env var scrubbing for all spawned processes — removes vars matching:
- `*_TOKEN`
- `*_SECRET`
- `*_PASSWORD`
- `*API_KEY`

Tokens are not persisted in cleartext. **Correction/nuance:** the auth token *is*
carried in the `POST /mount_root` body and, if written to a per-remote rclone config,
is stored **rclone-obscured** — reversible with `rclone reveal` (obfuscation, not
encryption). After rclone starts, the persistent multimount config is scrubbed; the
live token then exists in rclone's heap (extractable via `/proc/PID/mem`). It remains
session-scoped (`filesystem_id` baked into the JWT) and useless after the session ends.

### 4. TLS Inspection

All outbound HTTPS is intercepted by the `sandbox-egress-production` proxy. This is a
**monitoring** mechanism, not a security barrier — it lets Anthropic audit outbound
API calls and enforce the domain allowlist. `process_api` actively *guarantees*
interception works by force-injecting the egress CA into every trust store (system,
Java JKS, Python certifi) and exporting a dozen `*_CA_BUNDLE` env vars at init — so no
tool can accidentally bypass the MITM by using its own trust store. See `06-network.md`.

### 5. Domain Allowlist

Only specific domains are reachable. Enforced at the egress proxy (host-side), not via iptables in the VM. Unknown domains get a TCP reset or `x-deny-reason` header.

### 6. Local Connection Blocking + app-layer JWT auth

`--block-local-connections` prevents processes inside the VM from connecting to port
2024 (the tool execution WebSocket server). Only the host (192.0.2.1) can reach it.
This prevents a malicious bash command from issuing WebSocket messages on behalf of the
model.

**Second layer (verified from the binary):** the WS handshake is also gated by an
application-layer **EdDSA (Ed25519) JWT**. `process_api` verifies the first message
against a public key the host installs via the control server's `/auth_public_key`
endpoint (`[DEBUG] JWT verified successfully: sub='...'`). It's a distinct credential
from the ES256 filestore JWT (claims: just `sub`/`iat`/`exp`).

**Confirmed fail-open on the wiggle cluster.** In-sandbox, `/container_info.json` has
**no `auth_public_key`**, so `process_api` logs *"No auth public key loaded, accepting
JWT without verification"* and accepts any first message (a plain JSON `ProcessConnection`
skips the JWT entirely). So on this cluster the JWT check is a **no-op** and
`--block-local-connections` is the **only** access control on :2024. Practical
implication: an external caller that could reach port 2024 over the host network would
get **unauthenticated process creation** — the security rests entirely on the network
not exposing :2024 and on the local-IP block. (On dp_mtls clusters the transport mutual-
TLS makes the Ed25519 check redundant.)

### 7. Linux Capabilities

```
CapEff: 0x000001fffeffffff
```

Only `CAP_SYS_RESOURCE` is missing. All others are present. This is **not a security mechanism** — full capabilities are intentional because:
- The VM boundary provides the real isolation
- Restricting caps inside the VM would just complicate legitimate operations
- Capabilities are meaningless against a Firecracker escape anyway

### 8. No Seccomp

`Seccomp: 0` — no syscall filtering. Same reasoning as capabilities.

### 9. Filesystem Isolation

- Root filesystem is the VM's own ext4 (not shared with host or other VMs)
- Skill volumes (vdc, vdd) are read-only squashfs images
- `/mnt/skills/public`, `/mnt/skills/examples`, `/mnt/transcripts`, `/mnt/user-data/uploads` are all read-only mounts
- Only `/mnt/user-data/outputs` is writable (backed by filestore API)

## What Claude Can Do Inside the Sandbox

- Run arbitrary code as root with nearly all capabilities
- **Freeze its own root filesystem**: `ioctl(open("/"), FIFREEZE)` succeeds from inside
  (confirmed live). Writes to the frozen ext4 then block until `FITHAW` — a self-inflicted
  local DoS of the VM's own disk writes, with no impact beyond the isolated VM.
- Read and modify any file on the root ext4 filesystem
- Make network requests to allowlisted domains
- Access `/proc/mem` of other processes (including PID 1)
- Read squashfs skill volumes
- Write to `/mnt/user-data/outputs` (persisted to filestore)

## What Claude Cannot Do

- Escape the Firecracker VM boundary (without a hypervisor CVE)
- Reach non-allowlisted domains
- Connect to the WebSocket server on port 2024 (blocked for local connections)
- Access other conversations' filesystems (separate filesystem_id per session)
- Recover the initramfs content (zeroed by init_on_free=1)
- Load kernel modules (`nomodule` cmdline)

## Token Lifecycle Summary

```
Host orchestration → initramfs container.env → process_api reads → 
writes to rclone config → spawns rclone → scrubs config → 
token lives in rclone heap → session ends → VM destroyed
```

The JWT in rclone's heap (ES256, 6h TTL) is the only persistent credential. It's session-scoped and can't be used after the session ends.
