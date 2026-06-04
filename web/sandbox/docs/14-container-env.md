# container.env — The Initramfs Config File

## What It Is

`/container.env` is a JSON configuration file placed in the **initramfs** (RAM disk) before the VM boots. It is read by process_api as its very first action, before pivot_root to the ext4 root filesystem.

## Why It's Not Recoverable

Three layers of protection prevent reading its content after the fact:

1. **Initramfs unmount**: After `pivot_root` to ext4, the initramfs is unmounted. `/old_root` is left as an empty directory.

2. **`init_on_free=1`**: The kernel immediately zeros all freed pages. When the initramfs tmpfs is unmounted, its pages are freed and zeroed. Physical memory forensics via `/proc/kcore` found no content (3GB scan confirmed).

3. **Auth token scrubbing**: Even the parsed values (auth tokens) are scrubbed from configs immediately after use.

## Evidence of Its Existence

From process_api binary strings:
```
/container.env
[INIT] Failed to parse container.env as JSON: ...
```

The error message is generic — it fires if the file doesn't exist OR if it contains invalid JSON. For standard consumer sessions, the file may simply be absent (process_api continues with defaults).

## Reconstructed JSON Schema

Derived from process_api struct field names, multimount config schema, and init sequence log messages:

```json
{
  "readonly_mounts": [
    {
      // squashfs block device configs
      // each entry maps a device to a mount destination
    }
  ],
  "fuse_mounts": [
    {
      "filesystem_id": "claude_chat_...",
      "memory_store_id": "...",       // alternative to filesystem_id
      "auth_token": "...",             // scrubbed immediately after use
      "service_url": "https://api.anthropic.com",
      "ca_cert_pem": "...",           // custom egress CA cert (optional)
      "destination": "/mnt/user-data/outputs",
      "source": "/outputs",
      "readonly": false,
      "uid": 999,
      "gid": 1000,
      "dir_perms": "0755",
      "file_perms": "0644",
      "vfs_cache_mode": "full",
      "vfs_cache_max_size": "1G",
      "backend_cache_ttl": 3600.0,
      "cache_duration_s": 3600.0
    }
  ],
  "readonly_dev_start_index": 1,
  "rclone_tools_dev_index": 1,        // index of vdb (rclone binary)
  "mount_model_tools": true,          // whether to mount model_tools_env
  "mount_rclone_tools": true,
  "resolv_conf": "nameserver 8.8.8.8\n",
  "etc_hosts": "160.79.104.10 api.anthropic.com\n...",
  "ca_cert_pem": "..."               // custom CA cert for TLS inspection
}
```

## What It Does

During fresh boot (template creation), process_api uses `container.env` to:

1. Configure squashfs block device mounts (skills, rclone tool)
2. Configure FUSE mounts with auth tokens for the filestore
3. Set `/etc/resolv.conf` content
4. Set `/etc/hosts` content
5. Set the custom CA cert for TLS inspection
6. Decide whether to mount model tools (`/mnt/sandboxing/model_tools_env/v1/python`)

## Snapstart Mode

During **snapstart** (per-conversation), the `container.env` from the initramfs is NOT used. Instead, the host sends session-specific config via `POST /mount_root` to the control server after snapshot restore. This allows different sessions to have different filesystem_ids and auth tokens without re-baking the initramfs.

## Private Skills

For Enterprise workspaces with custom skills:
- The `readonly_mounts` array would include an additional entry for a private skills squashfs
- The device would be attached at `vde` (index 4) or later
- The auth tokens for the workspace-scoped filestore would be included in `fuse_mounts`

For standard sessions: the file is either absent or contains minimal config (explaining the "Failed to parse" log message in the binary).
