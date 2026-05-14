/**
 * Sidecar registry (SPEC §8.7, R-08, coordination seed `burrow-8647`).
 *
 * Sidecars are long-lived non-agent processes scoped to a burrow. Warren's
 * R-19 per-run preview environments are the load-bearing consumer: after
 * the agent run terminates, warren spawns `preview.command` (e.g. `bun run
 * dev`) as a sidecar inside the same workspace and routes external HTTP
 * traffic at it via an inbound port-forward (`SandboxProfile.inboundPortForwards`).
 *
 * Lifecycle model:
 *   - Storage is in-memory (per `burrow serve` process). Sidecars are
 *     ephemeral — a worker restart drops them. SQLite persistence would
 *     just race the cascade-on-burrow-delete invariant; pulling sidecars
 *     across restarts is warren's job anyway (re-spawn from the preview
 *     row).
 *   - Each session inherits the burrow's stored `SandboxProfile`
 *     (`burrow.profileJson`) augmented with the sidecar's optional
 *     `inboundPortForward`. The sidecar is not an agent run — it doesn't
 *     emit `run_event`s; lifecycle transitions go through the optional
 *     event bus as `sidecar_*` events.
 *   - Per-burrow cap (default 4, override via `BURROW_SIDECAR_CAP`)
 *     bounds blast radius if warren misbehaves; over-cap creates throw
 *     `SidecarCapExceededError` → HTTP 409.
 *   - `cascadeDeleteBurrow` is the cleanup hook the burrow `DELETE` path
 *     calls before marking the row destroyed — terminate every sidecar
 *     and release every forward.
 */

import { BurrowError, NotFoundError, ValidationError } from "../core/errors.ts";
import type { Burrow } from "../core/types.ts";
import type { Client } from "../lib/client.ts";
import {
	type ForwardHandle,
	type StartForwardOptions,
	startInboundForward,
} from "../provider/local/inbound-forward.ts";
import { runSandboxed } from "../provider/local/sandbox.ts";
import type { SandboxProfile, SpawnCommand, SpawnResult } from "../provider/types.ts";

const DEFAULT_CAP = 4;

const SIDECAR_STATES = ["starting", "live", "exited", "failed", "torn-down"] as const;
export type SidecarState = (typeof SIDECAR_STATES)[number];

export interface SidecarCreateInput {
	burrowId: string;
	command: readonly string[];
	env?: Readonly<Record<string, string>>;
	cwd?: string;
	inboundPortForward?: { hostPort: number; sandboxPort: number };
	readinessPath?: string;
}

export interface SidecarRecord {
	readonly id: string;
	readonly burrowId: string;
	readonly command: readonly string[];
	readonly state: SidecarState;
	readonly startedAt: Date;
	readonly exitCode: number | null;
	readonly message: string | null;
	readonly pid: number | null;
	readonly hostPortBound: boolean;
	readonly inboundPortForward: { hostPort: number; sandboxPort: number } | null;
}

export interface SidecarLogs {
	stdout: string;
	stderr: string;
}

/** HTTP 409 error mapped via `statusFor` in `src/server/errors.ts`. */
export class SidecarCapExceededError extends BurrowError {
	readonly code = "sidecar_cap_exceeded";
}

export type SidecarSpawnFn = (
	profile: SandboxProfile,
	command: SpawnCommand,
) => Promise<SpawnResult>;

export type ForwardStarter = (
	spec: { hostPort: number; sandboxPort: number; sandboxPid: number },
	options?: StartForwardOptions,
) => Promise<ForwardHandle>;

export interface SidecarRegistryOptions {
	cap?: number;
	/** Test seam: alternate sandboxed-spawn impl (defaults to `runSandboxed`). */
	spawn?: SidecarSpawnFn;
	/** Test seam: alternate inbound-forward starter. */
	startForward?: ForwardStarter;
	/** Default ring-buffer size per stream (stdout / stderr); 64 KiB by default. */
	logCapBytes?: number;
}

interface SidecarSession {
	id: string;
	burrowId: string;
	command: string[];
	state: SidecarState;
	startedAt: Date;
	exitCode: number | null;
	message: string | null;
	pid: number | null;
	process: SpawnResult | null;
	forward: ForwardHandle | null;
	inboundPortForward: { hostPort: number; sandboxPort: number } | null;
	hostPortBound: boolean;
	stdoutLog: RingBuffer;
	stderrLog: RingBuffer;
}

const DEFAULT_LOG_CAP = 64 * 1024;

/**
 * Single-stream log ring-buffer. Bytes past `cap` evict the oldest chunks
 * head-first; on read we decode the remaining payload as UTF-8 (lossy but
 * adequate for the GET /logs surface — operators reading sidecar logs
 * accept truncation as the cost of a small bound).
 */
