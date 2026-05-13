# Deploy

Production deployment guide for `burrow serve`. Local single-machine use needs none of this — `bun install -g @os-eco/burrow-cli` and you're done. This document is for running burrow as a long-lived daemon that other processes (warren, overstory, mycelium, ad-hoc HTTP clients) drive over its API.

> **Scope.** Linux is the canonical deploy target. macOS is developer ergonomics, not a deploy posture (see [SPEC §8](SPEC.md#8-sandbox-isolation)). Everything below assumes a Linux host or a Linux container.

## TL;DR

- **Default: run `burrow serve` directly on a Linux host.** A VM, Fly Machine, EC2 instance, or bare metal box. No outer container. Modern kernels support unprivileged user namespaces out of the box; bwrap nests cleanly with no admission-policy negotiation.
- **Acceptable: run `burrow serve` inside a container** (Docker, self-managed Kubernetes, single-tenant ECS) **with four security flags.** This is the warren container's posture and the local devcontainer's posture; it works, but the relaxations partly defeat the point of nesting and require a privileged-workload waiver in most multi-tenant clusters.
- **Don't: run `burrow serve` inside a managed multi-tenant pod** (Cloud Run, ECS Fargate with default policy, GKE Autopilot, or any cluster where you can't grant the four flags). The admission policy will reject the workload, and even if it didn't, the four flags relax the outer container further than most multi-tenant clusters tolerate.
- **Scaling out: one `burrow serve` per host, fronted by a TLS-terminating reverse proxy, behind a control plane** like [warren](../warren/SPEC.md) that picks which worker owns each new burrow. See [Multi-worker topology](#multi-worker-topology) below — the threat model is a VPC-private network with bearer-auth gating each worker.

## Why on-host is preferred

`bwrap` is the isolation primitive on Linux. It needs `unshare(CLONE_NEWUSER)` to create the burrow's user namespace, plus a few additional kernel capabilities for mount and network setup. On modern Linux hosts that just works. Inside a managed container, the outer runtime's default security profile typically blocks one or more of these:

| Need | Default container blocker | Override |
|---|---|---|
| `unshare(CLONE_NEWUSER)` | Ubuntu 24.04+ ship `kernel.apparmor_restrict_unprivileged_userns=1`; Docker's default AppArmor profile blocks it | `--security-opt apparmor=unconfined` |
| `clone3` shape for new namespaces | Docker's default seccomp profile is mostly fine but blocks specific argument shapes | `--security-opt seccomp=unconfined` |
| Mount `/proc` in the new pid+mount namespace | Container masks `/proc` paths | `--security-opt systempaths=unconfined` |
| Bring up `lo` in the new netns | `RTM_NEWADDR` needs `CAP_NET_ADMIN` (implied by `SYS_ADMIN`) | `--cap-add SYS_ADMIN` |

Any one missing causes a different bwrap failure mode (`EPERM` at `unshare`, `Failed RTM_NEWADDR`, `Can't mount proc on /newroot/proc`, etc.). The four-flag set is the empirically minimum override that lets non-privileged bwrap nest. Verified on Ubuntu 24.04 / Docker 28.4. `--privileged` works too but relaxes the outer container far more than necessary.

In multi-tenant managed Kubernetes / ECS / Cloud Run, granting those four overrides is a privileged-workload waiver in admission policy. It's possible but expensive to negotiate, and it punches a security hole in the outer container that arguably makes the nesting net-negative.

Skip the negotiation: run burrow on the host.

## burrow-on-host (recommended)

A Linux VM, Fly Machine, EC2 instance, or bare metal host. Burrow runs as a systemd service, listens on a unix socket, and is consumed locally (warren co-tenanted on the same host) or over a reverse proxy with TLS termination.

### Prerequisites

- Linux kernel ≥ 5.10 (for stable unprivileged userns).
- `bubblewrap` installed (`apt install bubblewrap`, `dnf install bubblewrap`, etc.).
- `bun` ≥ 1.1 installed system-wide or via a service-account user.
- A non-root user that the daemon runs as (`useradd -r -m burrow`).
- Confirm unprivileged userns works:

  ```bash
  unshare -Ur whoami     # → root if userns works
  bwrap --bind / / --proc /proc true && echo ok
  ```

  If `apparmor_restrict_unprivileged_userns=1` is set on the host, either flip it (`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`, persisted in `/etc/sysctl.d/`) or install an AppArmor profile that allows it for the burrow user. The host kernel choice is yours; on a single-purpose VM, flipping the sysctl is the simplest answer.

### Reference systemd unit

`/etc/systemd/system/burrow.service`:

```ini
[Unit]
Description=Burrow sandbox runtime
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=burrow
Group=burrow
Environment=BURROW_DATA_DIR=/var/lib/burrow
EnvironmentFile=/etc/burrow/burrow.env       # BURROW_API_TOKEN=...
ExecStart=/usr/local/bin/burrow serve --socket /run/burrow/burrow.sock
RuntimeDirectory=burrow
RuntimeDirectoryMode=0750
StateDirectory=burrow
StateDirectoryMode=0750
Restart=on-failure
RestartSec=5

# Don't sandbox the sandboxer — bwrap needs the kernel surface intact.
# Specifically: NoNewPrivileges + Protect* would block the userns nesting
# burrow itself relies on.

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo install -d -o burrow -g burrow -m 0750 /etc/burrow
sudo install -m 0640 -o burrow -g burrow /dev/stdin /etc/burrow/burrow.env <<< "BURROW_API_TOKEN=$(openssl rand -hex 32)"
sudo systemctl daemon-reload
sudo systemctl enable --now burrow.service
```

The socket lives at `/run/burrow/burrow.sock` (group-readable for `burrow:burrow`). Co-tenanted consumers (warren, an HTTP gateway) run as the same group and connect directly. Cross-host consumers go through a reverse proxy that terminates TLS and forwards to the socket.

### Reference Fly Machine config

`fly.toml` (run as a single Machine, not a multi-instance app):

```toml
app = "burrow-prod"
primary_region = "sjc"

[build]
  image = "ghcr.io/jayminwest/burrow:0.3.0"   # or your own build

[mounts]
  source = "burrow_data"
  destination = "/var/lib/burrow"

[env]
  BURROW_DATA_DIR = "/var/lib/burrow"

[[services]]
  internal_port = 4040
  protocol = "tcp"
  auto_stop_machines = "off"
  auto_start_machines = false
  min_machines_running = 1

  [[services.ports]]
    port = 443
    handlers = ["tls", "http"]
```

Set the API token as a Fly secret:

```bash
fly volumes create burrow_data --size 20 --region sjc
fly secrets set BURROW_API_TOKEN=$(openssl rand -hex 32)
fly deploy
```

The Fly Machine is a Firecracker VM, not a managed container — bwrap nests without any of the four security flags. Treat the Machine as the host.

## burrow-in-pod (acceptable, with caveats)

Acceptable in:
- Self-managed Kubernetes clusters where you control admission policy and can grant the four flags.
- Single-tenant clusters with no shared-trust constraints (one team, one workload, one cluster).
- Dev / CI environments where the relaxation is fine (the local devcontainer uses this posture — see [README §"Linux dev container"](README.md#linux-dev-container)).
- The warren container ([warren SPEC §5.3](../warren/SPEC.md#53-sandbox-nesting)), which is single-user single-tenant by design.

Not acceptable in:
- Multi-tenant managed Kubernetes / ECS Fargate / Cloud Run / GKE Autopilot.
- Anywhere admission policy is restrictive and not yours to change.
- Any production-swarm posture where the security relaxation would be load-bearing.

### The four flags

Whatever the orchestrator, the four overrides are the same:

```yaml
# docker-compose.yml fragment
services:
  burrow:
    image: ghcr.io/jayminwest/burrow:0.3.0
    security_opt:
      - apparmor=unconfined
      - seccomp=unconfined
      - systempaths=unconfined
    cap_add:
      - SYS_ADMIN
    volumes:
      - burrow_data:/var/lib/burrow
      - /run/burrow:/run/burrow
    environment:
      - BURROW_DATA_DIR=/var/lib/burrow
    env_file: /etc/burrow/burrow.env
    command: ["burrow", "serve", "--socket", "/run/burrow/burrow.sock"]
```

For Kubernetes, the equivalent is a `securityContext` with `capabilities.add: ["SYS_ADMIN"]` plus the AppArmor / seccomp annotations (`container.apparmor.security.beta.kubernetes.io/<name>: unconfined`, `seccompProfile.type: Unconfined`). `systempaths=unconfined` has no Kubernetes equivalent — you typically need a privileged container or a custom kubelet-level workaround. **This is the friction point that pushes most cluster operators toward burrow-on-host.**

## Verification

After deploy, confirm the daemon is healthy and bwrap nests:

```bash
# socket reachable
curl --unix-socket /run/burrow/burrow.sock \
     -H "Authorization: Bearer $BURROW_API_TOKEN" \
     http://localhost/burrows
# → []  (or your existing burrows)

# OpenAPI surface live
curl --unix-socket /run/burrow/burrow.sock \
     -H "Authorization: Bearer $BURROW_API_TOKEN" \
     http://localhost/openapi.json | jq '.info.version'

# end-to-end: provision a burrow against a test repo, run something, destroy
sudo -u burrow burrow doctor
sudo -u burrow git clone https://github.com/your/test-repo /var/lib/burrow/test-repo
sudo -u burrow burrow up --project /var/lib/burrow/test-repo
```

If `burrow up` fails with `bwrap: unshare(CLONE_NEWUSER): Operation not permitted`, the userns gate is closed — recheck the prerequisites. If it fails with `bwrap: Can't mount proc on /newroot/proc`, you're inside a container missing `systempaths=unconfined`.

## Multi-worker topology

A single `burrow serve` process is one host's worth of capacity: bwrap (or sandbox-exec on dev hosts) runs the agent inline, the dispatcher and HTTP listener share one Bun process, and SQLite owns the per-host state. Scaling past one host means running N workers — one `burrow serve` per host — and putting a control plane (typically [warren](../warren/SPEC.md)) in front to pick which worker owns each new burrow.

```
        ┌────────────────────────┐
        │  warren (control plane)│
        └────────────┬───────────┘
                     │  HTTPS + Bearer
        ┌────────────┼────────────┐
        │            │            │
    ┌───▼───┐    ┌───▼───┐    ┌───▼───┐
    │worker1│    │worker2│    │worker3│
    │ proxy │    │ proxy │    │ proxy │ ← Caddy / nginx (TLS terminator)
    │   │   │    │   │   │    │   │   │
    │ burrow│    │ burrow│    │ burrow│ ← burrow serve, loopback or unix
    │ serve │    │ serve │    │ serve │
    │ + DB  │    │ + DB  │    │ + DB  │ ← per-worker SQLite, per-worker
    └───────┘    └───────┘    └───────┘   sandboxes — no shared state
```

### Threat model and what burrow does / doesn't ship

V1 assumes a **VPC-private network** between the control plane and the workers — Tailscale, an AWS VPC, a Fly private 6PN, an internal Kubernetes service mesh. The bearer-auth boundary is gating a network the operator already controls.

What `burrow serve` ships:

- **Bearer auth** via `BURROW_API_TOKEN` env (a single shared secret per worker).
- **`--bind-host` safety check.** `--bind-host` defaults to `127.0.0.1`. If you pass a non-loopback host (e.g. `0.0.0.0`, a private IP) AND set `--no-auth`, startup refuses with a `ValidationError` pointing at `BURROW_API_TOKEN`. The operator has to consciously turn the bearer on to expose burrow over TCP.
- **One unix-socket or TCP listener per worker.** No admin port; the bearer-auth boundary is the security perimeter.

What burrow does **not** ship (operator's job):

- **TLS termination.** Burrow speaks plain HTTP; put a reverse proxy on each worker that terminates TLS (recipe below). The proxy is the only thing the control plane talks to over the network.
- **mTLS.** Not in V1. Tracked as a future hardening item.
- **Per-user / per-worker tokens.** A single `BURROW_API_TOKEN` is shared across the worker pool. Rotation is one env-var update across N workers + the control plane; document it in your runbook. Per-worker tokens are a future hardening item.

### Topology choices

| Shape | When to use |
|---|---|
| **Co-tenanted: warren + burrow on the same host, unix socket** | Default single-host posture (warren's container, a single VM). Warren talks to `/run/burrow/burrow.sock` directly — no TLS, no bearer, kernel ACLs gate access. This is what the [reference systemd unit](#reference-systemd-unit) ships. |
| **Cross-host: warren on one host, burrow workers on N hosts** | Horizontal scale. Each worker binds a TCP port behind a per-worker reverse proxy on `:443`. Warren holds the bearer and an HTTPS URL per worker. **This is the topology the rest of this section covers.** |

### Worker config: bind to a non-loopback interface

Per-worker, replace the unix-socket flag with `--bind-host` and `--port`:

```ini
# /etc/systemd/system/burrow.service  (cross-host worker)
ExecStart=/usr/local/bin/burrow serve --bind-host 127.0.0.1 --port 4040
```

Keep `--bind-host` on **loopback** — the reverse proxy on the same host terminates TLS and forwards to it. Don't expose `--bind-host 0.0.0.0` on a worker that already has a TLS proxy; the proxy is the only thing that should hit the burrow listener.

If your topology *doesn't* have a co-located proxy (e.g. you're terminating TLS at a load balancer hop away), bind to a private interface (`--bind-host 10.0.0.5 --port 4040`) and ensure host-firewall rules restrict the port to the control-plane's source. With `--no-auth` set in that posture, `burrow serve` refuses to start — that's the safety gate.

The `BURROW_API_TOKEN` env (loaded from `/etc/burrow/burrow.env`) must be identical across every worker in the pool and on the control-plane host.

### Reverse proxy + TLS termination (per worker)

Both recipes below run on the **same host** as `burrow.service` and front a loopback-bound burrow. Pick one.

**Caddy** (automatic Let's Encrypt issuance, simpler config):

```caddyfile
# /etc/caddy/Caddyfile
worker-1.burrow.internal {
  reverse_proxy 127.0.0.1:4040 {
    # Streaming surfaces (/runs/:id/stream, /burrows/:id/events, /watch) emit
    # NDJSON over chunked HTTP with idleTimeout=0 on burrow's side; mirror
    # that on the proxy so long-lived streams don't get reaped.
    transport http {
      read_timeout 0
      write_timeout 0
    }
    flush_interval -1
  }
}
```

**nginx** (explicit certs, fine-grained control):

```nginx
# /etc/nginx/conf.d/burrow.conf
server {
  listen 443 ssl http2;
  server_name worker-1.burrow.internal;

  ssl_certificate     /etc/letsencrypt/live/worker-1.burrow.internal/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/worker-1.burrow.internal/privkey.pem;

  # Streaming surfaces need timeouts disabled and buffering off so warren
  # sees NDJSON events as they're emitted, not in proxy-flushed chunks.
  proxy_buffering   off;
  proxy_read_timeout 0;
  proxy_send_timeout 0;
  proxy_http_version 1.1;

  location / {
    proxy_pass http://127.0.0.1:4040;
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

In both cases the control plane's URL is `https://worker-1.burrow.internal/`, and every request carries `Authorization: Bearer $BURROW_API_TOKEN`. The proxy never sees the token (it's an opaque request header to it).

### Rotating the bearer token

Because the pool shares one token, rotation is fan-out, not per-worker. The runbook:

1. Generate a new token: `openssl rand -hex 32`.
2. On the **control plane**, set the new token as a second valid value if your control plane supports overlapping tokens (warren does not in V1 — see warren's worker config docs). Otherwise schedule a coordinated cutover.
3. On **each worker**, update `/etc/burrow/burrow.env` and `systemctl restart burrow.service`. Existing in-flight runs persist (they live in SQLite), but in-flight HTTP streams will drop and need reconnect.
4. Update the control plane's stored token and restart it.
5. Verify with a `GET /openapi.json` from the control plane to each worker.

For zero-drop rotation, drain each worker before restart (`POST /admin/drain` — shipping in `burrow-79ad`, pl-cb3e step 4) so the control plane stops scheduling new work on that host while existing runs finish.

### Multi-worker invariants

- **One worker per `BURROW_DATA_DIR`.** Concurrent processes would race the startup sweep that flips orphaned `running` rows to `failed`. See [Cross-process dispatch contract](#cross-process-dispatch-contract) below.
- **State doesn't move between workers.** A burrow lives on the host it was created on; the workspace, the SQLite row, the events, and the in-flight sandbox processes are all per-host. The control plane is responsible for routing follow-up requests (`POST /burrows/:id/runs`, `GET /runs/:id/stream`) to the same worker that owns the burrow.
- **Restarts are local.** A worker that restarts mid-run flips its own in-flight rows to `failed` on startup. The control plane has to retry by enqueuing a fresh run, not by resurrecting the failed row.

## Reverse proxy (single-host)

For a single worker with co-tenanted consumers on the same host, the `unix://` backend is enough — no TCP port to expose:

```caddyfile
# Caddyfile, host running on the same machine as burrow.service
burrow.example.com {
  reverse_proxy unix//run/burrow/burrow.sock {
    transport http {
      read_timeout 0
      write_timeout 0
    }
    flush_interval -1
  }
}
```

Bearer auth via `BURROW_API_TOKEN` is the only auth gate; it's a single token, no rotation, no per-user scope (see [SPEC §27](SPEC.md#27-http-api-burrow-serve) for the security posture). Multi-user is an explicit non-goal — if you need it, run a control plane like [warren](../warren/SPEC.md) in front of burrow.

## Cross-process dispatch contract

`burrow serve` is a single-process, stateful-per-host worker: the HTTP listener and the run dispatcher live in the same Bun process, sharing the per-host SQLite DB (`$BURROW_DATA_DIR/db.sqlite`, WAL mode). When a remote client (warren, an HTTP gateway, `curl`) POSTs `/burrows/:id/runs`, the dispatcher inside that same process picks the row up off the create-time hook and drives it to a terminal state — `succeeded`, `failed`, or `cancelled` — without any further intervention from the caller. This is what makes burrow viable as the unit of cross-host fan-out: a control plane only has to know how to talk HTTP and observe the run row over `/runs/:id` (or `/runs/:id/stream`); the executor lives with the workspace.

Two operational implications:

- **Don't run two `burrow serve` processes against the same `BURROW_DATA_DIR`.** The dispatcher's startup sweep flips orphaned `running` rows from a previous process to `failed`; a second concurrent process would race the same sweep and risk double-claim. One worker per data dir.
- **Crash recovery is local.** If a worker dies mid-run, the next start sweeps in-flight rows to `failed` (with `errorMessage` recording the orphaned state). A control plane that wants at-least-once execution has to retry by enqueuing a fresh run, not by resurrecting the failed row.

The locked test for this contract is `src/server/dispatcher-cross-process.test.ts` — it spawns `burrow serve` as a real OS subprocess, POSTs a run over TCP, and asserts the row reaches `succeeded` without any in-process help. Cross-host warren topologies depend on this behaviour.

## Decision record

This document supersedes the deploy-posture sections of [SPEC.md §8](SPEC.md#8-sandbox-isolation) and resolves [ROADMAP.md R-01](ROADMAP.md#r-01--prefer-burrow-on-host-over-burrow-in-pod-userns-nesting). The empirical work was done in `burrow-0fab` (the macOS-vs-Linux design discussion); the standalone decision was `burrow-7ba7`; this guide is the executable form.

Related expertise: `mx-94901b`, `mx-c085ba` (the four-flag recipe).
