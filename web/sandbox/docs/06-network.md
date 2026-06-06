# Network Configuration

## Interface

```
eth0: 192.0.2.2/24  (MAC 02:fc:00:00:00:01)
Gateway: 192.0.2.1 (host tap, MAC 02:fc:00:00:00:05)
```

The `192.0.2.0/24` range is RFC 5737 "TEST-NET-1" — a documentation/testing range that is not internet-routable. Anthropic uses it for internal VM-to-host communication.

- VM IP: `192.0.2.2`
- Host (gateway) IP: `192.0.2.1`
- IPv6 is disabled (`ipv6.disable=1`)

## Routing

```
Default route: 0.0.0.0/0 via 192.0.2.1 (eth0)
Local subnet:  192.0.2.0/24 via eth0
```

All traffic — including DNS and API calls — goes through the host gateway.

## DNS

```
nameserver 8.8.8.8
```

Google DNS, but all outbound traffic goes through the **TLS inspection proxy**, which applies the domain allowlist. DNS responses arrive before the proxy can filter TCP connections, so DNS itself is not the enforcement mechanism.

## /etc/hosts

```
160.79.104.10  api.anthropic.com
127.0.0.1      localhost
127.0.0.1      vm
```

`api.anthropic.com` is **statically pinned** to `160.79.104.10`. This ensures:
1. All filestore and memory API calls reach the correct endpoint
2. The TLS inspection proxy at that IP intercepts them correctly
3. DNS hijacking cannot redirect API calls

## TLS Inspection Proxy

All outbound HTTPS traffic is intercepted by a **man-in-the-middle TLS proxy**:

```
Subject: O=Anthropic, CN=sandbox-egress-production TLS Inspection CA
Issuer:  O=Anthropic, CN=sandbox-egress-production TLS Inspection CA (self-signed)
Valid:   Jul 22 2025 – Jul 20 2035
```

The VM's `/etc/ssl/certs/ca-certificates.crt` trusts this CA. From outside the VM, the connection appears as:
- VM → TLS proxy (using Anthropic's intercepting CA)
- TLS proxy → actual destination (re-encrypted with real cert)

This means Anthropic can see all plaintext of "HTTPS" connections from the VM.

The actual CA (from `certs/anthropic-sandbox-egress-ca.pem`, verified with `openssl`):

```
subject = O=Anthropic, CN=sandbox-egress-production TLS Inspection CA
issuer  = O=Anthropic, CN=sandbox-egress-production TLS Inspection CA  (self-signed)
notBefore = Jul 22 21:34:59 2025 GMT
notAfter  = Jul 20 21:34:58 2035 GMT
```

### How the CA reaches every client

The interception only works because `process_api` **force-injects this CA into every
trust store at init** (the on-disk file is `sandboxing-egress-ca.pem`). It is not just
added to the system bundle — init also:

- writes `/etc/ssl/certs/sandboxing-egress-ca.pem` and `/usr/local/share/ca-certificates/sandboxing-egress-ca.crt`
- injects it into **Java JKS cacerts** across jvm/jre/sdkman paths via
  `keytool -importcert -keystore <cacerts> -storepass changeit -noprompt -alias …`
  (default keystore password `changeit`; logs `[INIT] keytool -importcert failed:` /
  `cacerts write failed` / `not JKS v2 … changeit and keytool unavailable/failed; skipped` on failure)
- injects it into the **NSS databases** used by Chromium/Firefox via `certutil` into
  `cert9.db`
- patches **Python certifi** bundles (`certifi/cacert.pem`, `pip/_vendor/certifi/cacert.pem`, `botocore/cacert.pem`)
- drops Firefox enterprise-policy files
- exports CA-bundle / proxy env vars so non-system TLS stacks trust it too:
  `REQUESTS_CA_BUNDLE`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `CURL_CA_BUNDLE`,
  `NODE_EXTRA_CA_CERTS`, `GIT_SSL_CAINFO`, `AWS_CA_BUNDLE`, `HTTPLIB2_CA_CERTS`,
  `CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE`, `NIX_SSL_CERT_FILE`, `PIP_CERT`, plus `NO_PROXY`

The result: curl, Python (requests/httpx/boto), Node, Java, git, gcloud, and the AWS
CLI all transparently accept the MITM CA without per-tool configuration.

## Network Allowlist

Enforced at the egress proxy, not via iptables inside the VM. Allowed domains (from system config):

```
*.adobe.io, adobe.io
api.anthropic.com
api.github.com
archive.ubuntu.com
codeload.github.com
crates.io
files.pythonhosted.org
github.com
index.crates.io
npmjs.com, npmjs.org, www.npmjs.com, www.npmjs.org
pypi.org
pythonhosted.org
raw.githubusercontent.com
registry.npmjs.org
registry.yarnpkg.com
security.ubuntu.com
static.crates.io
yarnpkg.com
```

**Confirmed by in-sandbox testing:** the allowlist is **exact-hostname**, not
wildcard-subdomain, and blocked requests return **`x-deny-reason: host_not_allowed`**.
Notably **`anthropic.com` (apex) and `docs.anthropic.com` are blocked** — only
`api.anthropic.com` is reachable. Also blocked in testing: `example.com`, `api.openai.com`,
`google.com`, `huggingface.co`. So there is no way to reach Anthropic's docs/marketing
hosts from inside the VM — only the API endpoint.

Because `archive.ubuntu.com`/`security.ubuntu.com` are on the allowlist, **`apt-get` works for
Ubuntu's own repos** (e.g. `apt-get install acpica-tools` succeeds as root via the TLS proxy
using the installed Anthropic egress CAs). Third-party apt repos are still blocked —
`deb.nodesource.com` returns `403 Forbidden`.

