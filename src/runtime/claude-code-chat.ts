/**
 * Built-in `claude-code-chat` runtime — conversational spawn-per-turn variant.
 *
 * Every turn spawns `claude -p <prompt> --output-format stream-json --verbose
 * --dangerously-skip-permissions`; subsequent turns append `--resume
 * <session_id>` so the Claude Code CLI reuses the same conversation thread
 * without replaying the full message history. The session_id is extracted
 * from the `agent_end` event emitted by the chat parser and stored in
 * `Run.metadataJson.session_id` via `extractMetadata`, where the next
 * `buildResumeCommand` reads it off `priorRun.metadataJson`.
 *
 * Design choices vs the batch `claude-code` runtime:
 *   - Prompt is a CLI arg (`-p`), not a stdin blob — no `--input-format
 *     stream-json`. This avoids stdin-held-open bugs (GH #3187, #25629,
 *     #5034, #41230) and is the documented multi-turn pattern.
 *   - Non-bare: `--bare` skips OAuth/keychain loading, breaking subscription
 *     auth. We omit it so the sandboxed HOME lookup finds the forwarded
 *     `.credentials.json` (same as the batch runtime).
 *   - Parser is stateful per spawn: `createJsonlClaudeChatParser()` is
 *     called once per run and cached in `perRunParsers`; the parser
 *     accumulates the turn's `session_id` from `system/init` so the
 *     `result → agent_end` payload carries it without a second scan.
 *   - `encodeInboxMessage` is defined (returns `{stdin:""}`) so the inbox
 *     injector recognises this as a spawn-per-turn runtime (SPEC §12.1).
 *     Pending messages are actually delivered by folding them into the `-p`
 *     prompt text via `buildChatPrompt` rather than via stdin.
 *
 * `prepareWorkspace` and `credentialPaths` are delegated to
 * `claudeCodeRuntime` so workspace setup (settings.json, .burrow-tmp,
 * credential forward) stays in one place.
 */

import type { Message } from "../core/types.ts";
import type { SpawnCommand } from "../provider/types.ts";
import {
	CLAUDE_CODE_ENV_PASSTHROUGH,
	claudeCodeBurrowTmpdir,
	claudeCodeHostCredentialPaths,
	claudeCodeRuntime,
} from "./claude-code.ts";
import { createJsonlClaudeChatParser } from "./parsers/jsonl-claude-chat.ts";
import type {
	AgentRuntime,
	ExtractMetadataContext,
	InstallCheckResult,
	ParseContext,
	PrepareContext,
	ResumeContext,
	RuntimeEvent,
	SpawnContext,
} from "./runtime.ts";
import { runVersionCheck } from "./version.ts";

const CLAUDE_BIN = "claude";

/**
 * Per-run parser instances. Keyed by `run.id`; created lazily on the first
 * `parseEvents` call for a run and cleaned up in `extractMetadata` after the
 * run completes. Failed runs leave entries in the map until the process
 * restarts — bounded in practice by the number of runs per process lifetime.
 */
const perRunParsers = new Map<string, (line: string) => RuntimeEvent[]>();

/**
 * Session IDs captured from `agent_end` payloads during `parseEvents`.
 * Cleaned up alongside `perRunParsers` in `extractMetadata`.
 */
const perRunSessionIds = new Map<string, string>();

function getOrCreateParser(runId: string): (line: string) => RuntimeEvent[] {
	let parser = perRunParsers.get(runId);
	if (!parser) {
		parser = createJsonlClaudeChatParser();
		perRunParsers.set(runId, parser);
	}
	return parser;
}

/**
 * Build the `-p` prompt text for a single chat turn. Pending steering
 * messages are appended after the user prompt with a `[STEERING]` prefix
 * matching the batch runtime's tag format.
 */
export function buildChatPrompt(prompt: string, messages: Message[]): string {
	const parts: string[] = [];
	if (prompt.length > 0) parts.push(prompt);
	for (const m of messages) {
		parts.push(`[STEERING] (priority: ${m.priority}) ${m.body}`);
	}
	return parts.join("\n");
}

export const claudeCodeChatRuntime: AgentRuntime = {
	id: "claude-code-chat",
	displayName: "Claude Code (chat)",
	supportsResume: true,
	envPassthrough: CLAUDE_CODE_ENV_PASSTHROUGH,

	buildSpawnCommand(ctx: SpawnContext): SpawnCommand {
		const promptText = buildChatPrompt(ctx.prompt, ctx.pendingMessages);
		return {
			argv: [
				CLAUDE_BIN,
				"-p",
				promptText,
				"--output-format",
				"stream-json",
				"--verbose",
				"--dangerously-skip-permissions",
			],
			env: { TMPDIR: claudeCodeBurrowTmpdir(ctx.workspacePath) },
		};
	},

	buildResumeCommand(ctx: ResumeContext): SpawnCommand {
		const promptText = buildChatPrompt(ctx.prompt, ctx.pendingMessages);
		const sessionId = readSessionId(ctx.priorRun.metadataJson);
		const argv = [
			CLAUDE_BIN,
			"-p",
			promptText,
			"--output-format",
			"stream-json",
			"--verbose",
			"--dangerously-skip-permissions",
		];
		if (sessionId) argv.push("--resume", sessionId);
		return {
			argv,
			env: { TMPDIR: claudeCodeBurrowTmpdir(ctx.workspacePath) },
		};
	},

	parseEvents(line: string, ctx: ParseContext): RuntimeEvent[] {
		const parser = getOrCreateParser(ctx.run.id);
		const events = parser(line);
		for (const event of events) {
			if (event.kind === "agent_end") {
				const sid = (event.payload as Record<string, unknown>)?.session_id;
				if (typeof sid === "string" && sid.length > 0) {
					perRunSessionIds.set(ctx.run.id, sid);
				}
			}
		}
		return events;
	},

	// Defined so the inbox injector recognises this as a spawn-per-turn
	// runtime (SPEC §12.1). Pending messages are actually folded into the
	// `-p` prompt text in buildSpawnCommand / buildResumeCommand.
	encodeInboxMessage(_messages: Message[]): { stdin: string } {
		return { stdin: "" };
	},

	async prepareWorkspace(ctx: PrepareContext): Promise<void> {
		await claudeCodeRuntime.prepareWorkspace?.(ctx);
	},

	/**
	 * Return the session_id captured during `parseEvents` and clean up the
	 * per-run parser state. Called only on successful runs (exitCode === 0);
	 * returns `undefined` when no `agent_end` with a session_id was emitted
	 * (e.g. the turn exited 0 but claude produced no result line), in which
	 * case the next resume falls back to a fresh spawn.
	 */
	async extractMetadata(
		ctx: ExtractMetadataContext,
	): Promise<Record<string, unknown> | undefined> {
		const sessionId = perRunSessionIds.get(ctx.run.id);
		perRunParsers.delete(ctx.run.id);
		perRunSessionIds.delete(ctx.run.id);
		return sessionId ? { session_id: sessionId } : undefined;
	},

	async credentialPaths(): Promise<string[]> {
		return claudeCodeHostCredentialPaths();
	},

	async installCheck(): Promise<InstallCheckResult> {
		return runVersionCheck(CLAUDE_BIN, ["--version"], {
			hint: "install Claude Code via `bun install -g @anthropic-ai/claude-code` or follow https://docs.claude.com/claude-code",
		});
	},
};

function readSessionId(metadata: unknown): string | undefined {
	if (metadata === null || typeof metadata !== "object") return undefined;
	const v = (metadata as Record<string, unknown>).session_id;
	return typeof v === "string" && v.length > 0 ? v : undefined;
}
