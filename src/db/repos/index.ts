/**
 * Convenience surface that wires every repo against a single drizzle handle.
 * Library callers grab one Repos and pass it through.
 */

import type { BurrowDb } from "../client.ts";
import { BurrowsRepo } from "./burrows.ts";
import { EventsRepo } from "./events.ts";
import { MessagesRepo } from "./messages.ts";
import { MetaRepo } from "./meta.ts";
import { RunsRepo } from "./runs.ts";

export interface Repos {
	burrows: BurrowsRepo;
	runs: RunsRepo;
	events: EventsRepo;
	messages: MessagesRepo;
	meta: MetaRepo;
}

export function createRepos(db: BurrowDb): Repos {
	return {
		burrows: new BurrowsRepo(db.drizzle),
		runs: new RunsRepo(db.drizzle),
		events: new EventsRepo(db.drizzle),
		messages: new MessagesRepo(db.drizzle),
		meta: new MetaRepo(db.drizzle),
	};
}

export { BurrowsRepo, EventsRepo, MessagesRepo, MetaRepo, RunsRepo };
