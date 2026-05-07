# Custom agent: declarative `[[agents]]`

Adding a non-built-in CLI agent is config-only — no TypeScript, no fork. The
schema lives in [SPEC §12.3](../../SPEC.md#123-declarative-adapters-agentconfig).

This example wires up a fake `aider` agent that:

- gets the prompt as a positional argument (`promptDelivery = "arg"`),
- emits raw text on stdout (`outputFormat = "raw-text"`),
- exposes an `installCheck` so `burrow doctor` can flag a missing binary,
- declares its required env so `burrow up` gates on it being present.

Drop `burrow.toml` into your project root and:

```bash
burrow agents validate ./agent.json   # optional — same schema, separate file
burrow doctor                         # confirms `aider` is installed
burrow up
burrow prompt <id> --agent aider "explain the auth flow"
```

`bw prompt` resolves `--agent aider` against the merged registry (built-ins
first, then `~/.config/burrow/agents.toml`, then the project's
`[[agents]]`). Same `id` later wins; new `id` extends.
