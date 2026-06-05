# VM Hardware and Kernel

## Kernel

```
Linux vm 6.18.5 #2 SMP PREEMPT_DYNAMIC Wed Jan 14 17:56:08 UTC 2026 x86_64
```

- Custom Anthropic build, not a stock distro kernel
- Built by `argocd@coder-xiangbin-xb-home-2-0` — Anthropic CI/CD pipeline
- `PREEMPT_DYNAMIC` — supports runtime-configurable preemption
- Kernel cmdline:
  ```
  console=ttyS0 reboot=k panic=1 nomodule random.trust_cpu=1 ipv6.disable=1
  swiotlb=noforce rdinit=/process_api init_on_free=1
  -- --firecracker-init --addr 0.0.0.0:2024 --max-ws-buffer-size 32768
  --block-local-connections
  ```
- `init_on_free=1` — all freed memory pages are immediately zeroed (security measure against forensics)
- `nomodule` — no kernel modules can be loaded
- `ipv6.disable=1` — IPv6 disabled
- `rdinit=/process_api` — process_api is PID 1, started from the initramfs

## CPU

- **1 vCPU**, Intel(R) Xeon(R), x86_64, 1 NUMA node
- **CPU clock is host-dependent and varies per session** — observed both **2.80 GHz** and
  **2.10 GHz** across restores. Because snapstart restores land on different physical hosts
  from the pool, the reported frequency (and exact RAM) differs between conversations; don't
  treat a specific GHz as fixed.
- **Host microarchitecture identified via CPUID (leaf 1): Family 6, Model 0x55, Stepping 7 =
  Intel Cascade Lake SP (CLX Refresh).** Confirmed by: `avx512_vnni=1` (CLX's headline
  feature), `avx512_bf16=0` (rules out Cooper Lake), Stepping 7 (vs Skylake-SP Stepping 4–5).
  Firecracker passes through the real Family/Model/Stepping but **masks the brand string** to
  `"Intel(R) Xeon(R) Processor @ <freq>GHz"`. Hypervisor vendor: `KVMKVMKVM` (canonical KVM
  signature), max leaf 0x40000001, 13 KVM paravirt features enabled (clocksource, steal-time,
  PV-EOI, PV-TLB-flush, PV-send-IPI, async page-fault, …).
- **L3 cache: 33,792 KB** (11-way, 64B line, 49 152 sets) — consistent with a 24-core CLX
  configuration (~1.375 MB/core × 24). L1D/L1I: 32 KB each; L2: 1 MB.
- Notable flags: `avx512f avx512dq avx512bw avx512vl avx512_vnni avx512cd hle rtm tsc_known_freq`
- Vulnerability markers (from `/proc/cpuinfo` `bugs`): `spectre_v1/v2 taa mmio_stale_data retbleed bhi its`
- **The vCPU is a full, unthrottled core**, not an oversubscribed slice: `cpu.cfs_quota_us=-1`
  (no CPU quota), `cpu.stat throttled_time=0`, `/proc/stat` steal ≈ 0, and a busy loop measures
  `cpu/wall ≈ 0.99` (runs continuously). (Naïve microbenchmarks read low only because GCC
  `-march=native` defaults to 256-bit AVX2 vectors here, not AVX-512, and untouched-page first
  faults skew memory tests — not throttling.)
- `/dev/cpu/0/msr` is readable (built into the kernel, not a module), but **KVM masks the
  platform MSRs**: `MSR_PLATFORM_INFO` base ratio reads 0, microcode (`IA32_BIOS_SIGN_ID`)
  reads 1, `MSR_TURBO_RATIO_LIMIT` raises #GP, and `IA32_FEATURE_CONTROL=0x1` (VMX bit clear).
  `/dev/kvm` is absent → **no nested virtualization** inside the guest.

## RAM

- **Host-dependent, ~3–4 GB** usable (e.g. ~4.0 GB / 4,099,204 kB observed in one session,
  ~3 GB in another) — varies with the physical host, same reason as CPU clock.