class RingBuffer {
	private chunks: Uint8Array[] = [];
	private total = 0;
	constructor(private readonly cap: number) {}

	push(chunk: Uint8Array): void {
		this.chunks.push(chunk);
		this.total += chunk.length;
		while (this.total > this.cap && this.chunks.length > 0) {
			const head = this.chunks[0];
			if (!head) break;
			const overshoot = this.total - this.cap;
			if (head.length <= overshoot) {
				this.chunks.shift();
				this.total -= head.length;
			} else {
				this.chunks[0] = head.subarray(overshoot);
				this.total -= overshoot;
			}
		}
	}

	read(tailBytes?: number): string {
		const flat = this.flatten();
		const slice =
			tailBytes !== undefined && tailBytes < flat.length
				? flat.subarray(flat.length - tailBytes)
				: flat;
		return new TextDecoder("utf-8", { fatal: false }).decode(slice);
	}

	private flatten(): Uint8Array {
		if (this.chunks.length === 1) {
			const only = this.chunks[0];
			if (only) return only;
		}
		const out = new Uint8Array(this.total);
		let off = 0;
		for (const c of this.chunks) {
			out.set(c, off);
			off += c.length;
		}
		return out;
	}
}

export interface SidecarRegistryDeps {
	client: Client;
}

export class SidecarRegistry {
	private readonly byBurrow = new Map<string, Map<string, SidecarSession>>();
	private readonly cap: number;
	private readonly spawn: SidecarSpawnFn;
	private readonly startForward: ForwardStarter;
	private readonly logCap: number;
	private idSeq = 0;

	constructor(
		private readonly deps: SidecarRegistryDeps,
		opts: SidecarRegistryOptions = {},
	) {
		this.cap = opts.cap ?? resolveCap();
		this.spawn = opts.spawn ?? runSandboxed;
		this.startForward = opts.startForward ?? startInboundForward;
		this.logCap = opts.logCapBytes ?? DEFAULT_LOG_CAP;
	}

	async create(input: SidecarCreateInput): Promise<SidecarRecord> {
		const burrow = this.deps.client.burrows.get(input.burrowId);
		if (burrow.state !== "active") {
			throw new ValidationError(
				`burrow ${burrow.id} is in state '${burrow.state}'; sidecars require an active burrow`,
			);
		}
		validateCommand(input.command);
		const bucket = this.bucket(burrow.id);
		const live = countLive(bucket);
		if (live >= this.cap) {
			throw new SidecarCapExceededError(
				`burrow ${burrow.id} has ${live}/${this.cap} live sidecars; tear one down before adding another`,
				{ recoveryHint: `cap is configurable via BURROW_SIDECAR_CAP (default ${DEFAULT_CAP})` },
			);
		}

		const id = this.nextId();
		const command: string[] = [...input.command];
		const session: SidecarSession = {
			id,
			burrowId: burrow.id,
			command,
			state: "starting",
			startedAt: new Date(),
			exitCode: null,
			message: null,
			pid: null,
			process: null,
			forward: null,
			inboundPortForward: input.inboundPortForward ?? null,
			hostPortBound: false,
			stdoutLog: new RingBuffer(this.logCap),
			stderrLog: new RingBuffer(this.logCap),
		};
		bucket.set(id, session);

		const profile = sidecarProfile(burrow, input.inboundPortForward);
		const spawnCommand: SpawnCommand = { argv: command };
		if (input.env !== undefined) spawnCommand.env = { ...input.env };
		if (input.cwd !== undefined) spawnCommand.cwd = input.cwd;

		let proc: SpawnResult;
		try {
			proc = await this.spawn(profile, spawnCommand);
		} catch (err) {
			session.state = "failed";
			session.message = err instanceof Error ? err.message : String(err);
			return toRecord(session);
		}

		session.process = proc;
		session.pid = proc.pid;
		session.state = "live";

		if (input.inboundPortForward) {
			try {
				session.forward = await this.startForward({
					hostPort: input.inboundPortForward.hostPort,
					sandboxPort: input.inboundPortForward.sandboxPort,
					sandboxPid: proc.pid,
				});
				session.hostPortBound = session.forward.hostPortBound;
			} catch (err) {
				// Forward failure tears the sidecar down — warren's preview is
				// useless without inbound reachability.
				session.message = err instanceof Error ? err.message : String(err);
				session.state = "failed";
				proc.cancel();
				return toRecord(session);
			}
		}

		streamInto(proc.stdout, session.stdoutLog);
		streamInto(proc.stderr, session.stderrLog);
		proc.exited
			.then(async (code) => {
				if (session.state === "torn-down") return;
				session.state = "exited";
				session.exitCode = code;
				await session.forward?.stop().catch(() => undefined);
			})
			.catch(async (err) => {
				if (session.state === "torn-down") return;
				session.state = "failed";
				session.message = err instanceof Error ? err.message : String(err);
				await session.forward?.stop().catch(() => undefined);
			});

		return toRecord(session);
	}

