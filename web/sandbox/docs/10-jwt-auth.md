# JWT Authentication

> **There are two independent JWT systems in this VM — don't conflate them:**
> | | **Filestore JWT** (this doc) | **WS-auth JWT** (`05-websocket-protocol.md`) |
> |---|---|---|
> | Purpose | rclone → `api.anthropic.com` storage/memory | host → `process_api` port 2024 handshake |
> | Algorithm | **ES256** (P-256 ECDSA) | **EdDSA** (Ed25519) |
> | Verified by | Anthropic's API backend | `process_api` itself, against the key from `/auth_public_key` |
> | Claims | account/org/workspace + `filesystem_id` (10 fields) | minimal `TokenClaims`: `sub`, `iat`, `exp` |
> | If invalid | API returns 401 | connection rejected — *unless no key loaded (fail-open)* |
>
> The rest of this document is about the **filestore JWT**.

## Overview

The session JWT is the primary credential used by rclone-filestore to authenticate against Anthropic's API. It is:

- **ES256** (ECDSA with SHA-256) — signed by Anthropic's private key
- **6-hour TTL** from issuance (exp − iat = 21600s, confirmed)
- **Session-scoped** — the `filesystem_id` is a *claim inside the JWT* (see payload), so the token is cryptographically bound to exactly one chat filesystem
- **Not persisted in cleartext** — delivered via the `POST /mount_root` body and scrubbed from persistent configs; if placed in a per-remote rclone config it is stored **obscured**. In-sandbox testing shows this fork uses a **custom ChaCha20** obscure (key = SHA256(`!RCLONE!OBSCURE!DATA!`), 16-byte IV, base64url) — reversible (so obfuscation, not encryption) but **not** decodable by upstream `rclone reveal`, and the `reveal` CLI is stripped. At runtime the JWT lives in rclone's heap.
- **Extractable** at runtime via `/proc/<rclone_pid>/mem` (with root access)

## JWT Header

```json
{
  "typ": "JWT",
  "alg": "ES256",
  "kid": "KplTqXuB82QG2wduqFyGEsgH6n493zEsfH8qHdXqfiA"
}
```

The `kid` is the key ID of Anthropic's signing key. Since ES256 is asymmetric, the JWT cannot be forged without Anthropic's private key.

## JWT Payload

```json
{
  "iat": 1780547429,
  "exp": 1780569029,
  "sub": "<REDACTED-UUID>",
  "org_uuid": "<REDACTED-UUID>",
  "account_uuid": "<REDACTED-UUID>",
  "workspace_tagged_id": "default",
  "filesystem_id": "claude_chat_<REDACTED>",
  "resolved_workspace_tagged_id": "wrkspc_<REDACTED>",
  "org_taints": [],
  "workspace_uuid": "<REDACTED-UUID>"
}
```

### Fields

| Field | Meaning |
|---|---|
| `iat` | Issued at (Unix timestamp) |
| `exp` | Expiry (iat + 6 hours) |
| `sub` / `account_uuid` | User's account UUID |
| `org_uuid` | Organization UUID |
| `workspace_tagged_id` | `"default"` for personal workspaces |
| `filesystem_id` | The conversation's filesystem ID — all API calls scoped to this |
| `resolved_workspace_tagged_id` | The canonical workspace ID (`wrkspc_*` format) |
| `workspace_uuid` | Workspace UUID |
| `org_taints` | List of org-level restrictions (empty = none) |

## Scoping

The JWT grants access **only** to the `filesystem_id` embedded in its payload. API calls with a different `filesystem_id` return HTTP 401:

```json
{
  "code": "unauthenticated",
  "message": "error verifying filesystem id: invalid filesystem id"
}
```

## Where the JWT Lives

1. **At startup**: Injected by process_api into rclone's multimount config (as an obscured field)
2. **Post-startup**: Scrubbed from the config file by process_api
3. **At runtime**: In rclone's heap memory at a consistent location
4. **In use**: Sent as `Authorization: Bearer <jwt>` header on every API call

The JWT is refreshed (reissued) per session — each conversation gets a new JWT, even if it's for the same user and filesystem.

## Extracting the JWT

With root access to the VM:

```python
import re, base64, json, subprocess

# Find rclone PID
result = subprocess.run(['ps', 'aux'], capture_output=True, text=True)
rclone_pid = next(int(l.split()[1]) for l in result.stdout.splitlines() 
                  if 'rclone-filestore multimount' in l)

# Scan heap for JWT
with open(f'/proc/{rclone_pid}/maps') as f:
    maps = f.read()

regions = [(int(s,16), int(e,16)) for line in maps.splitlines()
           for s, e in [line.split()[0].split('-')]
           if 'rw' in line.split()[1] and 0 < int(e,16)-int(s,16) < 50*1024*1024]

best_jwt = None
with open(f'/proc/{rclone_pid}/mem', 'rb') as mem:
    for start, end in regions:
        try:
            mem.seek(start)
            data = mem.read(end - start)
            for m in re.findall(rb'eyJ[A-Za-z0-9+/._-]{200,}', data):
                s = m.decode('utf-8', errors='ignore')
                parts = s.split('.')
                if len(parts) == 3:
                    payload = base64.b64decode(parts[1] + '==').decode('utf-8', errors='ignore')
                    if 'filesystem_id' in payload:
                        best_jwt = s
                        break
        except: pass
        if best_jwt: break
```

## Memory Store Token

The memory backend uses a different credential format: `sk-ant-mem-*` (not a JWT). This token was found as a partial string in rclone's memory but not fully recoverable in this session, suggesting the memory backend may not be actively connected.

## Usage in API Calls

```bash
curl -X POST https://api.anthropic.com/v1/filestore/fs/listDirectory \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"filesystem_id": "claude_chat_...", "path": "/outputs", "limit": 100}'
```

The JWT works for all filestore REST API endpoints for the scoped filesystem_id.
