# Burrow examples

Runnable walkthroughs that show how to wire Burrow into a project. Each example
is self-contained — copy the `burrow.toml` (and any supporting files) into your
own project, then follow the README inside.

| Example | Shows |
|---|---|
| [`claude-code-quickstart/`](claude-code-quickstart) | `bw init` → `bw doctor` → `bw up` → `bw prompt` against `claude-code`. The 60-second tour. |
| [`custom-agent/`](custom-agent) | A declarative `[[agents]]` stanza wiring a non-built-in CLI agent without writing TypeScript. |

For the full schema reference, see [SPEC §17](../SPEC.md#17-burrowtoml-schema).
