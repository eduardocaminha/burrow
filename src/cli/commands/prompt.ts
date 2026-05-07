/**
 * `burrow prompt <id> '<message>'` — drive one synchronous run against a
 * burrow (SPEC §5.1, §16).
 *
 * The CLI process owns the spawn from end to end: claim a queued run, mark it
 * running, claim pending steering messages, render the spawn command via the
 * registered `AgentRuntime`, dispatch into the sandbox via `runSandboxed`,
 * stream stdout line-by-line through `parseEvents` into the `events` table
 * (and to stdout as NDJSON or pretty), then finalize. We deliberately bypass
 * `RunLoop` — that machinery is for daemonized callers driving N burrows in
 * parallel; the CLI just needs one run, inline, with its events flowing to
 * the user's terminal.
 *
 * Defaults follow burrow.toml: when `--agent` is omitted we pick the first
 * `[[agents]]` row from the burrow's project. Honors `SandboxProfile.setEnv`
 * baked at `burrow up` time. Refuses to dispatch against stopped/destroyed
 * burrows and points the user at `bw attach`.
 */

import { loadBurrowToml } from "../../config/burrow-toml-loader.ts";
import { AgentNotInstalled, ValidationError } from "../../core/errors.ts";
import type { Burrow, Run } from "../../core/types.ts";
import { appendAndPublish } from "../../events/publish.ts";
import { renderNdjson, renderPretty } from "../../events/render.ts";
import type { Client } from "../../lib/client.ts";
import { runSandboxed } from "../../provider/local/sandbox.ts";
import type { SandboxProfile, SpawnCommand, SpawnResult } from "../../provider/types.ts";
import { composeCodexPrompt, writeCodexPromptFile } from "../../runtime/codex.ts";
import type { AgentRuntime, InstallCheckResult, RuntimeEvent } from "../../runtime/runtime.ts";

export type SpawnFn = (profile: SandboxProfile, command: SpawnCommand) => Promise<SpawnResult>;

export interface PromptCommandOptions {
	/** Override the default agent (burrow.toml [[agents]][0].id). */
	agent?: string;
	/** k=v pairs stored on `runs.metadata_json` for downstream callers. */
	metadata?: string[];
	/** Force NDJSON event output. Pretty mode is the default on TTY. */
	json?: boolean;
	/** Don't write events to stdout — still persists everything. */
	noStream?: boolean;
}

export interface PromptCommandInput {
	client: Client;
	burrowId: string;
	prompt: string;
	options: PromptCommandOptions;
	stdout: NodeJS.WritableStream;
	signal?: AbortSignal;
	/** TTY hint — defaults to checking process.stdout when omitted. */
	isTty?: boolean;
	/** Test seam: alternate sandboxed-spawn implementation. */
	spawn?: SpawnFn;
	/** Test seam: skip the runtime's installCheck. */
	installCheck?: (rt: AgentRuntime) => Promise<InstallCheckResult>;
	/** Test seam: alternate burrow.toml loader (for default-agent resolution). */
	burrowTomlLoader?: typeof loadBurrowToml;
}

export interface PromptCommandResult {
	burrow: Burrow;
	run: Run;
	agentId: string;
	state: Run["state"];
	exitCode: number | null;
	/** Number of structured events persisted. */
	eventsPersisted: number;
	/** Number of pending steering messages folded into this turn. */
	messagesDelivered: number;
}

