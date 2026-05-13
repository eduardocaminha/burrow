/**
 * Built-in `pi` runtime — spawn-per-turn, JSON-RPC over stdin (pi v0.74.0).
 *
 * Pi's `--mode rpc` reads one JSON command per `\n`-delimited line on stdin
 * and emits one JSON event per line on stdout. Each burrow run writes a
 * single `{"type":"prompt","message":"<prompt + steering prefix>"}` line and
 * then waits for the agent to drain. The parser in
 * `src/runtime/parsers/pi.ts` collapses pi's wider event vocabulary into
 * burrow's stable taxonomy (SPEC §14.1) — the runtime here owns argv,
 * stdin payload, env passthrough, and installCheck.
 *
 * Forced argv flags (locked by unit tests):
 *
 *   - `--mode rpc`            — JSONL command/event protocol.
 *   - `--no-session`          — disable session persistence; V1 is
 *                               one-shot per run (matches codex / sapling
 *                               V1 posture). Pair with `supportsResume:false`.
 *   - `--no-extensions`       — pi's `extension_ui_request` is an
 *                               interactive prompt RPC the dispatcher has
 *                               no path to answer; force-disable to avoid
 *                               hangs on auto-discovered extensions
 *                               (workspace `.pi/extensions/`, user
 *                               `~/.pi/extensions/`).
 *   - `--provider anthropic`  — pi's CLI default provider is Gemini;
 *                               omitting this would silently bill
 *                               GEMINI_API_KEY against a runtime declared
 *                               for Claude. Hardcoded so the
 *                               `ANTHROPIC_API_KEY` envPassthrough below
 *                               actually authenticates.
 *
 * Auth precedence (mx-5fee0d): on a host with `~/.pi/agent/auth.json`
 * populated (developer ran `pi /login`), pi prefers the stored OAuth token
 * over `ANTHROPIC_API_KEY`. Inside the sandbox `~/.pi` is not bind-mounted,
 * so the env-var route always wins there. In host-mode dev it's a footgun
 * — surfaced via the install-check hint rather than mutated, since burrow
 * should never silently rewrite a developer's auth state.
 *
 * Critical dispatcher invariant (mx-d9b3ad, from the captured fixtures):
 * pi exits the instant stdin closes, even mid-inference. The current
 * dispatcher's "write prompt, close stdin" semantics will end pi before
 * any assistant content is produced. The runtime here exposes the correct
 * RPC line shape; wiring stdin-hold (close stdin only after
 * `agent_end` arrives on stdout) is a dispatcher-layer concern tracked
 * separately so e2e runs against real pi produce assistant content.
 */

import type { Message } from "../core/types.ts";
import type { SpawnCommand } from "../provider/types.ts";
import { parsePiEvents } from "./parsers/pi.ts";
import type {
	AgentRuntime,
	InstallCheckResult,
	ParseContext,
	RuntimeEvent,
	SpawnContext,
} from "./runtime.ts";
import { runVersionCheck } from "./version.ts";

const PI_BIN = "pi";

/**
 * Model pin for V1. Matches the model used to capture the golden RPC
 * fixtures under `src/runtime/parsers/__golden__/`, so the runtime's wire
 * shape stays in lockstep with what the parser was validated against.
 * Bump only when the fixtures are regenerated against a new model.
 */
export const PI_DEFAULT_MODEL = "claude-haiku-4-5";

/**
 * Locked prefix of `pi`'s argv. The trailing `--model <PI_DEFAULT_MODEL>`
 * pair is appended in `buildSpawnCommand` — split out so the test that
 * enforces flag presence can assert the prefix without coupling to the
 * exact pinned model.
 */
export const PI_FORCED_ARGV: readonly string[] = [
	PI_BIN,
	"--mode",
	"rpc",
	"--no-session",
	"--no-extensions",
	"--provider",
	"anthropic",
] as const;

/**
 * Host env vars the `pi` CLI consults at startup. Forwarded into the
 * sandbox via `SandboxProfile.envPassthrough` so a project with no
 * `burrow.toml [env]` block still authenticates when `ANTHROPIC_API_KEY`
 * (or its siblings) is set in the burrow process env. Aligned with
 * `claude-code` minus the `CLAUDE_CODE_OAUTH_TOKEN` flavor since pi's
 * OAuth path is keyed off `~/.pi/agent/auth.json` (not bind-mounted into
 * the sandbox), not an env var.
 *
 * Non-anthropic provider keys (`GEMINI_API_KEY`, `OPENAI_API_KEY`, ...)
 * are intentionally NOT in this list — argv pins `--provider anthropic`,
 * so forwarding them would leak host secrets into a sandbox that can't
 * use them. Projects that override the provider via `burrow.toml [env]`
 * passthrough opt in per-project (mx-d46d5d).
 */
export const PI_ENV_PASSTHROUGH: readonly string[] = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
] as const;

export const piRuntime: AgentRuntime = {
	id: "pi",
	displayName: "Pi",
	supportsResume: false,
	envPassthrough: PI_ENV_PASSTHROUGH,

	buildSpawnCommand(ctx: SpawnContext): SpawnCommand {
		return {
			argv: [...PI_FORCED_ARGV, "--model", PI_DEFAULT_MODEL],
			stdin: encodePiStdin(ctx.prompt, ctx.pendingMessages),
		};
	},

	parseEvents(line: string, _ctx: ParseContext): RuntimeEvent[] {
		return parsePiEvents(line);
	},

	encodeInboxMessage(messages: Message[]): { stdin: string } {
		return { stdin: messages.map(piPromptCommandFromMessage).join("\n") };
	},

	async installCheck(): Promise<InstallCheckResult> {
		return runVersionCheck(PI_BIN, ["--version"], {
			hint: "install pi: `bun install -g @earendil-works/pi-coding-agent` (run `pi /login` for subscription auth or set ANTHROPIC_API_KEY)",
		});
	},
};

/**
 * Encode the run's prompt followed by any pending steering messages as a
 * single stdin blob — one `{"type":"prompt", ...}` JSON envelope per line.
 * Each pending steering message becomes its own prompt command, prefixed
 * with the standard `[STEERING] (priority: P) ` tag for parity with
 * claude-code (mx-63b005). Exported for unit tests.
 *
 * When the run carries no prompt (e.g. inbox-only nudge) the first line
 * is dropped, mirroring `encodeClaudeStdin`'s contract.
 */
export function encodePiStdin(prompt: string, messages: Message[]): string {
	const lines: string[] = [];
	if (prompt.length > 0) lines.push(piPromptCommand(prompt));
	for (const m of messages) lines.push(piPromptCommandFromMessage(m));
	return lines.join("\n");
}

function piPromptCommand(text: string): string {
	return JSON.stringify({ type: "prompt", message: text });
}

function piPromptCommandFromMessage(message: Message): string {
	const tag = `[STEERING] (priority: ${message.priority}) `;
	return piPromptCommand(`${tag}${message.body}`);
}
