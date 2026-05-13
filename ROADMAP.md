# Burrow Roadmap

Direction for burrow as it scales from solo / single-machine use to multi-machine
swarms and team-of-50+ adoption. Each item is a self-contained idea with a stable
ID for reference. Items can be sequenced independently; the dependency graph is
captured per-item.

This file is the punch list, not the spec. Items here become seeds issues when
committed to. [SPEC.md](SPEC.md) is the frozen V1 design record; ROADMAP.md is
the forward-looking direction.

## Status legend

- `[proposed]` — under discussion, not committed
- `[in-progress]` — actively being built
- `[partially shipped]` — some sub-items released, others still open
- `[shipped]` — released
- `[deferred]` — useful but not now

## Item template

New items follow this shape so the format doesn't drift:

    ## R-NN — Title
    Status: [proposed]
    Depends on: —
    Unlocks: —

    **Problem.** One paragraph: what breaks today, especially as burrow leaves
    single-machine local use.

    **Sketch.** Short description or config/code example of the proposed shape.
    Not a spec.

    **Open questions.** Bullets — things to decide before or during implementation.

---

## R-01 — Prefer burrow-on-host over burrow-in-pod (userns nesting)
Status: [shipped]
Depends on: —
Unlocks: R-02 (FlyProvider deploy posture); deploy guides in warren / overstory link to burrow's [DEPLOY.md](DEPLOY.md)

**Resolution.** Lives at [DEPLOY.md](DEPLOY.md): on-host is the production
default; in-pod is acceptable for self-managed / single-tenant / dev-CI
postures with the four-flag bwrap recipe, not acceptable in multi-tenant
managed K8s/ECS/Cloud Run. Reference systemd unit + Fly Machine config
included. Both open questions resolved (guide lives in burrow; reference
configs ship inline).

**Original problem (preserved for context).** For deploying burrow swarms in the cloud, bwrap needs unprivileged
user namespaces. On modern Linux hosts that works directly. Inside a managed
container (K8s, ECS Fargate, Cloud Run), the outer runtime's default security
profile typically blocks userns creation:

- Ubuntu 24.04 hosts ship `kernel.apparmor_restrict_unprivileged_userns=1`.
  Containers without an explicit AppArmor profile can't `unshare(CLONE_NEWUSER)`.
- Docker default seccomp is fine, but the docker-default AppArmor profile blocks
  userns; you need `--security-opt apparmor=unconfined`.
- bwrap also wants `SYS_ADMIN` (loopback in new netns) and
  `systempaths=unconfined` (mount /proc past masked paths).

Empirically (burrow-0fab spike, Ubuntu 24.04 host, Docker 28.4) the minimum
viable in-container invocation is 4 security overrides:

    --security-opt apparmor=unconfined
    --security-opt seccomp=unconfined
    --security-opt systempaths=unconfined
    --cap-add SYS_ADMIN

In production K8s / ECS / Cloud Run terms that's a privileged-workload waiver
in most clusters' admission policy. Possible but expensive to negotiate, and
the security relaxation of the outer container partly defeats the point of
nesting.

**Sketch.** Default deployment posture: burrow daemon runs directly on a Linux
host (VM, Fly Machine, EC2). No outer container. burrow-in-pod is acceptable in
self-managed clusters where you control admission policy, single-tenant
clusters with no shared-trust constraints, and dev/CI where the relaxation is
fine. burrow-on-host is the right call for multi-tenant managed K8s/ECS/Cloud
Run, anywhere admission policy is restrictive and not yours to change, and as
the production-swarm default.

**Open questions (resolved).**
- ~~Where the deploy guide actually lives.~~ → `burrow/DEPLOY.md`. Warren,
  overstory, greenhouse cross-link in.
- ~~Reference systemd unit / Fly Machine config alongside.~~ → both
  included inline in DEPLOY.md.

