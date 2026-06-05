# Snapstart Boot Mechanism

## Overview

VMs do not cold-boot for each conversation. Instead, Anthropic uses Firecracker's snapshot/restore capability to start conversations in milliseconds from a pre-initialized VM state.

> **Confirmed at turn granularity (2026-06-05):** restore happens **per assistant tool-turn**,
> not just once per conversation. Evidence: within one conversation, `/proc/uptime` resets to
> a few minutes each turn while the conversation is hours old, `boot_id` changes, and dmesg
> shows the restore live — `random: crng reseeded due to virtual machine fork` plus virtio-blk
> **capacity-change** events as the real backing files replace 256 GiB placeholders. The
> writable root (`/dev/vda`) **delta persists across turns** (files written earlier survive),
> while read-only squashfs images (`/dev/vdb` rclone, `/dev/vdc`/`vdd` skills) are
> **re-attached fresh** — which is why the rclone build hash drifts between turns (doc 08).
>
> **The detection mechanism is an ACPI VM Generation Counter** — Firecracker exposes a
> `_SB.VGEN` device (HID `FCVMGID`, CID `VM_Gen_Counter`, counter at guest-phys `0xDFFF0`) in
> its DSDT (doc 02). The plumbing, visible in the decompiled DSDT: a Generic Event Device
> (`_SB.GED`, `ACPI0013`) wired to two interrupts, with an `_EVT` handler that routes
> **event 5 → `Notify(VGEN, 0x80)`** and **event 6 → `Notify(VCLK, 0x80)`**. On restore the host
> raises these; the guest kernel sees the generation-counter change, treats it as a "fork," and
> reseeds the CRNG, while the Amazon `vmclock` (`_SB.VCLK`, HID `AMZNC10C`) resyncs wall-clock
> time so time-of-day stays correct even though monotonic uptime resets. Corroborating this, the
> two `ACPI:Ged` IRQs (24/25) in `/proc/interrupts` each show a count of exactly **1** per turn —
> the single restore notification. The generation value itself is a **host-assigned 16-byte GUID**
(a sample read via `/dev/mem`: `aad18409-…`, captured in `../artifacts/runtime/host-os-probe.txt`)
that differs on every restore — exactly the change the kernel detects. The companion Amazon
`vmclock` structure (magic `VCLK`) carries a host-set `disruption_marker`, though in this build
its counter is flagged invalid and it serves no active time (the guest runs on kvm-clock/TSC).
Both the kvmclock and the guest TSC are **rebased on every restore** (uptime and raw TSC both
read ~the same small value), so the guest can recover its own *restore* wall-clock timestamp
(`now − uptime`) but **not the host's uptime or boot time** — those are hidden by the rebasing.

## Two Boot Modes

The `process_api` binary supports two init paths, selected at runtime:

### Mode 1: Fresh Boot (Template Creation)

```
[INIT] Fresh boot: reading /mount_config.json...
[INIT] Fresh boot init complete: ...
```

Used when creating a new snapshot template. Steps:
1. Reads `/mount_config.json` from the root filesystem (session-specific mount config)
2. Sets up `/proc`, `/sys`, `/dev`, networking
3. Reads `container.env` from the initramfs (JSON config — see `14-container-env.md`)
4. Injects auth tokens into rclone config
5. Drops page cache: `echo 3 > /proc/sys/vm/drop_caches`
6. Spawns `rclone-filestore multimount`
7. Mounts squashfs skill volumes
8. Optionally mounts model_tools at `/mnt/sandboxing/model_tools_env/v1/python`
9. Scrubs auth tokens from configs: `[INIT] Auth tokens scrubbed from config(s)`
10. Signals `SNAPSTART_READY` to the host
11. Firecracker takes a full memory + disk snapshot

### Mode 2: Snapstart Restore (Per-Conversation)

```
[INIT] Snapstart template mode: signaling ready...
[INIT] devtmpfs remount restored device nodes
resumed from frozen full-checkpoint snapshot
```

Used for every actual conversation. Steps:
1. Firecracker restores VM from snapshot (fast — sub-second)
2. Block devices resized from stub size to actual content
3. Host sends `POST /mount_root` to control server (port 2025) with session config
4. process_api mounts session-specific FUSE filesystems
5. Container name updated to include conversation ID
6. `init_on_free=1` ensures template's freed pages are zeroed going forward

## Why Snapstart

Cold boot of the VM takes ~20 seconds (from dmesg timestamps). Snapstart allows:
- Near-instant conversation start (~1–2 seconds including storage mount)
- Identical clean environment for every conversation
- No leftover state from previous conversations

## The initramfs

- `rdinit=/process_api` means PID 1 starts from the **initramfs** (RAM disk), not the ext4 root
- After init, process_api does `pivot_root` to move to ext4, leaving old root at `/old_root`
- The initramfs is unmounted and freed after pivot_root
- `init_on_free=1` zeros the freed initramfs pages immediately — contents unrecoverable
- `/old_root` is left as an empty directory (mount point artifact)

## Init Sequence Log (verbatim strings from the binary)

All of the following are **exact** strings in `process_api` (verified, not paraphrased):

```
[INIT] Fresh boot: reading /mount_config.json...
[INIT] Snapstart template mode: signaling ready...
 resumed from frozen full-checkpoint snapshot
SNAPSTART_READY
[INIT] Creating /dev/fuse device node...     |  [INIT] /dev/fuse already exists
[INIT] Waiting for ready_file(s)... (        |  [INIT] All ready_file(s) found after
[INIT] pivot_root ok                         |  [INIT] pivot_root failed (
 (checkpoint replaced dir)
[INIT] Auth tokens scrubbed from config(s)
[INIT] Fresh boot init complete:
drop_caches ok; config written; model_tools ok;
```

Newly confirmed mechanisms:
- **`/dev/fuse` is created by init** before spawning rclone (the FUSE backends need it).
- **Init polls for `ready_file(s)`** — it blocks until rclone signals its mounts are up
  (`/tmp/rclone-mounts/ready`) before declaring the VM ready:
  `Waiting for ready_file(s)...` → `All ready_file(s) found after <dur>`.
- Config deserializes into Rust structs `MountRootConfig` / `FuseMountConfig` /
  `EtcFiles` / `TokenClaims` (the last is the **WS-auth** JWT, not the filestore one —
  see `05`/`10`).

## Confirmed Evidence

- `dmesg` shows boot at second 0, processes all started at `10:29:31` — gap confirms snapshot restore
- Block devices initially 275GB, resized to actual sizes 1.4s after boot
- **`resumed from frozen full-checkpoint snapshot`** — exact string confirmed in `process_api`
- **`SNAPSTART_READY`** and **`[INIT] Snapstart template mode: signaling ready...`** confirmed
- Config path is `/mount_config.json` (absent on disk in this snapshot — consumed during fresh boot; snapstart uses `POST /mount_root`)
- `/old_root` exists as an empty directory
