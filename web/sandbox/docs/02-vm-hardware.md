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

- **1 vCPU**, Intel(R) Xeon(R) Processor @ 2.80GHz
- Architecture: x86_64
- 1 NUMA node

## RAM

- Approximately **3–4 GB** usable
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
- UUID: `00000000-0000-0000-0000-000000000000` (placeholder — snapshot template artifact)

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

## Hostname

The VM hostname is simply `vm` (resolved to 127.0.0.1 in `/etc/hosts`).
