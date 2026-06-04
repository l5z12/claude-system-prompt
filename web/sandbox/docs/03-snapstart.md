# Snapstart Boot Mechanism

## Overview

VMs do not cold-boot for each conversation. Instead, Anthropic uses Firecracker's snapshot/restore capability to start conversations in milliseconds from a pre-initialized VM state.

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

## Init Sequence Log (reconstructed from binary strings)

```
[INIT] Fresh boot: reading /mount_config.json...      # or snapstart path
[INIT] FUSE daemon(s) spawned in ...
drop_caches ok; config written; model_tools ok;
[INIT] Auth tokens scrubbed from config(s)
[INIT] Firecracker init complete, starting process_api services...
```

## Confirmed Evidence

- `dmesg` shows boot at second 0, processes all started at `10:29:31` — gap confirms snapshot restore
- Block devices initially 275GB, resized to actual sizes 1.4s after boot
- `resumed from frozen full-checkpoint snapshot` string confirmed in process_api binary
- `/mount_config.json` absent on disk (consumed during fresh boot, or snapstart used POST)
- `/old_root` exists as an empty directory