## Host→VM connection routing (inbound)

The host's connection TO `process_api` (:2024) flows in the reverse direction and was captured
by sniffing eth0. The HTTP Upgrade headers reveal the full path:

- **Ultimate source:** `via: 1.1 google` — the request traverses Google's network backbone.
- **Anthropic internal proxies:** `x-forwarded-for: 10.5.64.2, 10.5.0.3` — two internal hops.
- **Internal service endpoint:** `x-envoy-original-dst-host: 10.17.217.200:14100` — the actual
  Anthropic sandbox API service, fronted by an Envoy proxy before reaching the VM's `192.0.2.2`.
- **Host header:** `sandbox.api.anthropic.com` — the logical service name.
- **Protocol:** HTTP/1.1 WebSocket Upgrade (cleartext on the VM side; `x-forwarded-proto: https`
  confirms the external leg is HTTPS). See `../artifacts/runtime/ws-capture.pcap`.

**169.254.169.254 (EC2 IMDS):** requests are **intercepted by the egress proxy** and return
`Destination IP is in a private/reserved range` — no cloud metadata (instance type, IAM
credentials) is accessible to the VM. Anthropic explicitly blocks IMDS access.

## Host gateway surface (192.0.2.1)

The host TAP interface at 192.0.2.1 is **reachable** (TCP RST returned — not timeout),
confirming the guest→host routing path via virtio-net works. However, **no services are
exposed**: all probed ports (22, 80, 443, 2376, 8080, 9090, 8500, 4001, 2379, 5000, 9091)
return *Connection refused*. The Firecracker API socket is host-side Unix domain only, not
exposed over TCP to guests (the MAC pair is noted under *Interface* above).

## iptables

No iptables rules inside the VM. The network allowlist is entirely host-side.

## vsock

A `/dev/vsock` device is present but the current deployment uses TCP (port 2024) not vsock. The process_api binary supports both modes:
- `--listen-vsock-port` for Firecracker vsock mode
- `--addr` for TCP mode (current)

## dp_mtls

In production deployments, the WebSocket connection to port 2024 uses **dp_mtls** (dataplane mutual TLS) for authentication between the host orchestration and the VM. The current "wiggle" deployment uses plain TCP as fallback:

```
restored on a server without dp_mtls. TCP :2024 remains available.
```

### Two Anthropic CA families are pre-installed (in-sandbox)

The base snapshot image ships **four** internal CA certs in
`/usr/local/share/ca-certificates/` (symlinked into `/etc/ssl/certs/`, installed
2026-04-18 = snapshot creation date):

| File | CN | Valid from |
|---|---|---|
| `swp-ca-production.crt` | sandbox-egress-**production** TLS Inspection CA | Jul 2025 |
| `swp-ca-staging.crt` | sandbox-egress-**staging** TLS Inspection CA | Jul 2025 |
| `egress-gateway-ca-production.crt` | sandbox-egress-gateway-**production** Egress Gateway CA | **Feb 2026** |
| `egress-gateway-ca-staging.crt` | sandbox-egress-gateway-**staging** Egress Gateway CA | Feb 2026 |

- **`swp-ca`** ("SWP" = Secure/Sandboxed Workload Platform) is the **TLS-inspection MITM
  CA** from §"TLS Inspection Proxy" — the same `sandbox-egress-production TLS Inspection CA`
  cert observed live on the egress proxy. (So the on-disk filename is `swp-ca-production.crt`;
  process_api also writes it as `sandboxing-egress-ca.pem`.)
- **`egress-gateway-ca`** is a *separate, newer* CA (issued Feb 2026, ~4 months after swp-ca).

### Reconstructed dp_mtls flow *(inferred from the CAs; no client-cert material in the VM)*
The `egress-gateway-ca` is **almost certainly the CA that signs the host's client
certificate** for dp_mtls. In dp_mtls mode: the host opens a **TLS** connection to :2024
and presents a client cert signed by `egress-gateway-ca-production`; process_api verifies it
against the installed CA; authentication is at the TLS layer, so **no JWT/Ed25519 is needed**
and the first WS message is parsed directly as `CreateProcess`. On the wiggle (no-dp_mtls)
cluster it's plain TCP with the fail-open JWT path (see `05`/`07`). The CAs are baked into the
shared base image, which is why they're present even on a cluster that doesn't use dp_mtls. No
client private key / signed cert was found in the VM — that material is host-side only.
