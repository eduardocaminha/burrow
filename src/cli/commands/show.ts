/**
 * `burrow show <id>` — point-in-time snapshot for one burrow (SPEC §16).
 *
 * Returns the burrow row plus its recent runs and recent events. Pretty mode
 * formats a compact human summary; --json emits the full structured object.
 */

import type { Burrow, Message, Run, RunEvent } from "../../core/types.ts";
import { eventRowToEvent } from "../../core/types.ts";
import type { Client } from "../../lib/client.ts";

export interface ShowCommandOptions {
	json?: boolean;
	runsLimit?: number;
	eventsLimit?: number;
}

export interface ShowCommandInput {
	client: Client;
	burrowId: string;
	options: ShowCommandOptions;
}

export interface ShowCommandResult {
	burrow: Burrow;
	runs: Run[];
	events: RunEvent[];
	pendingMessages: Message[];
	counts: {
		events: number;
		pending: number;
	};
}

const DEFAULT_RUNS = 10;
const DEFAULT_EVENTS = 20;

export function runShowCommand(input: ShowCommandInput): ShowCommandResult {
	const burrow = input.client.burrows.get(input.burrowId);
	const runs = input.client.runs.list({
		burrowId: burrow.id,
		limit: input.options.runsLimit ?? DEFAULT_RUNS,
	});
	const eventRows = input.client.repos.events.listByBurrow(burrow.id, {
		limit: input.options.eventsLimit ?? DEFAULT_EVENTS,
	});
	const events = eventRows.map(eventRowToEvent);
	const pendingMessages = input.client.inbox.pending(burrow.id);

	return {
		burrow,
		runs,
		events,
		pendingMessages,
		counts: {
			events: input.client.repos.events.countByBurrow(burrow.id),
			pending: pendingMessages.length,
		},
	};
}

export function renderShowReport(result: ShowCommandResult): string {
	const b = result.burrow;
	const lines: string[] = [];
	lines.push(`Burrow ${b.id}`);
	lines.push(`  state:    ${b.state}`);
	lines.push(`  kind:     ${b.kind}`);
	if (b.name) lines.push(`  name:     ${b.name}`);
	lines.push(`  branch:   ${b.branch}`);
	lines.push(`  project:  ${b.projectRoot}`);
	lines.push(`  workspace: ${b.workspacePath}`);
	lines.push(`  provider: ${b.provider}`);
	lines.push(`  created:  ${b.createdAt.toISOString()}`);
	lines.push(`  updated:  ${b.updatedAt.toISOString()}`);
	if (b.destroyedAt) lines.push(`  destroyed: ${b.destroyedAt.toISOString()}`);

	lines.push("");
	lines.push(`Runs (${result.runs.length}):`);
	if (result.runs.length === 0) {
		lines.push("  (none yet)");
	} else {
		for (const r of result.runs) {
			const ended = r.completedAt ? ` ended=${r.completedAt.toISOString()}` : "";
			const exit = r.exitCode !== null ? ` exit=${r.exitCode}` : "";
			lines.push(`  ${r.id}  ${r.state}  agent=${r.agentId}${ended}${exit}`);
		}
	}

	lines.push("");
	lines.push(`Recent events (${result.events.length}/${result.counts.events}):`);
	if (result.events.length === 0) {
		lines.push("  (none yet)");
	} else {
		for (const e of result.events) {
			lines.push(`  #${e.seq}  ${e.kind}  stream=${e.stream}  ts=${e.ts.toISOString()}`);
		}
	}

	if (result.counts.pending > 0) {
		lines.push("");
		lines.push(`Pending steering messages: ${result.counts.pending}`);
		for (const m of result.pendingMessages) {
			lines.push(`  ${m.id}  priority=${m.priority}  from=${m.fromActor}`);
		}
	}

	return lines.join("\n");
}

export function showResultToJson(result: ShowCommandResult): string {
	return JSON.stringify(
		{
			burrow: result.burrow,
			runs: result.runs,
			events: result.events.map((e) => ({
				id: e.id,
				seq: e.seq,
				kind: e.kind,
				stream: e.stream,
				runId: e.runId,
				ts: e.ts.toISOString(),
				payload: e.payload,
			})),
			pendingMessages: result.pendingMessages,
			counts: result.counts,
		},
		null,
		2,
	);
}
