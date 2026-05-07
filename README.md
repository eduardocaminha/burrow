# Burrow

OS-isolated sandbox runtime for coding agents.

[![CI](https://github.com/jayminwest/burrow/actions/workflows/ci.yml/badge.svg)](https://github.com/jayminwest/burrow/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> **Status: Design phase.** V1 spec is in [SPEC.md](SPEC.md). Source has not been implemented yet — this README will be replaced when V1 ships.

Each agent digs its own contained space. Coding work happens in burrows, not on the host.

Burrow spins up many sandboxed workspaces in parallel, runs *any* CLI-based coding agent inside them, persists run state, streams events, and gives the user a CLI to steer running agents and observe what they're doing. The host stays clean: no language toolchains polluting `~`, no half-installed deps, no risky agent commands escaping to the user's filesystem.

V1 is local-first and single-user, with `bwrap` (Linux) and `sandbox-exec` (macOS) as the sandbox primitives — no Docker, no daemon. Remote providers are a post-V1 implementation, not a rewrite.

## Planned CLI

```bash
burrow up                                # spin up a project burrow
burrow prompt <id> <agent> "<task>"      # run an agent inside it
burrow fork <id> --task "<variation>"    # parallel exploration
burrow events --follow                   # observe live activity
burrow send <id> "<message>"             # steer a running agent
burrow stop <id> && burrow destroy <id>  # tear down + archive
```

CLI binaries: `burrow` and `bw`.

See [SPEC.md](SPEC.md) for the full V1 design — goals, non-goals, architecture, sandbox model, event schema, `burrow.toml` config, and the deferred V2 surface.

## Ecosystem

Burrow is part of the [os-eco](https://github.com/jayminwest/os-eco) ecosystem. It does not orchestrate agents — that's [Overstory](https://github.com/jayminwest/overstory) and [Mycelium](https://github.com/jayminwest/mycelium). It runs whatever agent the orchestrator hands it, in isolation.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). For security issues, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
