/**
 * Repository for the `messages` table — the per-burrow steering inbox.
 *
 * Phase 2 establishes the storage contract; the inbox-injection logic that
 * consumes pending messages and hands them to a runtime lands in Phase 5.
 * `resetDeliveredOrphans` is the crash-recovery counterpart to
 * `RunsRepo.failAllRunning`: any message marked `delivered` against a run
 * that never reached a terminal state is reset to `unread`.
 */

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { NotFoundError } from "../../core/errors.ts";
import { generateId } from "../../core/ids.ts";
import type { DrizzleDb } from "../client.ts";
import {
	type MessagePriority,
	type MessageRow,
	type MessageState,
	messages,
	runs,
} from "../schema.ts";

export interface SendMessageInput {
	id?: string;
	burrowId: string;
	fromActor: string;
	body: string;
	priority?: MessagePriority;
	now?: Date;
}

const PRIORITY_RANK: Record<MessagePriority, number> = {
	urgent: 3,
	high: 2,
	normal: 1,
	low: 0,
};

export class MessagesRepo {
	constructor(private readonly db: DrizzleDb) {}

	send(input: SendMessageInput): MessageRow {
		const now = input.now ?? new Date();
		const row: MessageRow = {
			id: input.id ?? generateId("message"),
			burrowId: input.burrowId,
			fromActor: input.fromActor,
			body: input.body,
			priority: input.priority ?? "normal",
			state: "unread",
			deliveredAtRunId: null,
			createdAt: now,
			deliveredAt: null,
		};
		this.db.insert(messages).values(row).run();
		return row;
	}

	get(id: string): MessageRow | null {
		return this.db.select().from(messages).where(eq(messages.id, id)).get() ?? null;
	}

	require(id: string): MessageRow {
		const row = this.get(id);
		if (!row) throw new NotFoundError(`message not found: ${id}`);
		return row;
	}

	/**
	 * Pending steering messages for a burrow, priority-first then FIFO. Stored
	 * priorities are strings; we sort in JS to honour the urgent/high/normal/low
	 * order without depending on DB-level lexical ordering.
	 */
	listPending(burrowId: string): MessageRow[] {
		const rows = this.db
			.select()
			.from(messages)
			.where(and(eq(messages.burrowId, burrowId), eq(messages.state, "unread")))
			.orderBy(asc(messages.createdAt))
			.all();
		return rows.sort((a, b) => {
			const dp = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
			if (dp !== 0) return dp;
			return a.createdAt.getTime() - b.createdAt.getTime();
		});
	}

	listByBurrow(burrowId: string, state?: MessageState): MessageRow[] {
		const where = state
			? and(eq(messages.burrowId, burrowId), eq(messages.state, state))
			: eq(messages.burrowId, burrowId);
		return this.db.select().from(messages).where(where).orderBy(desc(messages.createdAt)).all();
	}

	markDelivered(id: string, runId: string, now: Date = new Date()): MessageRow {
		const current = this.require(id);
		const patch: Partial<MessageRow> = {
			state: "delivered",
			deliveredAtRunId: runId,
			deliveredAt: now,
		};
		this.db.update(messages).set(patch).where(eq(messages.id, id)).run();
		return { ...current, ...patch };
	}

	/**
	 * Atomically claim every pending message for a burrow against a single run.
	 * Used by the run loop right before it spawns a turn — the runtime sees the
	 * returned rows as `SpawnContext.pendingMessages` (SPEC §13.2). Claiming
	 * inside a transaction keeps two concurrent turns on the same burrow from
	 * delivering the same message twice; the recovery sweep resets any rows
	 * stuck on a non-terminal run if the spawn dies before the turn completes.
	 */
	claimPendingForRun(burrowId: string, runId: string, now: Date = new Date()): MessageRow[] {
		return this.db.transaction((tx) => {
			const rows = tx
				.select()
				.from(messages)
				.where(and(eq(messages.burrowId, burrowId), eq(messages.state, "unread")))
				.orderBy(asc(messages.createdAt))
				.all();
			if (rows.length === 0) return [];
			const sorted = rows.sort((a, b) => {
				const dp = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
				if (dp !== 0) return dp;
				return a.createdAt.getTime() - b.createdAt.getTime();
			});
			const ids = sorted.map((r) => r.id);
			tx.update(messages)
				.set({ state: "delivered", deliveredAtRunId: runId, deliveredAt: now })
				.where(inArray(messages.id, ids))
				.run();
			return sorted.map((r) => ({
				...r,
				state: "delivered" as const,
				deliveredAtRunId: runId,
				deliveredAt: now,
			}));
		});
	}

	markFailed(id: string, now: Date = new Date()): MessageRow {
		const current = this.require(id);
		const patch: Partial<MessageRow> = { state: "failed", deliveredAt: now };
		this.db.update(messages).set(patch).where(eq(messages.id, id)).run();
		return { ...current, ...patch };
	}

	cancel(id: string): void {
		this.require(id);
		this.db.delete(messages).where(eq(messages.id, id)).run();
	}

	/**
	 * Crash-recovery sweep (SPEC §10.2). Any `delivered` message whose target
	 * run is missing or non-terminal (queued/running) is reset to `unread`.
	 * Returns the IDs that were reset.
	 */
	resetDeliveredOrphans(): string[] {
		const candidates = this.db
			.select({ id: messages.id, runId: messages.deliveredAtRunId })
			.from(messages)
			.where(eq(messages.state, "delivered"))
			.all();
		if (candidates.length === 0) return [];

		const orphanIds: string[] = [];
		for (const m of candidates) {
			if (!m.runId) {
				orphanIds.push(m.id);
				continue;
			}
			const run = this.db
				.select({ state: runs.state })
				.from(runs)
				.where(eq(runs.id, m.runId))
				.get();
			if (!run) {
				orphanIds.push(m.id);
				continue;
			}
			if (run.state === "queued" || run.state === "running") {
				orphanIds.push(m.id);
			}
		}

		if (orphanIds.length === 0) return [];
		this.db
			.update(messages)
			.set({ state: "unread", deliveredAtRunId: null, deliveredAt: null })
			.where(inArray(messages.id, orphanIds))
			.run();
		return orphanIds;
	}

	count(burrowId: string, state?: MessageState): number {
		const where = state
			? and(eq(messages.burrowId, burrowId), eq(messages.state, state))
			: eq(messages.burrowId, burrowId);
		const row = this.db.select({ n: sql<number>`count(*)` }).from(messages).where(where).get();
		return row?.n ?? 0;
	}
}