export async function runPromptCommand(input: PromptCommandInput): Promise<PromptCommandResult> {
	const repos = input.client.repos;
	const burrow = repos.burrows.require(input.burrowId);

	if (burrow.state !== "active") {
		throw new ValidationError(`cannot prompt burrow ${burrow.id} in state '${burrow.state}'`, {
			recoveryHint: `restart it with \`bw attach ${burrow.id}\` and retry`,
		});
	}

	const agentId = await resolveAgentId({
		burrow,
		override: input.options.agent,
		loader: input.burrowTomlLoader ?? loadBurrowToml,
	});
	const runtime = input.client.agents.require(agentId);

	const installCheck = input.installCheck ?? ((rt) => rt.installCheck());
	const install = await installCheck(runtime);
	if (!install.installed) {
		throw new AgentNotInstalled(`agent '${runtime.id}' is not installed on this host`, {
			recoveryHint: install.hint,
		});
	}

	const profile = burrow.profileJson as SandboxProfile;
	const metadata = parseMetadataPairs(input.options.metadata);

	const run = repos.runs.enqueue({
		burrowId: burrow.id,
		agentId: runtime.id,
		prompt: input.prompt,
		metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
	});

	const claimed = repos.runs.claimById(run.id);
	if (!claimed) {
		throw new ValidationError(`failed to claim run ${run.id} for dispatch`);
	}

	const pendingMessages = input.client.inbox.raw.claimForRun(burrow.id, claimed.id);

	if (runtime.prepareWorkspace) {
		await runtime.prepareWorkspace({
			burrow,
			run: claimed,
			workspacePath: burrow.workspacePath,
		});
	}

	// Codex consumes its prompt from a file on disk; the runtime contract
	// doesn't expose the prompt to prepareWorkspace, so the dispatcher writes
	// it here using the runtime's own composer.
	if (runtime.id === "codex") {
		await writeCodexPromptFile(
			burrow.workspacePath,
			claimed.id,
			composeCodexPrompt(input.prompt, pendingMessages),
		);
	}

	const command = runtime.buildSpawnCommand({
		burrow,
		run: claimed,
		prompt: input.prompt,
		pendingMessages,
		envResolved: profile.setEnv ?? {},
		workspacePath: burrow.workspacePath,
	});

	const json = resolveJsonMode(input.options.json, input.isTty);
	const writeStream = input.options.noStream !== true;
	const spawn = input.spawn ?? runSandboxed;

	let proc: SpawnResult;
	try {
		proc = await spawn(profile, command);
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		repos.runs.finalize(claimed.id, { state: "failed", errorMessage });
		throw err;
	}

	let cancelled = false;
	const onAbort = (): void => {
		if (cancelled) return;
		cancelled = true;
		proc.cancel();
	};
	if (input.signal) {
		if (input.signal.aborted) onAbort();
		else input.signal.addEventListener("abort", onAbort, { once: true });
	}

	let eventsPersisted = 0;
	const persistEvents = (events: RuntimeEvent[]): void => {
		for (const ev of events) {
			const persisted = appendAndPublish({
				repo: repos.events,
				bus: input.client.bus,
				burrowId: burrow.id,
				runId: claimed.id,
				kind: ev.kind,
				stream: ev.stream,
				payload: ev.payload,
				...(ev.ts !== undefined ? { ts: ev.ts } : {}),
			});
			eventsPersisted += 1;
			if (writeStream) {
				input.stdout.write(json ? renderNdjson(persisted) : renderPretty(persisted));
			}
		}
	};

	const consumeStdout = async (): Promise<void> => {
		for await (const line of readLines(proc.stdout)) {
			if (line.length === 0) continue;
			const events = runtime.parseEvents(line, { burrow, run: claimed });
			persistEvents(events);
		}
	};

	const consumeStderr = async (): Promise<void> => {
		for await (const line of readLines(proc.stderr)) {
			if (line.length === 0) continue;
			persistEvents([{ kind: "stderr", stream: "stderr", payload: { line } }]);
		}
	};

	let exitCode: number;
	let runtimeError: unknown;
	try {
		[exitCode] = await Promise.all([
			proc.exited,
			consumeStdout().catch((err) => {
				runtimeError = err;
			}),
			consumeStderr().catch((err) => {
				runtimeError = runtimeError ?? err;
			}),
		]);
	} finally {
		if (input.signal) input.signal.removeEventListener("abort", onAbort);
	}

	const finalized = ((): Run => {
		if (cancelled) {
			return repos.runs.finalize(claimed.id, {
				state: "cancelled",
				exitCode,
				errorMessage: "cancelled via signal",
			});
		}
		if (runtimeError) {
			const message = runtimeError instanceof Error ? runtimeError.message : String(runtimeError);
			return repos.runs.finalize(claimed.id, {
				state: "failed",
				exitCode,
				errorMessage: `event stream failed: ${message}`,
			});
		}
		if (exitCode === 0) {
			return repos.runs.finalize(claimed.id, { state: "succeeded", exitCode });
		}
		return repos.runs.finalize(claimed.id, {
			state: "failed",
			exitCode,
			errorMessage: `agent exited with code ${exitCode}`,
		});
	})();

	if (runtimeError && !cancelled) throw runtimeError;

	return {
		burrow,
		run: finalized,
		agentId: runtime.id,
		state: finalized.state,
		exitCode,
		eventsPersisted,
		messagesDelivered: pendingMessages.length,
	};
}

export function renderPromptResult(result: PromptCommandResult): string {
	const sym = result.state === "succeeded" ? "✓" : result.state === "cancelled" ? "!" : "✗";
	const head =
		result.exitCode !== null
			? `${sym} run ${result.run.id} ${result.state} (exit ${result.exitCode})`
			: `${sym} run ${result.run.id} ${result.state}`;
	const lines = [
		head,
		`  agent:    ${result.agentId}`,
		`  burrow:   ${result.burrow.id}`,
		`  events:   ${result.eventsPersisted}`,
	];
	if (result.messagesDelivered > 0) {
		lines.push(`  steering: ${result.messagesDelivered} message(s) delivered`);
	}
	return lines.join("\n");
}

export function parseMetadataPairs(pairs: string[] | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	if (!pairs) return out;
	for (const raw of pairs) {
		const eq = raw.indexOf("=");
		if (eq <= 0) {
			throw new ValidationError(`--metadata expects 'key=value', got '${raw}'`);
		}
		const key = raw.slice(0, eq);
		const value = raw.slice(eq + 1);
		out[key] = value;
	}
	return out;
}

interface ResolveAgentIdInput {
	burrow: Burrow;
	override: string | undefined;
	loader: typeof loadBurrowToml;
}

async function resolveAgentId(input: ResolveAgentIdInput): Promise<string> {
	if (input.override !== undefined && input.override.length > 0) return input.override;
	const loaded = await input.loader(input.burrow.projectRoot);
	const first = loaded?.config.agents?.[0]?.id;
	if (first) return first;
	throw new ValidationError("no default agent — pass --agent <id> or declare one in burrow.toml", {
		recoveryHint:
			"add an agent with `bw agents add <id>` (e.g. claude, sapling, codex), or pass --agent on the command line",
	});
}

function resolveJsonMode(flag: boolean | undefined, tty: boolean | undefined): boolean {
	if (flag !== undefined) return flag;
	if (tty === undefined) return !process.stdout.isTTY;
	return !tty;
}

async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string, void, void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			let idx = buf.indexOf("\n");
			while (idx !== -1) {
				yield buf.slice(0, idx);
				buf = buf.slice(idx + 1);
				idx = buf.indexOf("\n");
			}
		}
		buf += decoder.decode();
		if (buf.length > 0) yield buf;
	} finally {
		reader.releaseLock();
	}
}
