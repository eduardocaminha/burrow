/**
 * `burrow chat` — interactive steering REPL (SPEC §13.4).
 *
 * Phase 5 ships the send-side of chat: each non-empty stdin line becomes a
 * steering message, with a per-line confirmation echoed to stdout. The event
 * tail (the `burrow logs --follow` half of the SPEC description) lands in
 * Phase 6 once the in-memory pub/sub is wired; until then, chat composes
 * cleanly with `burrow logs <id> --follow &` in a sibling terminal.
 *
 * The implementation reads from a generic `AsyncIterable<string>` (one entry
 * per line) so tests can drive it without spawning a TTY. Empty/blank lines
 * are skipped — they're a normal artifact of someone hitting Enter without
 * typing — but we don't EOF on them; chat stops when the iterator does.
 */

import type { Message } from "../../core/types.ts";
import type { BurrowDb } from "../../db/client.ts";
import { createRepos } from "../../db/repos/index.ts";
import type { MessagePriority } from "../../db/schema.ts";
import { Inbox } from "../../inbox/inbox.ts";
import { isSpawnPerTurn } from "../../inbox/injector.ts";
import { AgentRegistry } from "../../runtime/registry.ts";

export interface ChatCommandOptions {
	priority?: MessagePriority;
	from?: string;
	json?: boolean;
}

export interface ChatCommandInput {
	db: BurrowDb;
	registry?: AgentRegistry;
	burrowId: string;
	options: ChatCommandOptions;
	stdin: AsyncIterable<string>;
	stdout: NodeJS.WritableStream;
	now?: () => Date;
}

export interface ChatCommandSummary {
	burrowId: string;
	queued: number;
	deferred: boolean;
	lastAgentId: string | null;
}

export async function runChatCommand(input: ChatCommandInput): Promise<ChatCommandSummary> {
	const repos = createRepos(input.db);
	const inbox = new Inbox(repos);
	const registry = input.registry ?? new AgentRegistry();
	const lastRun = repos.runs.listByBurrow(input.burrowId, 1)[0] ?? null;
	const lastAgentId = lastRun?.agentId ?? null;
	const deferred = lastAgentId ? !isSpawnPerTurn(registry.require(lastAgentId)) : false;

	if (!input.options.json) {
		input.stdout.write(renderChatBanner(input.burrowId, lastAgentId, deferred));
	}

	let queued = 0;
	for await (const raw of input.stdin) {
		const body = raw.replace(/\r?\n$/, "").trim();
		if (body.length === 0) continue;
		const message = inbox.send({
			burrowId: input.burrowId,
			body,
			priority: input.options.priority ?? "normal",
			fromActor: input.options.from ?? "user",
			now: input.now?.(),
		});
		queued += 1;
		input.stdout.write(formatChatLine(message, input.options.json ?? false));
	}

	return { burrowId: input.burrowId, queued, deferred, lastAgentId };
}

export function renderChatBanner(
	burrowId: string,
	lastAgentId: string | null,
	deferred: boolean,
): string {
	const head = `chat: ${burrowId}`;
	const sub = lastAgentId
		? `last run agent: ${lastAgentId}`
		: "no runs yet — messages queue for the next run";
	const warn =
		deferred && lastAgentId
			? `\n  ! ${lastAgentId} is one-shot — messages will queue for the next run, not the next turn`
			: "";
	return `${head}\n  ${sub}${warn}\n  type messages, one per line. ctrl-d to exit.\n`;
}

export function formatChatLine(message: Message, json: boolean): string {
	if (json)
		return `${JSON.stringify({ id: message.id, priority: message.priority, body: message.body })}\n`;
	return `  ✓ ${message.id} (${message.priority})\n`;
}

/**
 * Adapter that turns a Node ReadableStream (e.g. process.stdin) into an
 * async-iterable of newline-delimited strings. We split eagerly so each
 * Enter-press dispatches a message instead of waiting for stdin to close.
 */
export async function* lineIterator(
	stream: NodeJS.ReadableStream,
	encoding: BufferEncoding = "utf8",
): AsyncGenerator<string, void, void> {
	let buffer = "";
	const decoder = new TextDecoder(encoding);
	for await (const chunk of stream) {
		buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
		let nl = buffer.indexOf("\n");
		while (nl !== -1) {
			yield buffer.slice(0, nl);
			buffer = buffer.slice(nl + 1);
			nl = buffer.indexOf("\n");
		}
	}
	if (buffer.length > 0) yield buffer;
}
