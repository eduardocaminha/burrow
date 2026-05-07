/**
 * Inbox — per-burrow steering message queue (SPEC §13).
 *
 * Thin facade over `MessagesRepo` that surfaces the public library API
 * (`Client.inbox.*`, SPEC §15.3): send, list, cancel, and the `claimForRun`
 * helper the run loop calls before each spawn so the runtime sees pending
 * messages as `SpawnContext.pendingMessages` (SPEC §13.2).
 *
 * Validation lives here, not in the repo: the inbox refuses to enqueue a
 * message against a non-active burrow so a stale CLI doesn't pile up
 * messages on a destroyed/stopped target. The repo stays a low-level
 * storage primitive that any future caller can use directly.
 */

import { ValidationError } from "../core/errors.ts";
import type { Message, MessagePriority, MessageState } from "../core/types.ts";
import type { Repos } from "../db/repos/index.ts";

export interface InboxSendInput {
	burrowId: string;
	body: string;
	priority?: MessagePriority;
	fromActor?: string;
	id?: string;
	now?: Date;
}

export interface InboxListFilter {
	state?: MessageState;
}

export class Inbox {
	constructor(private readonly repos: Repos) {}

	send(input: InboxSendInput): Message {
		if (input.body.length === 0) {
			throw new ValidationError("inbox message body must not be empty");
		}
		const burrow = this.repos.burrows.require(input.burrowId);
		if (burrow.state !== "active") {
			throw new ValidationError(`cannot send to burrow ${burrow.id} in state '${burrow.state}'`, {
				recoveryHint: "restart the burrow with `burrow attach` or pick an active one",
			});
		}
		return this.repos.messages.send({
			id: input.id,
			burrowId: input.burrowId,
			body: input.body,
			priority: input.priority,
			fromActor: input.fromActor ?? "user",
			now: input.now,
		});
	}

	list(burrowId: string, filter: InboxListFilter = {}): Message[] {
		return this.repos.messages.listByBurrow(burrowId, filter.state);
	}

	pending(burrowId: string): Message[] {
		return this.repos.messages.listPending(burrowId);
	}

	cancel(messageId: string): void {
		this.repos.messages.cancel(messageId);
	}

	count(burrowId: string, state?: MessageState): number {
		return this.repos.messages.count(burrowId, state);
	}

	/**
	 * Atomically claim every pending message for a burrow, attributing the
	 * delivery to the supplied run. Returns the ordered list (priority desc,
	 * then FIFO) so the runtime adapter can fold them into the next spawn.
	 *
	 * Crash safety: the recovery sweep resets `delivered` rows whose target
	 * run never reached terminal back to `unread`, so a process that dies
	 * mid-spawn doesn't lose steering messages.
	 */
	claimForRun(burrowId: string, runId: string, now?: Date): Message[] {
		return this.repos.messages.claimPendingForRun(burrowId, runId, now);
	}
}
