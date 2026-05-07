# Quickstart: claude-code in a burrow

The 60-second tour. Copy `burrow.toml` into a project root, then walk the steps
below.

## Steps

```bash
# 1. install Burrow + the agent CLI it'll dispatch
bun install -g @os-eco/burrow-cli
bun install -g @anthropic-ai/claude-code   # ships the `claude` binary

# 2. scaffold a burrow.toml in the current project
cd ~/projects/web-app
burrow init claude                         # `claude` is the alias for claude-code

# 3. confirm the host is ready
burrow doctor
#  ✓ sandbox primitive present
#  ✓ toolchains satisfied
#  ✓ agents installed

# 4. spin up a project burrow
burrow up
#  ✓ burrow bur_a3f9 up (workspace: ~/.local/share/burrow/sessions/bur_a3f9/workspace)

# 5. ask claude-code to do something
burrow prompt bur_a3f9 "Add input validation to the POST /login endpoint"
# (events stream as the agent works)

# 6. fork off and try a different approach in parallel
burrow fork bur_a3f9 --task "redis-backed session store"
burrow prompt bur_b21c "Replace the in-memory session store with redis"

# 7. observe both burrows live
burrow events --follow

# 8. steer the redis attempt mid-flight
burrow send bur_b21c "stop and write tests first"

# 9. tear down when done — events are archived to NDJSON
burrow stop bur_b21c
burrow destroy bur_b21c
```

## What `burrow init claude` produced

The scaffolded `burrow.toml` (see this directory) declares:

- `[sandbox]` — `restricted` network, allow-listing the few domains agents need
  for package installs and the Anthropic API.
- `[toolchain]` — versions `burrow doctor` will gate `burrow up` on.
- `[[agents]] id = "claude-code"` — pins the built-in claude-code runtime as
  the default agent. `bw prompt` falls back to this when `--agent` is omitted.

Edit it freely; it's the project contract.