- No cgroupv1 memory limit set (value is max int64 = effectively unlimited)
- OOM killed processes are tracked in `oom_killed.log`

## Disk — Block Devices

Reported by `/proc/partitions` and `dmesg`:

| Device | Size | Mount | Type | Contents |
|---|---|---|---|---|
| vda | 256 GiB | `/` | ext4 (no journal) | Root filesystem |
| vdb | ~9.7 MiB | `/opt/rclone` | squashfs (ro) | `rclone-filestore` binary |
| vdc | ~656 KiB | `/mnt/skills/public` | squashfs (ro) | Public skills |
| vdd | ~5.3 MiB | `/mnt/skills/examples` | squashfs (ro) | Example skills |

**Snapstart stub sizes**: at boot, all devices are initially reported as 536,870,912 blocks (~275 GB) — this is the snapshot template stub size. They are resized to actual content ~1.4 seconds after boot via Firecracker's block device resize mechanism.

## Root Filesystem

- ext4 on `/dev/vda`
- No journal (`mounted filesystem without journal`)
- Mounted with `resuid=65534,resgid=65534`
- UUID: `00000000-0000-0000-0000-000000000000` (placeholder — snapshot template artifact;
  `dumpe2fs` renders the all-zero UUID as `Filesystem UUID: <none>`)
- **No journal** — confirmed by the feature list, which omits `has_journal`:
  `ext_attr resize_inode dir_index sparse_super2 filetype extent 64bit flex_bg sparse_super
  large_file huge_file dir_nlink extra_isize`. A journal-less rootfs is expected for a
  snapshot-restored, effectively-ephemeral disk.
- Filesystem state reports **"not clean"** — never cleanly unmounted, expected for a
  memory-snapshot-restored rootfs.
- **Root inode birth = 2026-04-18 18:22:28 UTC** = the snapshot **template** creation date.
  Confirmed independently on 2026-06-05 (`debugfs stat <2>` → `crtime … Sat Apr 18 18:22:28
  2026`; `Filesystem created: Sat Apr 18 18:22:28 2026`). Every conversation off this template
  sees the *same* birth time — it's template age, not session age. (Matches the
  `/usr/local/bin` rclone build's `vcs.time=2026-04-18` — the whole base image was baked that
  day.)

## Running Processes

Only 3 meaningful user processes in the VM:

```
PID 1   /process_api --firecracker-init --addr 0.0.0.0:2024
        --max-ws-buffer-size 32768 --block-local-connections
PID 489 /opt/rclone/rclone-filestore multimount
        --config /tmp/rclone-mount-config.json
PID xxx bash (current tool execution session)
```

All other processes are kernel threads.

## Device Model (virtio-PCI + MSI-X)

The guest is wired up over a **PCI bus with MSI-X interrupts**, not the legacy virtio-MMIO
transport classic Firecracker uses:

```
0000:00:00.0  Intel host bridge      8086:0d57
0000:00:01.0–04.0  virtio-blk        1af4:1042   → vda, vdb, vdc, vdd
0000:00:05.0  virtio-net             1af4:1041   → eth0
0000:00:06.0  virtio-rng             1af4:1044   → hwrng
```

Each device has a `-config` MSI-X vector plus per-queue vectors (block: `req.0`; net:
`input.0`/`output.0`; rng: one queue) — see `/proc/interrupts`. A PCI host bridge + modern
virtio-PCI IDs (`1af4:104x`) + MSI-X is **not** classic MMIO-only Firecracker — but the ACPI
tables settle it: **this is confirmed Firecracker.** All four tables (APIC/DSDT/FACP/MCFG)
carry **OEMID `FIRECK`, Creator `FCAT`, TableIDs `FCVM*`**, Creator-revision `0x20240119`
(a 2024-01-19 date stamp). SMBIOS/DMI is entirely empty (Cloud Hypervisor would populate it).
So this is a **PCI- and ACPI-enabled Firecracker build**, not Cloud Hypervisor.