	get(burrowId: string, sidecarId: string): SidecarRecord {
		const session = this.bucket(burrowId).get(sidecarId);
		if (!session) {
			throw new NotFoundError(`sidecar ${sidecarId} not found on burrow ${burrowId}`);
		}
		return toRecord(session);
	}

	list(burrowId: string): SidecarRecord[] {
		return [...this.bucket(burrowId).values()].map(toRecord);
	}

	logs(burrowId: string, sidecarId: string, tailBytes?: number): SidecarLogs {
		const session = this.bucket(burrowId).get(sidecarId);
		if (!session) {
			throw new NotFoundError(`sidecar ${sidecarId} not found on burrow ${burrowId}`);
		}
		return {
			stdout: session.stdoutLog.read(tailBytes),
			stderr: session.stderrLog.read(tailBytes),
		};
	}

	async delete(burrowId: string, sidecarId: string): Promise<void> {
		const session = this.bucket(burrowId).get(sidecarId);
		if (!session) {
			throw new NotFoundError(`sidecar ${sidecarId} not found on burrow ${burrowId}`);
		}
		await this.terminate(session);
	}

	async cascadeDeleteBurrow(burrowId: string): Promise<void> {
		const bucket = this.byBurrow.get(burrowId);
		if (!bucket) return;
		await Promise.all([...bucket.values()].map((s) => this.terminate(s)));
		this.byBurrow.delete(burrowId);
	}

	async shutdownAll(): Promise<void> {
		const sessions: SidecarSession[] = [];
		for (const bucket of this.byBurrow.values()) {
			for (const session of bucket.values()) sessions.push(session);
		}
		await Promise.all(sessions.map((s) => this.terminate(s)));
		this.byBurrow.clear();
	}

	private async terminate(session: SidecarSession): Promise<void> {
		if (session.state === "exited" || session.state === "torn-down" || session.state === "failed") {
			await session.forward?.stop().catch(() => undefined);
			session.forward = null;
			return;
		}
		session.state = "torn-down";
		try {
			session.process?.cancel();
		} catch {
			// already gone
		}
		await session.forward?.stop().catch(() => undefined);
		session.forward = null;
	}

	private bucket(burrowId: string): Map<string, SidecarSession> {
		let bucket = this.byBurrow.get(burrowId);
		if (!bucket) {
			bucket = new Map();
			this.byBurrow.set(burrowId, bucket);
		}
		return bucket;
	}

	private nextId(): string {
		this.idSeq += 1;
		const seq = this.idSeq.toString(16).padStart(4, "0");
		const rand = Math.floor(Math.random() * 0xffff)
			.toString(16)
			.padStart(4, "0");
		return `sc_${seq}${rand}`;
	}
}

function sidecarProfile(
	burrow: Burrow,
	inbound: { hostPort: number; sandboxPort: number } | undefined,
): SandboxProfile {
	const base = burrow.profileJson as SandboxProfile;
	if (!inbound) return base;
	const existing = base.inboundPortForwards ?? [];
	return {
		...base,
		inboundPortForwards: [...existing, inbound],
	};
}

function streamInto(source: ReadableStream<Uint8Array>, sink: RingBuffer): void {
	const reader = source.getReader();
	const pump = async (): Promise<void> => {
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value && value.length > 0) sink.push(value);
			}
		} catch {
			// stream closed unexpectedly — sidecar terminate path handles state.
		} finally {
			try {
				reader.releaseLock();
			} catch {
				// already released
			}
		}
	};
	pump().catch(() => undefined);
}

function countLive(bucket: Map<string, SidecarSession>): number {
	let n = 0;
	for (const s of bucket.values()) {
		if (s.state === "starting" || s.state === "live") n += 1;
	}
	return n;
}

function validateCommand(command: readonly string[]): void {
	if (!Array.isArray(command) || command.length === 0) {
		throw new ValidationError("field 'command' must be a non-empty array of strings");
	}
	for (let i = 0; i < command.length; i++) {
		const entry = command[i];
		if (typeof entry !== "string" || entry.length === 0) {
			throw new ValidationError(`command[${i}] must be a non-empty string`);
		}
	}
}

function toRecord(session: SidecarSession): SidecarRecord {
	return {
		id: session.id,
		burrowId: session.burrowId,
		command: [...session.command],
		state: session.state,
		startedAt: session.startedAt,
		exitCode: session.exitCode,
		message: session.message,
		pid: session.pid,
		hostPortBound: session.hostPortBound,
		inboundPortForward: session.inboundPortForward,
	};
}

function resolveCap(): number {
	const raw = process.env.BURROW_SIDECAR_CAP;
	if (raw === undefined) return DEFAULT_CAP;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n < 1) return DEFAULT_CAP;
	return n;
}
