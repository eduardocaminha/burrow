/**
 * SQLite schema for burrow's durable state (SPEC §10).
 *
 * Five tables, no jobs table. Run loop sweeps `runs.state = 'running'` on
 * startup and resets in-flight messages — that's the entire crash-recovery
 * story. Indices are tuned for: list-active-burrows, ready-runs lookup,
 * recovery sweep, event tail/replay, and priority-ordered message delivery.
 */

import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const BURROW_KINDS = ["project", "task"] as const;
export type BurrowKind = (typeof BURROW_KINDS)[number];

export const BURROW_STATES = ["active", "stopped", "destroyed"] as const;
export type BurrowState = (typeof BURROW_STATES)[number];

export const RUN_STATES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type RunState = (typeof RUN_STATES)[number];

export const MESSAGE_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type MessagePriority = (typeof MESSAGE_PRIORITIES)[number];

export const MESSAGE_STATES = ["unread", "delivered", "failed"] as const;
export type MessageState = (typeof MESSAGE_STATES)[number];

export const EVENT_STREAMS = ["stdout", "stderr", "system"] as const;
export type EventStream = (typeof EVENT_STREAMS)[number];

export const burrows = sqliteTable(
	"burrows",
	{
		id: text("id").primaryKey(),
		parentId: text("parent_id"),
		kind: text("kind", { enum: BURROW_KINDS }).notNull(),
		name: text("name"),
		projectRoot: text("project_root").notNull(),
		workspacePath: text("workspace_path").notNull(),
		branch: text("branch").notNull(),
		provider: text("provider").notNull(),
		providerStateJson: text("provider_state_json", { mode: "json" }),
		profileJson: text("profile_json", { mode: "json" }).notNull(),
		state: text("state", { enum: BURROW_STATES }).notNull(),
		createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
		destroyedAt: integer("destroyed_at", { mode: "timestamp" }),
	},
	(t) => [index("burrows_state_kind_idx").on(t.state, t.kind)],
);

export const runs = sqliteTable(
	"runs",
	{
		id: text("id").primaryKey(),
		burrowId: text("burrow_id")
			.notNull()
			.references(() => burrows.id),
		agentId: text("agent_id").notNull(),
		prompt: text("prompt").notNull(),
		resumeOfRunId: text("resume_of_run_id"),
		state: text("state", { enum: RUN_STATES }).notNull(),
		exitCode: integer("exit_code"),
		errorMessage: text("error_message"),
		metadataJson: text("metadata_json", { mode: "json" }),
		queuedAt: integer("queued_at", { mode: "timestamp" }).notNull(),
		startedAt: integer("started_at", { mode: "timestamp" }),
		completedAt: integer("completed_at", { mode: "timestamp" }),
	},
	(t) => [
		index("runs_burrow_queued_idx").on(t.burrowId, sql`${t.queuedAt} DESC`),
		index("runs_state_idx").on(t.state),
	],
);

export const events = sqliteTable(
	"events",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		burrowId: text("burrow_id")
			.notNull()
			.references(() => burrows.id),
		runId: text("run_id").references(() => runs.id),
		seq: integer("seq").notNull(),
		kind: text("kind").notNull(),
		stream: text("stream", { enum: EVENT_STREAMS }).notNull(),
		payloadJson: text("payload_json", { mode: "json" }).notNull(),
		ts: integer("ts", { mode: "timestamp" }).notNull(),
	},
	(t) => [
		index("events_burrow_seq_idx").on(t.burrowId, t.seq),
		index("events_burrow_ts_idx").on(t.burrowId, sql`${t.ts} DESC`),
	],
);

export const messages = sqliteTable(
	"messages",
	{
		id: text("id").primaryKey(),
		burrowId: text("burrow_id")
			.notNull()
			.references(() => burrows.id),
		fromActor: text("from_actor").notNull(),
		body: text("body").notNull(),
		priority: text("priority", { enum: MESSAGE_PRIORITIES }).notNull(),
		state: text("state", { enum: MESSAGE_STATES }).notNull(),
		deliveredAtRunId: text("delivered_at_run_id"),
		createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
		deliveredAt: integer("delivered_at", { mode: "timestamp" }),
	},
	(t) => [
		index("messages_pending_idx").on(t.burrowId, t.state, sql`${t.priority} DESC`, t.createdAt),
	],
);

export const meta = sqliteTable("meta", {
	key: text("key").primaryKey(),
	value: text("value").notNull(),
});

export type BurrowRow = typeof burrows.$inferSelect;
export type BurrowInsert = typeof burrows.$inferInsert;
export type RunRow = typeof runs.$inferSelect;
export type RunInsert = typeof runs.$inferInsert;
export type EventRow = typeof events.$inferSelect;
export type EventInsert = typeof events.$inferInsert;
export type MessageRow = typeof messages.$inferSelect;
export type MessageInsert = typeof messages.$inferInsert;
export type MetaRow = typeof meta.$inferSelect;