**Related.**
- burrow-9986 (executed R-01 — wrote DEPLOY.md, this status flip)
- burrow-7ba7 (closed into this; was the standalone decision record)
- burrow-fbdf (closed; required Anthropic upstream action)
- burrow-0fab (parent decision discussion)

---

## R-02 — FlyProvider + SshProvider (remote `BurrowProvider`s)
Status: [deferred]
Depends on: R-01 (shipped — deploy posture in [DEPLOY.md](DEPLOY.md): Fly
Machines = on-host posture, no four-flag overrides needed); R-07
(workspace-seed HTTP API — without it, remote burrows have no contract for
warren to populate `.canopy/`, `.mulch/`, `.seeds/`)
Unlocks: cloud-deployed burrow swarms; the load-bearing test of the
`BurrowProvider` seam (SPEC §23)

**Why deferred (2026-05-09).** The original framing claimed warren-on-Fly
required a remote-daemon model — i.e., warren calling burrow over HTTPS at a
separate Fly Machine. That misreads warren's actual deploy story. Warren
SPEC §10.2 + §5.1 + §10.3 deploy warren and `burrow serve` as **sibling
processes inside one container**, talking over a unix socket at
`/var/run/burrow.sock`; `fly deploy` just relocates that container to a Fly
Machine. Warren SPEC §3.2 makes this explicit:

- "No remote burrow workers. Burrows run inside warren's container; no
  FlyProvider-driven worker pool."
- "No laptop-driven `burrow up` against warren."

So warren-on-Fly does *not* need `FlyProvider` or `SshProvider`. The
remaining justification — proving SPEC §23's seam-genericity criterion —
holds on its own merits but doesn't justify a 7-step build without a
concrete consumer pulling on the seam. **Revisit when** something actually
needs remote burrows: warren V2 worker pool, greenhouse dispatching to a
shared burrow daemon, or `burrow up --remote` becoming a real laptop
workflow.

Closed 2026-05-09: parent `burrow-c408` + plan `pl-9caa` (steps
`burrow-f578`, `burrow-8e00`, `burrow-b04f`, `burrow-4c9c`, `burrow-cca0`,
`burrow-533f`, `burrow-32d0`).

**Original problem (preserved for context).** V1 ships only `LocalProvider`.
SPEC §23's last success criterion
— "a future `FlyProvider` can be added without modifying any file under
`src/core/`, `src/db/`, `src/runtime/`, `src/inbox/`, `src/events/`, or
`src/runner/`" — is unverified until at least one remote provider actually
lands. And until *two* land, "the seam is generic" is just "the seam is
Fly-shaped."

