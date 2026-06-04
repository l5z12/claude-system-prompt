# How present_files Works

## Overview

`present_files` is a **virtual tool** — it is NOT executed inside the VM. When the model generates a `present_files` tool_use block, it is intercepted and handled entirely by Anthropic's API orchestration layer on the host side.

## The Complete Flow

```
1. Model generates tool_use block:
   {
     "type": "tool_use",
     "name": "present_files",
     "input": {"filepaths": ["/mnt/user-data/outputs/file.zip"]}
   }

2. Anthropic API orchestration receives the model response.

3. API layer handles present_files directly:
   a. Maps local path → filestore path:
      /mnt/user-data/outputs/file.zip → /outputs/file.zip
   b. Calls readFileMetadata with the session's filesystem_id
   c. Gets the file UUID and confirms downloadable: true

4. The file was previously synced from FUSE to the filestore backend
   (when written to /mnt/user-data/outputs/ via rclone write-through)

5. API layer returns tool result:
   <local_resource>
     <file_path>/mnt/user-data/outputs/file.zip</file_path>
     <name>file</name>
     <mime_type>application/zip</mime_type>
   </local_resource>

6. UI renders the file as a downloadable link, serving content via:
   POST /v1/filestore/fs/readFile
   with the session JWT and file path.
```

## Why It's Not In the VM

- `present_files` takes a local filesystem path — it needs no bash execution
- The file already exists in the filestore backend (via rclone write-through)
- The host already has the session JWT to access the file
- The API layer can serve the file directly from the filestore to the user

## The `local_resource` Tag

The tool result XML format:
```xml
<local_resource>
  <file_path>/mnt/user-data/outputs/filename</file_path>
  <name>display name</name>
  <mime_type>type/subtype</mime_type>
</local_resource>
```

This is a signal to the API layer: "here's a file in my FUSE-mounted filestore that should be presented to the user."

## File Prerequisites

For `present_files` to succeed, the file must:
1. **Exist at the given local path** — the API layer validates this
2. **Be synced to the filestore backend** — the FUSE write-through should handle this automatically, but there may be a short delay

If a file is **not** in `/mnt/user-data/outputs/`, `present_files` automatically copies it there first (per the tool description: "If a file is not in the output directory, it will be automatically copied into that directory").

## Direct API Creation

Files can also be created directly via the filestore REST API:

```bash
curl -X POST https://api.anthropic.com/v1/filestore/fs/createFile \
  -H "Authorization: Bearer <jwt>" \
  -F "params={\"filesystem_id\":\"...\",\"path\":\"/outputs/file.txt\",\"media_type\":\"text/plain\"};type=application/json" \
  -F "file=@localfile.txt;type=text/plain"
```

Files created this way appear in `present_files` after the FUSE directory cache refreshes — either after the TTL (up to 1 hour for outputs) or after a directory listing call forces a refresh.

## Observed Timing

In testing: the gap between calling `present_files` and receiving the tool result was approximately **5 seconds**. This includes:
- Time for rclone to flush the file to the filestore backend
- Time for the API layer to verify the file via `readFileMetadata`
- WebSocket round-trip

## Process_api's Role

During a `present_files` call, the process_api (PID 1) shows:
- Minimal activity — just waiting on WebSocket events
- FD 11 (the host WebSocket connection) is used
- No new file descriptors opened
- No FUSE activity for present_files itself

This confirms process_api is **not involved** in `present_files` execution.

## Other Virtual Tools

Tools that are similarly handled by the API layer (not in the VM):
- `ask_user_input_v0` — renders buttons in the UI
- `message_compose_v1` — renders message composer UI
- `recipe_display_v0` — renders recipe card UI
- `chart_display_v0` — renders charts
- `places_map_display_v0` — renders maps
- `event_create_v1`, `reminder_create_v0` — calendar/reminder integration
- `suggest_connectors`, `search_mcp_registry` — MCP app management

All of these produce UI elements on the host side with no VM involvement.