The ACPI machine model (decoded in `../artifacts/runtime/acpi-tables.txt`):
- **Hardware-reduced ACPI** (FADT flags bit20=1): no legacy 8259 PIC, no SMI, no PM1 blocks —
  events arrive via a GED instead. MADT shows a single LAPIC (APIC_id 0) + one IO-APIC.
- **`_SB.GED_`** (HID `ACPI0013`) — the ACPI Generic Event Device, i.e. the `ACPI:Ged` IRQs
  24/25 in `/proc/interrupts`.
- **`_SB.VGEN`** (HID `FCVMGID`, CID `VM_Gen_Counter`) — a **VM Generation Counter**; the guest
  reads it to detect snapshot restore (see doc 03 — this is what drives the post-restore RNG
  reseed).
- **`_SB.VCLK`** (HID **`AMZNC10C`**, `VMCLOCK`) — an **Amazon paravirtual clock device** (4 KB
  read-only region at guest-phys `0xDE000`). The `AMZN` ACPI vendor prefix indicates this is
  **Amazon's (AWS) Firecracker** build, consistent with the Cascade Lake host. The VGEN counter
  itself lives at guest-phys `0xDFFF0`.
- **`_SB.PC00`** PCIe host bridge (`PNP0A08`/`PNP0A03`, segment 0, bus 0) with **32 hotplug
  slots** (`S000`–`S031`, one per bus-0 device, each with `_SUN`/`_ADR`/`_EJ0` → `PHPR.PCEJ`).
  The eject machinery (`PHPR.PCEJ`/`PCIU`/`PCID`) is declared `External`, loaded via a runtime
  SSDT only when hotplug is active — the `tables/dynamic` dir is empty at steady state. The DSDT
  also carries a tiny i8042 stub (IO `0x64`, IRQ 1) — the keyboard-controller reset line behind
  `reboot=k`. Full decompile: `../artifacts/runtime/dsdt-decompiled.dsl`.

**Host-bridge address-space map** (from `_SB.PC00._CRS`):
| Region | Range | Purpose |
|---|---|---|
| PCI config IO | `0xCF8–0xCFF` | legacy CONFIG_ADDRESS/DATA |
| ECAM (MMCONFIG) | `0xEEC00000` +1 MB | PCIe extended config, 1 bus |
| 32-bit MMIO | `0xC0001000–0xEEBFFFFF` | low device BARs (~750 MB) |
| 64-bit MMIO | `0x40_0000_0000–0x7F_FFFF_FFFF` | high device BARs (**256 GiB** window) |

**virtio-1.0 device layout** (uniform across all 6 devices; `../artifacts/runtime/virtio-pci-caps.txt`):
each has a single 64-bit **512 KB BAR0** in the high-MMIO window (sequential from
`0x40_0000_0000`), with vendor capabilities at fixed offsets — `COMMON_CFG`@0x0 (56 B),
`ISR`@0x2000, `DEVICE_CFG`@0x4000 (4 K), `NOTIFY_CFG`@0x6000 (notify-mult 4), `PCI_CFG`, and
`MSI-X` (table@0x8000, PBA@0x48000). MSI-X vector counts match `/proc/interrupts`: blk/rng = 2
(config + 1 queue), net = 3 (config + RX + TX). Subsystem IDs equal the device IDs (`1af4:104x`),
the modern-virtio convention.

## Host OS & Hypervisor