**Sketch.** The remote-daemon model: a long-lived `burrow serve` runs on a
host (Fly Machine or SSH'd VPS) per DEPLOY.md's on-host posture. `burrow up
--remote fly` is `POST /burrows` over HTTPS against that daemon's endpoint,
not a fresh Fly Machine boot per burrow. Cold start is paid once at
machine-up, not per `burrow up`. Each remote burrow's workspace is `kind:
'clone'` (no shared filesystem with the caller). User-facing surface stays
identical:

    burrow up                          # local
    burrow up --remote fly             # fly machine
    burrow up --remote my-vps          # named SSH remote
    burrow events --follow             # works the same against any of them

The provider seam splits cleanly into two responsibilities — machine
lifecycle and daemon binding:

- `LocalProvider`: no lifecycle (`$localhost`); spawn or attach local
  `burrow serve`.
- `FlyProvider`: lifecycle = ensure a Fly Machine exists for this user;
  binding = HTTPS to that machine.
- `SshProvider`: no lifecycle (user already deployed per DEPLOY.md);
  binding = HTTPS to user's registered host.

`SshProvider` is essentially a *registration*: `burrow login ssh
https://my-vps --token …` records a named remote, and everything downstream
is shared `HttpClient` + URL code. Shipping Fly + SSH together is the
load-test — anything Fly-specific that leaks past the lifecycle boundary
will fail to compile against `SshProvider`.

Acceptance bar: both providers land without modifying any file under
`src/core/`, `src/db/`, `src/runtime/`, `src/inbox/`, `src/events/`, or
`src/runner/` (SPEC §23's last criterion made load-bearing).

**Decisions made (2026-05-08 design discussion).**
- **Interpretation A (remote daemon), not B (per-burrow Fly Machine).** One
  machine = one daemon = many burrows. Per-burrow Fly Machine boot is a
  future scale-out layer on top, not the same product.
- **Primary consumer is warren-on-Fly.** Solo-user `burrow up --remote fly`
  from a laptop is supported but not the dominant case. Tilts the design
  toward persistent-machine, not ephemeral.
- **Fly + SSH ship together.** Fly-only doesn't actually test "the seam is
  generic." Generic-SSH provider rides on the same daemon-binding code as
  Fly with no machine lifecycle of its own.
- **Workspace seeding goes through R-07's API**, not direct-disk writes.
  Warren's current shared-fs reach into burrow's workspace path is a
  co-location accident; R-02 cannot rely on it.

**Open questions.**
- Credential delivery to the remote machine — for warren-on-Fly, per-machine
  via Fly secrets (`ANTHROPIC_API_KEY`, `GITHUB_TOKEN`); per-burrow override
  is V2. Confirm.
- Auth from local CLI to remote daemon — bearer token identical to local
  `BURROW_API_TOKEN`, stored under a named profile in
  `~/.config/burrow/remotes.toml` (think `git remote`). `burrow login fly`
  and `burrow login ssh` populate it.
- Fly app provisioning — does FlyProvider create the Fly app on first use,
  or does the user run `fly launch` against a published burrow image and we
  attach? Lean attach-only for V1 (matches DEPLOY.md's "you provision the
  host"); add provisioning later as a convenience.
- Per-user tenancy on the Fly machine — one machine = one warren = many
  burrows is the model. Multi-tenanting a single Fly machine across warrens
  is explicitly out of scope.

---

## R-03 — `burrow snapshot` / `burrow restore`
Status: [proposed]
Depends on: —
Unlocks: time-travel debugging; reproducible "rewind to before the agent broke
this" workflows

**Problem.** Today a botched agent run leaves the workspace in whatever state
the agent reached. The user's recovery options are git-level (`git reset
--hard`) or destroy-and-recreate. Neither captures "the burrow at minute 7" in
a way you can re-spawn an agent against.

**Sketch.** Versioned workspace snapshots, tied to the burrow id. `burrow
snapshot <id> [--label NAME]` captures workspace + relevant DB state (runs,
events tail, messages in flight). `burrow restore <id> --to <snapshot>`
rewinds. Snapshots stored under `${dataDir}/snapshots/<burrow-id>/<snapshot-id>/`.

In-memory snapshots of a *running* agent (fork-of-running-state) stay V2+ —
SPEC §3.2 already excludes that. R-03 is the workspace-on-disk story.

**Open questions.**
- Storage shape: tarball, git ref under a hidden namespace, or content-addressed
  blob store?
- Retention policy — keep N most recent, prune-by-age, or manual-only?
- Does a snapshot restore reset the burrow's event log, or branch it the way
  `burrow fork` does?

---

## R-04 — Toolchain auto-install (mise / asdf integration)
Status: [proposed]
Depends on: —
Unlocks: zero-host-setup onboarding; closes SPEC §19's "V2 may introduce mise /
asdf integration" pointer

**Problem.** V1 toolchains live on the host. `burrow doctor` verifies them but
won't install. A new IC joining a project with a `burrow.toml` declaring
`bun = "1.1"` and `python = "3.12"` still has to install both before
`burrow up` succeeds.

**Sketch.** Detect the user's toolchain manager (mise → asdf → fnm → nvm) and
run its install command for missing entries before mounting toolchain bin dirs
into the sandbox. `burrow doctor --install` (or `--fix` if the existing flag
covers it) opts in. The sandbox itself stays clean — toolchains still install
to the host's manager, then mount read-only as today.

**Open questions.**
- Default behavior: silently install on `burrow up`, prompt, or require explicit
  `--install`? Probably prompt, since installing language runtimes is not free.
- Order of preference when multiple managers are detected.
- Per-project pinning: defer to the manager's own pin file (`.tool-versions`,
  `mise.toml`) when present; `burrow.toml: [toolchain]` is the override.

---

## R-05 — `burrow ship` target plugins
Status: [proposed]
Depends on: V1 `burrow ship` (shipped, SPEC §22 Phase 9)
Unlocks: org-internal deploy targets without forking burrow

**Problem.** V1 ships three first-class `ShipTarget`s — `fly`, `docker`,
`tarball` — chosen specifically to stress-test the interface across shape,
lifecycle, and real-world deploy. The interface holds, but `[ship].default_target`
is schema-locked to those three (mulch record `mx-966e8b`). Adding a 4th
target — internal registry, k8s deploy, S3 upload — currently requires forking.

**Sketch.** Discovery model parallel to mulch's R-04 (provider plugin registry,
shipped 2026-05-06):

1. **Filesystem convention:** `.burrow/ship-targets/<name>.{ts,sh}` auto-discovered.
2. **npm convention:** `burrow-ship-target-<name>` exports a `ShipTarget`.

`[ship].default_target` validates against the union of built-ins + discovered
targets. `burrow ship --list` surfaces sources and shadowed built-ins.

**Open questions.**
- Sandboxing for arbitrary shell ship-targets — same trust model as user-defined
  agents (`AgentConfig`, SPEC §12.3): users own what they install.
- Versioning — npm targets carry semver via package.json; filesystem targets
  pin to whatever's at the path.
- Whether the V1 built-ins move out of core into shipped target files, leaving
  the registry as just a loader (the natural follow-up; mulch's R-04 deferred
  this same step).

---

## R-06 — Substrate integration with Overstory and Mycelium
Status: [proposed — needs reframing, see note below]
Depends on: stable `burrow serve` API (shipped, SPEC §27)
Unlocks: agents dispatched into burrows from upstream orchestrators; replaces
overstory/mycelium's tmux dispatch with sandboxed burrows

**Reframing note (2026-05-13).** The two named consumers in this item have
shifted status since it was filed:

- **Mycelium** is unlikely to be picked up — direction is to fold its
  functionality into warren rather than keep it as a separate tool.
- **Overstory** is under reconsideration but not yet deprecated. The broader
  direction is moving away from hierarchical orchestrators (lead agent
  delegates to sub-agents delegates to workers) toward a human-as-node /
  shared-substrate pattern where agents read and write a common substrate
  (`.seeds/` / `.canopy/` / `.mulch/` / `.warren/`) rather than chaining
  through layers of delegation. If that pattern wins, overstory's
  hierarchy-shaped value proposition narrows; if some workloads still want
  hierarchy, overstory's burrow adoption stays useful.
- **Warren has already validated the underlying claim** that this item was
  meant to prove. Warren consumes burrow's HTTP API today (`HttpClient`
  over unix socket, shipped 0.3.0); it never used tmux. The "upstream tools
  consume burrow's HTTP API" pattern is shipped in spirit — what's
  outstanding is just whether overstory specifically adopts it.

Open questions this reframing raises:
- Does R-06 collapse into "shipped via warren; overstory adoption is
  contingent on overstory's own future," with mycelium removed from the
  item entirely? Lean yes — but hold off pending the overstory decision.
- Are there *other* would-be substrate consumers that justify keeping a
  generic R-06 open (greenhouse? sapling-as-standalone? third-party tools
  building on burrow)? If so, rename to "Substrate adoption by upstream
  consumers" and drop the overstory/mycelium specifics.
- If overstory is deprecated, does the substrate framing make burrow's
  primary identity "warren's sandbox runtime" rather than "general
  sandbox primitive"? Has implications for whether burrow stays its own
  repo (see warren/burrow merge-vs-split discussion, 2026-05-13).

The original sketch follows for context; treat it as scoped to the
overstory/mycelium pair, not as a generic substrate-adoption claim.

**Problem.** Today overstory and mycelium dispatch agents into tmux sessions on
the host. The host has no isolation; a botched agent can touch the user's real
filesystem. Burrow exists to fix exactly that, but the upstream tools haven't
adopted it as their substrate yet.

**Sketch.** Overstory and mycelium consume burrow's HTTP API (SPEC §27) instead
of spawning tmux. A run dispatched from overstory becomes a `POST /runs` against
a burrow's serve socket; events stream back over `GET /runs/:id/stream`.
Burrow's CLI/API stays unchanged; consumption is purely additive on the upstream
side.

Acceptance bar: overstory's `ov dispatch` and mycelium's equivalent can target
either tmux (legacy) or burrow (new) via config, with no per-tool changes in
burrow.

**Open questions.**
- Whose repo owns the dispatcher glue — burrow client library vs. an
  overstory/mycelium adapter consuming `HttpClient`?
- Migration story — flag-gated rollout per project, or an `ov.toml`
  `runtime = "burrow"` opt-in?
- Whether warren (the control plane this work feeds) needs anything beyond
  what `burrow serve` already exposes.

---

## R-07 — Workspace-seed HTTP API
Status: [shipped] (burrow side); warren-side adoption pending
Depends on: —
Unlocks: warren stops reaching into burrow's workspace path via shared
filesystem; also prerequisite for R-02 (remote burrows have no shared disk
to reach into) if/when R-02 is picked up

**Resolution.** Shipped as plan `pl-2467` (closed 2026-05-09) across four
child seeds:

- `burrow-da98` — OpenAPI schemas + golden test
- `burrow-9dbd` — Path validation primitive (`src/server/workspace-paths.ts`)
- `burrow-30c7` — Server handlers: `POST /burrows` with `seed`,
  `POST /burrows/:id/files`, `GET /burrows/:id/files`
- `burrow-ba5c` — `HttpClient` methods: `burrows.create({ seed })`,
  `files.write`, `files.read`

Path validation rejects empty paths, NUL bytes, absolute paths, `..`
traversal, reserved entries (`.git`, `.gitconfig.burrow`), and symlinks
whose realpath escapes the workspace root. Writers open with `O_NOFOLLOW`
to close the TOCTOU window. The provision-time seed is atomic: a failed
seed write rolls back the burrow so the caller never observes a
half-seeded workspace.

Open questions all resolved:
- ~~Read side included?~~ → Yes; `GET /burrows/:id/files?path=…&encoding=…`
  ships in the same plan.
- ~~Binary content?~~ → JSON+base64; multipart deferred until a real
  consumer needs it.
- ~~Quota / size limits?~~ → Not enforced in V1; revisit if abuse surfaces.
- ~~When warren switches over?~~ → Tracked downstream in warren's tracker;
  burrow side does not gate on it.

**Remaining work (warren-side).** Warren's `src/runs/seed.ts` still writes
`.canopy/agent.json`, `.mulch/expertise/*.jsonl`, `.seeds/workflow.txt`
directly to `burrow.workspacePath` on disk. The reap step in §11.A still
reads `.mulch/expertise/*.jsonl` back off disk. Both need to switch to
`HttpClient.burrows.create({ seed })` + `files.read`. Filed as a separate
seed in the warren repo (2026-05-13).

---

## Decisions already made

Choices locked in during prior design discussions. Captured here so they aren't
relitigated when items become seeds issues.

- **Linux is canonical, macOS is best-effort + thin permission filter**
  (burrow-0fab Q1). End goal is swarms of agents in cloud-deployed Linux
  containers; macOS stays as developer-ergonomics mode. Synthesizing bwrap
  parity on macOS via DYLD/wrapper tricks is rejected.
- **No host /tmp deny on macOS in V1** (burrow-0fab Q2). Blocked on (a)
  claude-code hardcoding /tmp and ignoring `$TMPDIR` (upstream issue, was
  burrow-fbdf), and (b) sandbox-exec having no bind-mount primitive. Linux
  already private-tmpfs's /tmp via bwrap. Revisit when the upstream lands.
- **Best-effort accommodation for shipped agents; user-spawned binaries accept
  collision and document** (burrow-0fab Q3).
- **Ergonomic profile only in V1; no `strict` knob** (burrow-0fab Q4). Splitting
  the profile adds complexity without buying real isolation given Q1.
- **Userspace HTTP proxy for restricted-network enforcement** over IP-resolution
  and port-only options (mulch decision `mx-d6a44f`). Resolved SPEC §25 Q2.
- **Phase 9 ship V1 targets are fly + docker + tarball, not fly + render**
  (mulch decision `mx-ef364e`). The second/third targets exist primarily to
  prove the `ShipTarget` interface is genuinely generic.
- **`BurrowProvider` is the single load-bearing seam** (SPEC §3.3). Tenant id,
  Storage interface, Queue interface, queue_jobs table — none of those survive.
- **JSONL/SQLite-in-WAL is non-negotiable.** Every item assumes the storage
  substrate stays.

## Cross-cutting themes

Threads that run through multiple items.

- **Remote substrate (R-01, R-07, R-06; R-02 deferred).** R-01 picks the
  deploy posture, R-07 closes the workspace-mutation contract gap (shipped
  burrow-side; warren-side adoption is the remaining work), R-06 lets
  upstream tools consume burrow's HTTP API as a substrate. R-02 (remote
  `BurrowProvider`s) was the original seam load-test, but warren-on-Fly
  co-locates burrow in-container — so R-02 is deferred until a concrete
  consumer needs remote burrows.
- **Plugin registries (R-05, parallels mulch R-04).** Burrow already takes user
  extension via `[[agents]]`; ship targets are the next surface. Future
  registries (sandbox profiles? secret resolvers?) should follow the same
  discovery shape.
- **The seam load-test (R-02, deferred).** Until a second `BurrowProvider`
  actually exists, SPEC §23's last success criterion ("a future `FlyProvider`
  can be added without modifying any file under `src/core/`...") stays
  unverified. The argument holds; what's missing is a consumer that actually
  needs the seam exercised. Revisit when one shows up.

## Recently shipped

Cross-references to closed work that maps onto post-V1 direction. Tracked here
so subsequent revisions know what's already off the punch list.

- **R-07 workspace-seed HTTP API** (plan `pl-2467`, closed 2026-05-09).
  Provision-time `seed` on `POST /burrows` is atomic with provisioning; a
  failed seed rolls the burrow back. Standalone `POST /burrows/:id/files`
  and `GET /burrows/:id/files?path=…&encoding=…` cover top-up writes and
  reaps. Path validation in `src/server/workspace-paths.ts` rejects `..`,
  absolute paths, reserved entries (`.git`, `.gitconfig.burrow`), and
  symlink escapes; writes use `O_NOFOLLOW`. `HttpClient` exposes typed
  `burrows.create({ seed })`, `files.write`, `files.read`. Child seeds:
  `burrow-da98` / `burrow-9dbd` / `burrow-30c7` / `burrow-ba5c`.
  Warren-side adoption tracked in warren's tracker.
- **R-01 deploy posture — [DEPLOY.md](DEPLOY.md)** (burrow-9986). On-host is
  the production default; in-pod is acceptable for self-managed / single-tenant
  / dev-CI postures with the four-flag bwrap recipe (`mx-94901b`, `mx-c085ba`).
  Reference systemd unit + Fly Machine config + Caddy reverse-proxy snippet
  included. Unblocks R-02 substrate decision (Fly Machines = on-host) and gives
  warren / overstory / greenhouse a single canonical link for deploy guides.
- **`burrow watch` (TUI dashboard) — 0.2.0.** Multi-burrow live view; pure
  `DashboardSnapshot` builder + reducer + renderer with golden tests.
  Self-describes via SPEC §26's additive-only versioning lock. Seeds:
  burrow-304b → burrow-77bd / -95b0 / -db7a / -0a39 / -584b / -5c0b / -fd72 / -1a43.
- **`burrow serve` (HTTP API) — 0.3.0** (SPEC §27, seed `burrow-1d64`, plan
  `pl-5b40`). Routes mirror the `Client` namespaces 1:1; streaming surfaces
  emit NDJSON over chunked HTTP byte-for-byte equal to `--json` CLI output.
  Unix socket primary, localhost TCP opt-in, bearer auth from
  `BURROW_API_TOKEN`. `HttpClient` mirrors the namespace surface so consumers
  swap transports without touching call sites.
- **OpenAPI self-description — 0.3.x** (mulch pattern `mx-f5d9c8`). A running
  `burrow serve` exposes its full contract at `GET /openapi.json` (auth
  required) + Scalar-rendered `GET /openapi.html` (auth-exempt). Hand-authored
  source `src/server/openapi/spec.ts`; golden file locks the wire shape.
- **Run cancellation split (`burrow-6739`).** `POST /runs/:id/cancel`
  (graceful, idempotent on terminal runs, emits `run_cancelled` event) is
  separate from `DELETE /runs/:id` (record removal post-completion, cascades
  to `events.run_id`).
- **Userspace HTTP proxy for restricted networks** (mulch `mx-d6a44f`).
  Resolved SPEC §25 Q2 — chosen over IP-resolution-at-up-time and port-only
  options for portability across distros. nftables remains a future opt-in.
- **Generic toolchain bin-dir symlink walk + `[sandbox] read_only_paths`
  escape hatch** (burrow-a1b1, mulch `mx-25becd` / `mx-b673da`). Resolved
  SPEC §25 Q3 directionally — burrow follows symlinks in each declared
  toolchain's bin dir and contributes either `dirname(realpath)` or the
  declared `read_only_paths` to the sandbox mount set. Full
  `sandbox.toolchain_mode = "shim-aware"` opt-in is no longer needed in
  practice.
- **Linux-canonical devcontainer for local dev** (burrow-1c19). Lets macOS
  contributors opt into real bwrap isolation locally; same artifact shape as
  eventual deploy. Image satisfies the dual contract (mulch `mx-20f3b1`):
  every `[toolchain]` binary present, sandbox primitives functional.

## Suggested sequencing

A first cut at order of attack — not committed:

1. ~~**R-01** (deploy posture)~~ — shipped, see [DEPLOY.md](DEPLOY.md).
2. ~~**R-07** (workspace-seed HTTP API)~~ — shipped burrow-side (plan
   `pl-2467`); warren-side adoption tracked downstream in warren's tracker.
3. **R-04** (toolchain auto-install) — valuable for solo and team
   onboarding; orthogonal to everything else.
4. **R-06** (overstory/mycelium integration) — burrow's HTTP API
   (shipped in 0.3.0) already makes burrow a substrate worth migrating to;
   warren is proving the pattern. No longer waits on R-02.
5. **R-05** (ship target plugins) — incremental once `burrow ship`'s
   interface is exercised by a fourth, user-supplied target.
6. **R-03** (snapshot / restore) — defer until V1 is stable enough that
   "rewind a burrow" is a meaningful operation rather than rare polish.
7. **R-02** (FlyProvider + SshProvider) — *deferred*. Pick up when warren
   V2, greenhouse, or a laptop `burrow up --remote` workflow actually needs
   remote burrows.
