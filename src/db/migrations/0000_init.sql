CREATE TABLE `burrows` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_id` text,
	`kind` text NOT NULL,
	`name` text,
	`project_root` text NOT NULL,
	`workspace_path` text NOT NULL,
	`branch` text NOT NULL,
	`provider` text NOT NULL,
	`provider_state_json` text,
	`profile_json` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`destroyed_at` integer
);
--> statement-breakpoint
CREATE INDEX `burrows_state_kind_idx` ON `burrows` (`state`,`kind`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`burrow_id` text NOT NULL,
	`run_id` text,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`stream` text NOT NULL,
	`payload_json` text NOT NULL,
	`ts` integer NOT NULL,
	FOREIGN KEY (`burrow_id`) REFERENCES `burrows`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `events_burrow_seq_idx` ON `events` (`burrow_id`,`seq`);--> statement-breakpoint
CREATE INDEX `events_burrow_ts_idx` ON `events` (`burrow_id`,"ts" DESC);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`burrow_id` text NOT NULL,
	`from_actor` text NOT NULL,
	`body` text NOT NULL,
	`priority` text NOT NULL,
	`state` text NOT NULL,
	`delivered_at_run_id` text,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	FOREIGN KEY (`burrow_id`) REFERENCES `burrows`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `messages_pending_idx` ON `messages` (`burrow_id`,`state`,"priority" DESC,`created_at`);--> statement-breakpoint
CREATE TABLE `meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`burrow_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`prompt` text NOT NULL,
	`resume_of_run_id` text,
	`state` text NOT NULL,
	`exit_code` integer,
	`error_message` text,
	`metadata_json` text,
	`queued_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`burrow_id`) REFERENCES `burrows`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `runs_burrow_queued_idx` ON `runs` (`burrow_id`,"queued_at" DESC);--> statement-breakpoint
CREATE INDEX `runs_state_idx` ON `runs` (`state`);