# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.x     | Yes       |

Only the latest release on the current major version line receives security updates.

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Please report vulnerabilities privately through [GitHub Security Advisories](https://github.com/jayminwest/burrow/security/advisories).

1. Go to the [Security Advisories page](https://github.com/jayminwest/burrow/security/advisories)
2. Click **"New draft security advisory"**
3. Fill in a description of the vulnerability, including steps to reproduce if possible

### Response Timeline

- **Acknowledgment**: Within 48 hours of your report
- **Initial assessment**: Within 7 days
- **Fix or mitigation**: Within 30 days for confirmed vulnerabilities

We will keep you informed of progress throughout the process.

## Scope

Burrow is a CLI tool that spins up OS-isolated sandboxes (via `bwrap` on Linux and `sandbox-exec` on macOS), runs coding agents inside them, persists run state to SQLite, and streams events. Burrow's threat model assumes a trusted user on a single machine; the security boundary is between the host and the agents running inside burrows. The following are considered security issues:

- **Sandbox escape** -- An agent inside a burrow accessing host filesystem paths, network endpoints, or environment variables outside the configured policy
- **Network policy bypass** -- A burrow making network calls that the configured policy should have blocked
- **Env passthrough leakage** -- Secrets or env vars leaking into a burrow that were not explicitly allowlisted
- **Command injection** -- Unsanitized input passed to `Bun.spawn`, `bwrap`, `sandbox-exec`, or shell execution
- **Path traversal** -- A burrow accessing files outside its workspace or session directory
- **Symlink attacks** -- Following symlinks across the sandbox boundary
- **Temp file races** -- TOCTOU vulnerabilities in temporary file handling
- **SQL injection** -- Crafted event payloads that manipulate the SQLite session store
- **Inbox forgery** -- A burrow tampering with another burrow's inbox or events stream

The following are generally **not** in scope:

- Denial of service via large input (Burrow is a local tool, not a service)
- Issues that require the attacker to already have local shell access with the same privileges as the user
- Costs incurred from spawning many burrows (operational concern, not a security vulnerability)
- Weaknesses in third-party agent runtimes invoked from inside a burrow (report those upstream)
- Social engineering or phishing

## Security Measures

Burrow already implements several hardening measures:

- OS-level sandboxing (bwrap / sandbox-exec) for every burrow, with no Docker or container daemon required
- Explicit env passthrough -- nothing leaks unless allowlisted in `burrow.toml`
- Declarative network policy per burrow (default deny)
- Per-burrow filesystem isolation: workspace, events, inbox, and logs scoped to a session directory
- Atomic event writes and persistent SQLite state to prevent partial-write corruption

If you believe any of these measures can be bypassed, please report it through the process above.
