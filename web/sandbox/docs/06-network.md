# Network Configuration

## Interface

```
eth0: 192.0.2.2/24
Gateway: 192.0.2.1 (host, MAC: 02:fc:00:00:00:05)
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

The egress proxy returns an `x-deny-reason` header on blocked requests.

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
