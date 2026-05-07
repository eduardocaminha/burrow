/**
 * Public domain types (SPEC §15). The DB row types in src/db/schema.ts use
 * camelCase field names that already match these shapes — these aliases give
 * library callers a stable surface independent of the ORM and centralize
 * any view-only fields we add later (e.g. derived counts).
 */

import type {
	BurrowKind,
	BurrowRow,
	BurrowState,
	EventRow,
	EventStream,
	MessagePriority,
	MessageRow,
	MessageState,
	RunRow,
	RunState,
} from "../db/schema.ts";

export type { BurrowKind, BurrowState, EventStream, MessagePriority, MessageState, RunState };

export type Burrow = BurrowRow;
export type Run = RunRow;
export type Message = MessageRow;

export interface RunEvent {
	id: number;
	burrowId: string;
	runId: string | null;
	seq: number;
	kind: string;
	stream: EventStream;
	payload: unknown;
	ts: Date;
}

export function eventRowToEvent(row: EventRow): RunEvent {
	return {
		id: row.id,
		burrowId: row.burrowId,
		runId: row.runId,
		seq: row.seq,
		kind: row.kind,
		stream: row.stream,
		payload: row.payloadJson,
		ts: row.ts,
	};
}
