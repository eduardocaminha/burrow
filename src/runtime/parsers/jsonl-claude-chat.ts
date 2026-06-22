/**
 * Claude Code stream-json chat parser (spawn-per-turn / conversational variant).
 *
 * Behaves like jsonl-claude.ts with two key differences:
 *
 *   1. `result` envelopes → `agent_end` (turn BOUNDARY, not session terminal).
 *      The payload merges the full result envelope with the `session_id`
 *      captured from the turn's `system/init` so the runtime can pass
 *      `--resume <session_id>` on the next spawn without scanning the event log.
 *
 *   2. State is per-spawn: `createJsonlClaudeChatParser()` returns a fresh
 *      closure for each spawn so session_id never leaks across turns.
 *
 * Robustness contract:
 *   - Missing/absent `result` (GH #8126/#1920): the parser emits nothing for
 *     a line that never arrives; the runtime detects process exit and synthesises
 *     the turn-boundary `agent_end` as a fallback.
 *   - Non-flushed / line-buffered stdout (GH #25670): the dispatcher's
 *     `readLines` already yields the last unterminated chunk on stream close,
 *     so the parser never sees a truncated line silently dropped.
 *
 * The returned closure is a pure function over its accumulated state — no I/O,
 * no side effects, fully unit-testable.
 */

import type { RuntimeEvent } from "../runtime.ts";

interface ClaudeContentBlock {
	type?: string;
	text?: string;
	thinking?: string;
	[key: string]: unknown;
}

interface ClaudeMessage {
	role?: string;
	content?: ClaudeContentBlock[];
}

interface ClaudeEnvelope {
	type?: string;
	subtype?: string;
	message?: ClaudeMessage;
	session_id?: string;
	[key: string]: unknown;
}

/**
 * Create a stateful line parser for one claude-code spawn in chat mode.
 *
 * Call once per spawn; feed each stdout line to the returned function.
 * Session state (session_id) is encapsulated in the closure and never
 * shared between spawns.
 */
export function createJsonlClaudeChatParser(): (line: string) => RuntimeEvent[] {
	let capturedSessionId: string | undefined;

	return function parseJsonlClaudeChat(line: string): RuntimeEvent[] {
		const trimmed = line.trim();
		if (trimmed.length === 0) return [];

		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			return [
				{
					kind: "text",
					stream: "stdout",
					payload: { text: line, parseError: "invalid JSON" },
				},
			];
		}

		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			return [{ kind: "text", stream: "stdout", payload: { text: line } }];
		}

		const env = parsed as ClaudeEnvelope;

		if (env.type === "system") {
			// Capture session_id from system/init for the agent_end payload.
			if (typeof env.session_id === "string" && env.session_id.length > 0) {
				capturedSessionId = env.session_id;
			}
			return [{ kind: "state_change", stream: "system", payload: env }];
		}

		if (env.type === "result") {
			// Turn boundary: map to agent_end (NOT a terminal state_change).
			// Merge session_id: prefer the envelope's own field if present,
			// fall back to the one captured from system/init earlier in this spawn.
			const sessionId =
				typeof env.session_id === "string" && env.session_id.length > 0
					? env.session_id
					: capturedSessionId;
			return [
				{
					kind: "agent_end",
					stream: "system",
					payload: { ...env, session_id: sessionId },
				},
			];
		}

		if (env.type === "rate_limit_event") {
			return [{ kind: "telemetry", stream: "system", payload: env }];
		}

		if (env.type === "assistant" && env.message?.content) {
			const events: RuntimeEvent[] = [];
			for (const block of env.message.content) {
				const ev = mapAssistantBlock(block, env);
				if (ev !== null) events.push(ev);
			}
			return events;
		}

		if (env.type === "user" && env.message?.content) {
			return env.message.content
				.filter((block) => block.type === "tool_result")
				.map((block) => ({
					kind: "tool_result" as const,
					stream: "stdout" as const,
					payload: block,
				}));
		}

		return [{ kind: "text", stream: "stdout", payload: env }];
	};
}

function mapAssistantBlock(
	block: ClaudeContentBlock,
	envelope: ClaudeEnvelope,
): RuntimeEvent | null {
	if (block.type === "text") {
		return { kind: "text", stream: "stdout", payload: { text: block.text ?? "" } };
	}
	if (block.type === "thinking") {
		// Drop empty thinking blocks (matches jsonl-claude.ts behaviour — burrow-5d64).
		const text = block.thinking ?? "";
		if (text.length === 0) return null;
		return { kind: "thinking", stream: "stdout", payload: { text } };
	}
	if (block.type === "tool_use") {
		return { kind: "tool_use", stream: "stdout", payload: block };
	}
	return {
		kind: "text",
		stream: "stdout",
		payload: { block, envelopeType: envelope.type },
	};
}
