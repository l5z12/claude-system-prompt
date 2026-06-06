# Sandbox Artifacts

Captured evidence backing the docs in `../docs/`. Everything here was pulled directly from a
live sandbox microVM with read-only inspection (proc/sys dumps, `dmesg`, decompressed kernel
config, binary copies, block-device images, trust-store certs).

## Capture context (this snapshot)

| | |
|---|---|
| Date | 2026-06-05 |
| Kernel | Linux 6.18.5 (`#2 SMP PREEMPT_DYNAMIC`), builder `argocd@coder-…` |
| Hypervisor | KVM / Firecracker microVM, 1 vCPU, ~3.9 GiB RAM |
| `process_api` | BuildID `edebff2c…`, sha256 `06e438d1…` (Rust, static-pie; stable across turns) |
| `rclone-filestore` | BuildID `5c205e4a…`, sha256 `2fb389a4…`, go1.25.10 (squashfs build — **capture-time-specific**, drifts per turn) |
| Cluster | `wiggle` |

> **Redaction policy.** Session-scoped identifiers and credentials are redacted: the chat /
> filesystem ID appears as `claude_chat_<REDACTED>`, the container name as
> `container_<REDACTED>--<REDACTED>--<REDACTED>`, and any `auth_token` / session JWT as
> `<REDACTED>` (structure documented, value withheld). The binaries, squashfs images, and CA
> certificates are byte-for-byte originals (they contain no per-session secrets). A scan
> confirms no chat ID, container ID, `sk-ant-…` token, or JWT remains in the text artifacts —
> the only `sk-ant-mem-…` string present is the literal placeholder from rclone's help text.

## `binaries/`
The two executables that run the sandbox, plus derived metadata.

