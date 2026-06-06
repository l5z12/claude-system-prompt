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

**Kernel memory is not introspectable from userspace** (even as root with full caps):
- **`STRICT_DEVMEM`** is enforced — `/dev/mem` can map the legacy low-1 MB region and device
  MMIO, but **mmap of kernel RAM is denied**. Confirmed by trying to read the kvmclock pvclock
  structure (GPA known from the MSR) — the mmap fails.
- Although `kptr_restrict=0`, the kernel was built **without `KALLSYMS_ALL`**, so `/proc/kallsyms`
  omits *data* symbols (`page_offset_base` is absent). With the KASLR direct-map base hidden,
  translating a physical address for `/proc/kcore` is impractical.
- Net effect: host-written structures that live in kernel RAM (pvclock, etc.) cannot be read out,
  so e.g. the host's `PVCLOCK_TSC_STABLE` flag is only *behaviorally* inferable.

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

**Two distinct capability contexts** exist inside the VM:

| Set | process\_api (PID 1) | tool-execution bash |
|---|---|---|
| CapPrm | `0x000001ffffffffff` (all 41) | `0x000001fffeffffff` |
| CapEff | `0x000001ffffffffff` | `0x000001fffeffffff` |
| **CapBnd** | **`0x000001fffeffffff`** | **`0x000001fffeffffff`** |
| CapInh | `0x0000000000000000` | `0x0000000000000000` |
| CapAmb | `0x0000000000000000` | `0x0000000000000000` |
| NoNewPrivs | 0 | 0 |
| Seccomp | 0 | 0 |

The **single missing capability is `CAP_SYS_RESOURCE` (bit 24)**. The design is deliberate:

process\_api retains `sys_resource` in its own Prm/Eff (it needs it to set rlimits and manage
cgroups), but it calls `prctl(PR_CAPBSET_DROP, 24)` on itself during initialisation,
permanently removing the capability from its bounding set. The bounding set is inherited
downward and can never be re-elevated; every child process — including all tool-execution
shells — is permanently excluded from `sys_resource`. (Confirmed by binary RE: see doc 04 §3.7.)

**Practical impact of the missing capability (empirically demonstrated):**
- `fcntl(F_SETPIPE_SZ)` above `/proc/sys/fs/pipe-max-size` (1 MB) → `EPERM`
- `setrlimit()` to raise a hard rlimit → `EPERM`
- Cannot access ext4 root-reserved blocks; cannot exceed RLIMIT_NPROC.

**Privilege escalation surface — all standard paths verified as closed:**

| Path | Why it fails |
|---|---|
| `capset()` | Binary has **zero `capset` syscall sites**; and CapPrm already excludes `sys_resource` so it could not be raised even if called |
| SUID binaries (su, mount, newgrp, …) | Already uid 0; SUID does not restore the bounding set |
| File capabilities | Searched the entire rootfs — no binary carries `cap_sys_resource` in its file-cap set |
| Ambient capabilities | Cannot be raised above CapPrm |
| User namespaces | Grant full caps *within the namespace* but `sys_resource` exercised against real kernel objects checks the initial-namespace bounding set |
| Kernel exploit / PID-1 code injection | Not attempted — genuine security boundary |

`CAP_SYS_RESOURCE` is **the one deliberate capability-level security control** inside the VM.
All other caps are present intentionally — the real isolation is the Firecracker boundary, and
restricting unnecessary caps would only complicate legitimate tool operations.

### 8. No Seccomp

`Seccomp: 0` — no syscall filtering. Same reasoning as capabilities.

### 9. Filesystem Isolation

- Root filesystem is the VM's own ext4 (not shared with host or other VMs)
- Skill volumes (vdc, vdd) are read-only squashfs images
- `/mnt/skills/public`, `/mnt/skills/examples`, `/mnt/transcripts`, `/mnt/user-data/uploads` are all read-only mounts
- Only `/mnt/user-data/outputs` is writable (backed by filestore API)

### 10. Kernel posture (confirmed)

- **No LSM is loaded.** `/sys/kernel/security/lsm` is empty; SELinux is compiled in
  (`CONFIG_SECURITY_SELINUX=y`) but inert, and no AppArmor/Landlock is active.
- **Module-less kernel.** Not just the `nomodule` cmdline — the kernel is built without module
  support (`CONFIG_MODULES` absent) and `/proc/modules` is empty, so LKMs cannot be loaded at all.
- **Standard hardening on:** KASLR (`RANDOMIZE_BASE`/`RANDOMIZE_MEMORY`), `STRICT_KERNEL_RWX`,
  retpoline, `FORTIFY_SOURCE`, `HARDENED_USERCOPY`, `STACKPROTECTOR_STRONG`, `VMAP_STACK`.
  These harden the guest but, like the items above, are secondary to the VM boundary.