The host is sealed off, but several channels constrain it (full probe in
`../artifacts/runtime/host-os-probe.txt`):
- **Host OS = Linux + KVM.** The KVM CPUID leaf (`KVMKVMKVM`, max `0x40000001`) advertises
  `KVM_FEATURES=0x01007efb`. The newest bit present, `ASYNC_PF_INT`, landed in **Linux 5.8**, so
  the **host kernel is ≥ 5.8** (`PV_SCHED_YIELD` ≥5.7 also present; `MSI_EXT_DEST_ID` is absent
  but that's Intel-hardware-dependent, not a version bound).
- **`KVM_HINTS_REALTIME` is _not_ set** — the vCPU is not formally pinned; the near-zero steal
  measured for the "full core" finding reflects an uncontended host at that moment, not a hard
  guarantee.
- **Host clock is reachable** via `/dev/ptp0` (driver `KVM virtual PTP` = `ptp_kvm`,
  cross-timestamping on): the host supports the `CLOCK_PAIRING` hypercall (≥4.11) and the guest
  can read host `CLOCK_REALTIME`.
- **Almost certainly AWS.** The Amazon `vmclock` device (`AMZNC10C`), Amazon's Firecracker
  (`FIRECK`), and the Cascade Lake host together point to **AWS EC2**; the host OS is therefore
  most likely **Amazon Linux (AL2/AL2023)** or an AWS-internal Nitro/Firecracker host Linux. This
  is an inference — the VM boundary blocks reading the host's `/etc/os-release` or kernel version
  directly, and the KVM feature set (≥5.8) is the tightest bound obtainable from inside.
- **Independent confirmation the host is Linux:** the gateway (192.0.2.1) answers closed ports
  with a TCP RST whose **IP TTL = 64** — the canonical Linux/Unix initial TTL (Windows = 128).
- **vsock is inert:** `/dev/vsock` exists but `GET_LOCAL_CID` returns `0xFFFFFFFF`
  (`VMADDR_CID_ANY`) — no context ID assigned; the host link is TCP-only.
- The host's kvmclock pvclock structure is located (GPA via MSR readback) but its **contents are
  unreadable** from userspace (`STRICT_DEVMEM` + no `KALLSYMS_ALL`; see doc 07), so the host
  TSC-stability guarantee is only behaviorally inferable.

## Hostname

The VM hostname is simply `vm` (resolved to 127.0.0.1 in `/etc/hosts`).

## Installed Software

Baked into the rootfs image (Ubuntu 24.04.4 LTS). Full pip/npm lists are in `../artifacts/runtime/`.

**Runtimes:** Python 3.12.3 — Node v22.22.2 / npm 10.9.7 — OpenJDK 21.0.10 — GCC/G++ 13.3.0

**Python (128 packages) — key capabilities:**
- *PDF*: camelot-py, pdfminer.six, pdfplumber, pypdf, pypdfium2, pikepdf, reportlab, pdf2image, img2pdf, pdfkit (5 separate PDF parsers + 3 generators)
- *Office*: python-docx, python-pptx, openpyxl, odfpy, xlsxwriter, unoserver 3.6 (headless LibreOffice — drives the docx/pptx/xlsx skills), tabula-py (PDF table extraction via Java/tabula-java — explains why JDK 21 is present)
- *Image/OCR*: Pillow 12, OpenCV 4.13 (3 variants: standard, contrib, headless), Tesseract OCR (pytesseract), Wand (ImageMagick), imageio-ffmpeg, tifffile
- *CV/ML*: mediapipe 0.10.33 (face/hand/pose detection), scikit-learn 1.8, scikit-image 0.26, onnxruntime 1.24.4, magika 0.6.3 (also installable as Python pkg). **No PyTorch/TensorFlow** — inference-only via ONNX.
- *Data/Viz*: NumPy 2.4, Pandas 3.0, SciPy 1.17, Matplotlib 3.10, Seaborn, SymPy 1.14 (symbolic math), NetworkX 3.6
- *Web/Markdown*: Flask, requests, BeautifulSoup4, lxml, Playwright 1.56, markitdown 0.1.5, markdownify, mkdocs + mkdocs-material
- *Audio*: sounddevice 0.5.5 (audio I/O)
- *Misc*: cryptography 46, PyJWT, protobuf 7.34, psutil, graphviz

**Node globals (19 packages):**
React 19.2 + react-dom + react-icons — playwright 1.56 — pptxgenjs 4.0 — @mermaid-js/mermaid-cli 11.12 — sharp 0.34 — pdf-lib 1.17 — pdfjs-dist 5.6 — docx 9.6 — marked 18.0 — ts-node 10.9.2 — remark-cli — markdownlint-cli — markdown-pdf — markdown-toc
