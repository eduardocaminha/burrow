/**
 * Pre-spawn inbox injector (SPEC §13.2 / §13.3).
 *
 * The run loop calls `prepareTurnInjection` immediately before invoking the
 * runtime's `buildSpawnCommand`. The helper:
 *   1. Looks up the agent runtime so the caller can short-circuit when an
 *      agent is one-shot (`supportsResume === false` in V1) versus spawn-
 *      per-turn — codex still receives pending messages folded into its
 *      prompt prefix, but the CLI surfaces the difference at send time.
 *   2. Atomically claims every pending message for the burrow and tags the
 *      delivery to the run, so the next sweep / list reflects the state
 *      change even if the spawn fails before the agent reads them.
 *
 * Crash recovery: claimed-but-undelivered messages get reset to `unread`
 * by `runStartupRecovery` (SPEC §10.2) when the owning run never reaches
 * a terminal state, so users don't lose steering on a kill -9.
 */

import type { Message } from "../core/types.ts";
import type { AgentRegistry } from "../runtime/registry.ts";
import type { AgentRuntime } from "../runtime/runtime.ts";
import type { Inbox } from "./inbox.ts";

export interface PrepareTurnInjectionInput {
	inbox: Inbox;
	registry: AgentRegistry;
	burrowId: string;
	runId: string;
	agentId: string;
	now?: Date;
}

export interface TurnInjection {
	runtime: AgentRuntime;
	messages: Message[];
	/**
	 * True when the runtime is one-shot (no spawn-per-turn). The CLI uses
	 * this to warn at `burrow send` time that messages will queue for the
	 * next *run* rather than the next turn (SPEC §13.3).
	 */
	deferred: boolean;
}

export function prepareTurnInjection(input: PrepareTurnInjectionInput): TurnInjection {
	const runtime = input.registry.require(input.agentId);
	const messages = input.inbox.claimForRun(input.burrowId, input.runId, input.now);
	return {
		runtime,
		messages,
		deferred: !isSpawnPerTurn(runtime),
	};
}

/**
 * Spawn-per-turn runtimes deliver messages within the next agent turn; the
 * V1 built-ins flag this implicitly via `encodeInboxMessage` (SPEC §12.1).
 * Declarative configs surface the same signal through `inboxDelivery !==
 * 'none'`. One-shot runtimes (codex) leave both unset and rely on the
 * runtime's own prompt composer (`composeCodexPrompt`) for the next-run
 * fallback.
 */
export function isSpawnPerTurn(runtime: AgentRuntime): boolean {
	return typeof runtime.encodeInboxMessage === "function";
}