## What Claude Can Do Inside the Sandbox

- **Run arbitrary code as root** with 40 of 41 Linux capabilities (all except `CAP_SYS_RESOURCE`; see §7)
- **Freeze the root filesystem**: `ioctl(FIFREEZE)` succeeds — a self-inflicted local DoS of disk
  writes until `FITHAW`; no impact beyond the isolated VM
- **Read/write any file** on the writable root ext4 (`/dev/vda`)
- **Make outbound network requests** to the egress-proxy allowlist (pypi, github, npm,
  `api.anthropic.com`, Ubuntu archives, adobe.io …)
- **Install Ubuntu packages** via `apt-get` — `archive.ubuntu.com` and `security.ubuntu.com` are
  allowlisted; third-party apt repos (e.g. NodeSource) return 403
- **Read the ACPI tables** in `/sys/firmware/acpi/tables/` and decompile them with `iasl`
- **Read low-1 MB physical memory** via `/dev/mem` (STRICT_DEVMEM permits access to the reserved
  region below 1 MB — used to read the vmclock `VCLK` structure at `0xDE000` and the VM
  Generation ID at `0xDFFF0`)
- **Read MSRs** via `/dev/cpu/0/msr` — the device is present (built into the kernel); KVM masks
  platform values (base-ratio returns 0, microcode returns 1, turbo-ratio raises #GP)
- **Passively sniff the cleartext host↔process_api WebSocket traffic** on `eth0` using an
  `AF_PACKET` raw socket (or `setsid tcpdump`) — confirmed by live capture: the JWT in the HTTP
  Upgrade `Authorization:` header, the full unmasked `ProcessConnection` JSON, and per-call
  stdout/ProcessExited frames are all visible in the pcap (see `artifacts/runtime/ws-capture.pcap`)
- **Read squashfs skill/tool volumes** (`/dev/vdb–vdd`)
- **Write to `/mnt/user-data/outputs`** (persisted via rclone-filestore to the session's cloud storage)

## What Claude Cannot Do

- **Escape the Firecracker VM boundary** — only a hypervisor CVE would allow this; not attempted
- **Reach non-allowlisted domains** — egress proxy returns `x-deny-reason: host_not_allowed`
- **Reach the host machine** — the gateway (192.0.2.1) RSTs all probed TCP ports; vsock has no
  assigned CID; IMDS (169.254.169.254) is intercepted and blocked by the egress proxy
- **Connect to process_api's ports from inside the VM** — `:2024` enforces
  `--block-local-connections`; `:2025` also refuses local connections; and even if a connection
  were established, the auth JWT is signed by a key whose private half never enters the VM
- **Gain `CAP_SYS_RESOURCE`** — permanently excluded from the bounding set (§7); empirically
  confirmed: pipe-size-cap and hard-rlimit calls both return `EPERM`
- **Read arbitrary kernel RAM** — STRICT_DEVMEM blocks `/dev/mem` for System RAM; `/proc/kallsyms`
  omits data symbols (no KALLSYMS_ALL), so the KASLR direct-map base is inaccessible, making
  `/proc/kcore` translation impractical (doc 07 §2)
- **Load kernel modules** — kernel built with `nomodule`; `/proc/modules` is empty
- **Access EC2 instance metadata (IMDS)** — 169.254.169.254 is proxy-blocked
- **Recover initramfs content** — zeroed by `init_on_free=1` before userspace starts
- **Access other sessions' filesystems** — separate `filesystem_id` claim per session in the
  rclone-filestore JWT; Anthropic's backend enforces the scope

## Token Lifecycle Summary

```
Host sandbox-gateway
  → HTTP Upgrade to process_api :2024
      Authorization: Bearer <EdDSA JWT, 60-min, iss=sandbox-gateway>
  → process_api verifies JWT (fail-open on wiggle cluster — no key loaded)
  → process_api receives ProcessConnection JSON
      { process_id, create_req: {name:"/bin/sh", uid:0, timeout:300, …},
        expected_container_name, accept_zstd }
  → spawns /bin/sh -c "<tool command>" in its cgroup
  → stdout/stderr collected, sent as WS frames after process exits
  → WS CLOSE 1000 — TCP connection torn down
  → next tool call = new TCP SYN from host

Filestore credential (separate path):
  POST /mount_root → rclone-filestore receives ES256 JWT (6-h TTL,
  session-scoped filesystem_id) → stored in rclone heap, scrubbed
  from configs → used for every /mnt/user-data read/write
```