| File | What it is |
|---|---|
| `process_api` | The PID-1 init + tool executor (dumped from `/proc/1/exe`). |
| `process_api.metadata.txt` | `file`/ELF header/build-id/sections/toolchain (`rustc 1.95.0-nightly`). |
| `process_api.cargo-deps.txt` | Rust crate manifest from embedded `artifactory.infra.ant.dev` source paths. |
| `rclone-filestore` | The storage/memory FUSE client (copied from `/opt/rclone`). |
| `rclone-filestore.metadata.txt` | `file`/build-id/Go version/build settings (`-trimpath`, `CGO_ENABLED=1`). |
| `rclone-filestore.go-deps.txt` | Go module roots, Anthropic `api-go` packages, Connect-RPC memory methods, filestore proto messages. |
| `rclone-filestore-rootfs` | The **baseline** rclone baked into the RO rootfs at `/usr/local/bin` (go1.25.9, BuildID `3fe76ce4…`, 29.2 MB). Older than the `/opt` squashfs build — lacks the expanded memory API (`memory.api.v1`/`DeltaHunk`). `.metadata.txt` has the side-by-side diff. |
| `extract-text` (+ `.metadata.txt`) | **Anthropic-built Rust CLI** that extracts plain text from docx/odt/epub/xlsx/pptx/rtf/html/ipynb. The local twin of a server-side "file-parser HTTP service"; metadata includes `--help` (incl. zip-bomb caps) and its 20-crate manifest. |
| `magika` (+ `.metadata.txt`) | **Google Magika 1.0.1** (model `standard_v3_3`) — the ONNX deep-learning file-type detector the sandbox uses. Vendored public tool (not from Anthropic's registry); bundles the model + onnxruntime. |

## `certs/`
The TLS-inspection (MITM) roots injected into the trust store, and the system bundle.

| File | What it is |
|---|---|
| `swp-ca-production.crt.pem`, `swp-ca-staging.crt.pem` | "Secure Web Proxy" egress-inspection CAs. |
| `egress-gateway-ca-production.crt.pem`, `egress-gateway-ca-staging.crt.pem` | Egress-gateway CAs. |
| `anthropic-sandbox-egress-ca.pem` | The egress CA as originally captured. |
| `ca-summary.txt` | Subject / issuer / validity / basicConstraints for each Anthropic CA. |
| `ca-certificates.crt` | The full system trust bundle. |

## `configs/`
Filesystem/mount/identity config as seen in the VM.

| File | What it is |
|---|---|
| `rclone-mount-config.json` | The live `multimount` config (4 mounts, cache TTLs, uid/gid, `service_url`). |
| `rclone-backends.txt` | `rclone --help` commands + `help backend rclone-filestore`/`rclone-memory`/registered backends. |
| `rclone-test.conf` | A per-remote rclone config showing the `auth_token` (obscured) shape. |
| `container_info.json` | `/container_info.json` (container name, redacted). |
| `etc-hosts`, `etc-resolv.conf`, `etc-passwd` | `/etc/*` as written by `process_api`. |
| `rclone-mounts-ready` | The mount-ready sentinel file. |

## `runtime/`
Live process / kernel / network / device state.

| File | What it is |
|---|---|
| `proc-cmdline.txt`, `proc-1-cmdline.txt` | Kernel cmdline and PID-1 argv. |
| `proc-cpuinfo.txt`, `proc-meminfo.txt`, `proc-iomem.txt`, `proc-partitions.txt` | CPU, memory, physical map, partitions. |
| `kernel-config.txt` | Decompressed `/proc/config.gz` (full kernel build config). |
| `proc-modules.txt`, `proc-filesystems.txt`, `proc-cgroups.txt` | (empty — module-less), supported FS, cgroup v1 controllers. |
| `sys-virtio-devices.txt` | virtio-pci topology (4×blk + net + rng; no vsock/balloon). |
| `security-posture.txt` | LSM (none active) + SELinux (inert) + seccomp + capabilities summary. |
| `entropy-and-boot.txt` | hwrng source, entropy, `boot_id`, uptime. |
| `dmesg.txt` | Full boot log — shows the snapshot **restore** (VM-fork RNG reseed, block-device capacity-change). |
| `proc-1-status.txt`, `proc-1-maps.txt`, `proc-1-fd.txt`, `proc-1-ns.txt` | PID-1 status, memory map, open fds (sockets/pipes), namespaces. |
| `proc-self-status.txt`, `proc-self-cgroup.txt` | Current process status + cgroup path. |
| `cgroup-limits.txt` | Memory/CPU/pids cgroup limits. |
| `proc-net-tcp.txt`, `proc-net-unix.txt`, `proc-net-route.txt`, `proc-net-arp.txt`, `proc-net-dev.txt` | Sockets (`:2024`/`:2025` + WS from gateway `192.0.2.1`), routing, ARP, iface stats. |
| `proc-keys.txt` | Kernel keyring. |
| `pip-packages.txt` | Full Python package list (128 packages + versions). |
| `node-globals.txt` | Node.js global packages (19 packages, incl. React 19, playwright, pptxgenjs, mermaid-cli). |
| `cpuid-probe.txt` | Raw CPUID output: host CPU identified as Cascade Lake SP (Family 6 Model 0x55 Stepping 7), KVM features. |
| `host-probe.txt` | VMM/host probe: virtio-PCI device model + MSI-X routing, full-unthrottled-vCPU proof, KVM-masked MSRs, no-nesting check. |
| `acpi-tables.txt` | Decoded ACPI tables: OEMID `FIRECK`/`FCAT` (confirms Firecracker), hardware-reduced ACPI, GED, VM Generation Counter, Amazon vmclock, PCI hotplug machine model. |
| `dsdt-decompiled.dsl` | Full `iasl` decompile of the DSDT (1097 lines): VGEN/VCLK/GED devices, GED `_EVT` event routing, PCIe host bridge `_CRS` address map, 32 hotplug slots. |
| `virtio-pci-caps.txt` | virtio-1.0 PCI capability layout + BAR map for all 6 devices (common/isr/device/notify/MSI-X offsets, vector counts). |
| `host-os-probe.txt` | Host-OS investigation: KVM feature set → host kernel ≥5.8, `ptp_kvm` host-clock channel, vmclock `VCLK` structure + VM-Generation-ID, AWS/Amazon-Linux inference. |
| `ws-capture.pcap` | Live pcap of the host↔process_api WebSocket exchange (setsid tcpdump on eth0:2024). Contains the full HTTP Upgrade (with JWT in `Authorization: Bearer`), unmasked ProcessConnection JSON, and the StdErrEOF/ExpectStdOut/StdOutEOF/ProcessExited message sequence. See doc 05. |
| `mount-output.txt`, `proc-mounts.txt` | Mount table (ext4 root, 3 squashfs, 4 rclone FUSE mounts). |
| `mnt-file-listing.txt` | Recursive listing under `/mnt`. |
| `rclone-vfsmeta.txt` | rclone VFS cache layout under `/dev/shm`. |
| `env-whitelisted.txt` | Safe environment variables (CA-bundle paths, `IS_SANDBOX`, toolchain paths). |
| `uname.txt`, `os-release.txt` | Kernel/OS identity. |
| `ps-aux.txt` | Process table (only `process_api` + `rclone` persist). |
| `process-api-strings.txt`, `rclone-strings-filtered.txt` | Extracted strings (full / filtered). |

## `squashfs/`
The read-only virtio-blk images attached on restore (byte-for-byte; `rclone` build drifts per turn).

| File | Mount | What it is |
|---|---|---|
| `vdb-rclone-tool.sqfs` | `/opt/rclone` | The rclone-filestore tool image. |
| `vdc-skills-public.sqfs` | `/mnt/skills/public` | Public skills. |
| `vdd-skills-examples.sqfs` | `/mnt/skills/examples` | Example skills. |

## `SHA256SUMS`
Checksums for the binaries, squashfs images, and CA certs in this snapshot.
