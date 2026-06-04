# Filestore REST API

All endpoints confirmed via live API calls from inside the sandbox.

## Base URL

```
https://api.anthropic.com/v1/filestore/fs/
```

## Authentication

```
Authorization: Bearer <session_jwt>
```

The JWT is scoped to a specific `filesystem_id` and `workspace_tagged_id`. See `10-jwt-auth.md`.

## Session Parameters

- **`filesystem_id`**: `claude_chat_<conversation_id>` — unique per conversation
- All paths are relative to the filesystem root

## Filesystem Root Structure

A fresh session's filesystem has exactly 4 top-level directories:

```json
{
  "entries": [
    {"directory": {"path": "/tool_results", ...}},
    {"directory": {"path": "/outputs", ...}},
    {"directory": {"path": "/uploads", ...}},
    {"directory": {"path": "/transcripts", ...}}
  ]
}
```

---

## Endpoints

### `POST /v1/filestore/fs/listDirectory`

List files in a directory.

**Request:**
```json
{
  "filesystem_id": "claude_chat_...",
  "path": "/outputs",
  "limit": 100
}
```

**Response:**
```json
{
  "entries": [
    {
      "file": {
        "file": {
          "uuid": "<REDACTED-UUID>",
          "createdAt": "2026-06-04T07:12:28.797218Z",
          "size": "571",
          "mediaType": "text/plain",
          "metadata": {"filename": "api_delivery_test.txt"},
          "md5": "<REDACTED-MD5>",
          "workspaceTaggedId": "default",
          "detectedMimeType": "text/plain",
          "downloadable": true
        },
        "filesystemId": "claude_chat_...",
        "path": "/outputs/api_delivery_test.txt"
      }
    }
  ],
  "cursor": "f:<filename>"
}
```

**Note:** Without `"limit"`, the response is `{"cursor": "f:"}` with no entries. Always include `limit`.

---

### `POST /v1/filestore/fs/readFileMetadata`

Get metadata for a specific file.

**Request:**
```json
{
  "filesystem_id": "claude_chat_...",
  "path": "/outputs/filename.txt"
}
```

**Response:** Same `file` object as in `listDirectory`.

---

### `POST /v1/filestore/fs/readFile`

Get the raw file content.

**Request:**
```json
{
  "filesystem_id": "claude_chat_...",
  "path": "/outputs/filename.txt"
}
```

**Response:** Raw file bytes (content-type matches the file's mediaType).

---

### `POST /v1/filestore/fs/readMetadata`

Get directory metadata.

**Request:**
```json
{
  "filesystem_id": "claude_chat_...",
  "path": "/outputs"
}
```

---

### `POST /v1/filestore/fs/createFile`

Upload a new file. Uses `multipart/form-data`.

**Request (multipart):**
- `params` (type: `application/json`):
  ```json
  {
    "filesystem_id": "claude_chat_...",
    "path": "/outputs/newfile.txt",
    "media_type": "text/plain"
  }
  ```
- `file`: the file content (binary or text)

**Response:**
```json
{
  "file": {
    "file": {
      "uuid": "...",
      "createdAt": "...",
      "size": "...",
      "mediaType": "text/plain",
      "metadata": {"filename": "newfile.txt"},
      "md5": "...",
      "downloadable": true
    },
    "filesystemId": "...",
    "path": "/outputs/newfile.txt"
  }
}
```

**Note:** Files created this way appear in the FUSE mount only after the directory cache TTL expires, or after a `listDirectory` call refreshes the cache.

---

### `POST /v1/filestore/fs/makeDirectory`

Create a directory.

---

### `POST /v1/filestore/fs/moveDirectory`

Move a directory.

---

### `POST /v1/filestore/fs/importZip`

Import a ZIP archive. Uses `multipart/form-data` (same `params` + `file` structure as `createFile`).

---

## Error Responses

```json
{"code": "not_found", "message": "error reading file: not found"}
{"code": "unauthenticated", "message": "error verifying filesystem id: invalid filesystem id"}
{"code": "invalid_argument", "message": "validation error: ..."}
```

## Filesystem ID Format

Valid formats discovered:
- Tagged ID: `claude_chat_<alphanumeric>` (current sessions)
- UUID: standard UUID format (workspace/org scoped — requires matching JWT)

The JWT's `filesystem_id` claim must match the `filesystem_id` in the request. Cross-session access is not possible with a session-scoped JWT.

## RPC Interface (Connect, not plain gRPC)

The `rclone-filestore` client doesn't use the REST routes — it speaks **Connect RPC**
(`connectrpc.com/connect`, `Connect-Protocol-Version` header) over the
`anthropic/filestore/v1alpha` protobufs. Connect can carry the gRPC, gRPC-Web, or
Connect-JSON protocols over HTTP/2; reflection is **not** enabled (which is why
earlier gRPC-reflection probes failed).

- **Package**: `anthropic.filestore.v1alpha`
- **Auth**: `AuthorizationMetadata` message + `Authorization:` header (same Bearer JWT)
- **CA cert required**: the egress `sandbox-egress-production` CA
- **Proto messages confirmed in the binary**: `ListDirectoryResponse`, `ReadFileRequest` (with `.Range`), `ImportFilesRequest`, `Directory`, `File`, `FilesystemFile`, `AuthorizationMetadata`

The REST surface (`/v1/filestore/fs/…`) documented above is the easiest to call by
hand and was confirmed working; the Connect RPC surface is what the FUSE client uses.
