/**
 * `burrow serve` — run the HTTP API server (SPEC §27, pl-5b40 step 5).
 *
 * Thin CLI shim over `startServer` (src/server/server.ts). Resolves transport
 * (unix socket primary, TCP opt-in), pulls auth from `--no-auth` or the
 * `BURROW_API_TOKEN` env, and waits on the AbortController the CLI wires to
 * SIGINT/SIGTERM. On signal: `handle.stop()` (force-closes connections via
 * Bun.serve.stop(true)) before withClient closes the Client — acceptance #1
 * is "SIGINT closes cleanly within 1s".
 *
 * Default transport is unix at `<paths.cacheDir>/burrow.sock` because the
 * single-host / warren-in-same-container deploy is the canonical posture
 * (SPEC §27). `--port` opts into TCP for cross-container reach. `--socket`
 * and `--port`/`--host` are mutually exclusive — picking one transport keeps
 * the bound URL unambiguous in the startup banner.
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { ValidationError } from "../../core/errors.ts";
import type { Client } from "../../lib/client.ts";
import type { Logger } from "../../logging/logger.ts";
import {
	type RunDispatcherHandle,
	type RunDispatcherOptions,
	startRunDispatcher,
} from "../../runner/dispatcher.ts";
import { resolveAuth } from "../../server/auth.ts";
import { startServer } from "../../server/server.ts";
import type { Transport } from "../../server/types.ts";

export interface ServeCommandOptions {
	socket?: string;
	host?: string;
	/** Commander hands ports through as strings; we parse them ourselves. */
	port?: string;
	noAuth?: boolean;
	json?: boolean;
}

export interface ServeCommandInput {
	client: Client;
	options: ServeCommandOptions;
	/** Required — the CLI wires SIGINT/SIGTERM here so shutdown is cooperative. */
	signal: AbortSignal;
	stdout: NodeJS.WritableStream;
	/**
	 * Override the default unix socket path (tests). The CLI default is
	 * `<client.paths.cacheDir>/burrow.sock` — derived inside runServeCommand
	 * so tests don't have to thread cacheDir through.
	 */
	defaultSocketPath?: string;
	/** Override env for `resolveAuth` (tests). Defaults to `process.env`. */
	env?: Record<string, string | undefined>;
	/** Logger override (tests). Defaults to `client.logger`. */
	logger?: Logger;
	/**
	 * Test seams forwarded to the in-process `RunDispatcher` (spawn, proxy
	 * starter, install check). Production callers leave this unset; tests
	 * set `spawn` to a fake implementation so HTTP-driven runs don't shell
	 * out to bwrap/sandbox-exec on the host.
	 */
	dispatcherOptions?: Pick<RunDispatcherOptions, "spawn" | "startProxy" | "installCheck">;
}

export interface ServeCommandSummary {
	/** Same string `startServer` published — `unix://…` or `http://…`. */
	url: string;
	/** Resolved transport (TCP entry has the actual bound port if 0 was passed). */
	transport: Transport;
	authMode: "bearer" | "none";
	/**
	 * Crash-recovery summary from the in-process `RunDispatcher`. Captures
	 * the rows the startup sweep flipped to terminal so callers (and tests)
	 * can confirm the dispatcher actually booted.
	 */
	recovered: { failedRunIds: string[]; resetMessageIds: string[] };
}

export async function runServeCommand(input: ServeCommandInput): Promise<ServeCommandSummary> {
	const transport = resolveTransport(input.options, {
		socketPath: input.defaultSocketPath ?? defaultSocketPath(input.client),
	});

	if (transport.kind === "unix") {
		// `Bun.serve({ unix })` doesn't mkdir-p the parent — a fresh install
		// where cacheDir doesn't exist yet would fail with ENOENT otherwise.
		await mkdir(dirname(transport.path), { recursive: true });
	}

	const auth = resolveAuth({
		noAuth: input.options.noAuth ?? false,
		env: input.env ?? process.env,
	});

	const logger = input.logger ?? input.client.logger;
	// Dispatcher boots BEFORE the HTTP listener so:
	//   1. crash-recovery's `failAllRunning` sweep finishes before the
	//      first request lands, so a client polling /runs/:id never sees a
	//      stale `running` row from the previous process.
	//   2. the create-time hook is installed before `client.runs.create`
	//      can be reached over HTTP — no run can sneak past the dispatcher.
	const dispatcherOptions: RunDispatcherOptions = { logger };
	if (input.dispatcherOptions?.spawn) dispatcherOptions.spawn = input.dispatcherOptions.spawn;
	if (input.dispatcherOptions?.startProxy)
		dispatcherOptions.startProxy = input.dispatcherOptions.startProxy;
	if (input.dispatcherOptions?.installCheck)
		dispatcherOptions.installCheck = input.dispatcherOptions.installCheck;
	const dispatcher: RunDispatcherHandle = startRunDispatcher(input.client, dispatcherOptions);
	const recovered = dispatcher.start().recovered;

	let handle: Awaited<ReturnType<typeof startServer>>;
	try {
		handle = startServer(input.client, { transport, auth, logger });
	} catch (err) {
		await dispatcher.stop({ force: true });
		throw err;
	}

	const summary: ServeCommandSummary = {
		url: handle.url,
		transport: handle.transport,
		authMode: input.options.noAuth ? "none" : "bearer",
		recovered,
	};

	emitStartupBanner(summary, input);

	try {
		await waitForAbort(input.signal);
	} finally {
		// HTTP first so no new runs can be enqueued while the dispatcher
		// is draining; then dispatcher with `force` so in-flight handlers
		// see the abort and tear their spawned subprocess down.
		await handle.stop();
		await dispatcher.stop({ force: true });
	}

	return summary;
}

export function resolveTransport(
	opts: ServeCommandOptions,
	defaults: { socketPath: string },
): Transport {
	const tcpRequested = opts.host !== undefined || opts.port !== undefined;
	const socketRequested = opts.socket !== undefined;
	if (tcpRequested && socketRequested) {
		throw new ValidationError("--socket cannot be combined with --host/--port", {
			recoveryHint: "use --socket for unix transport, or --port (with optional --host) for TCP",
		});
	}
	if (socketRequested) {
		return { kind: "unix", path: opts.socket as string };
	}
	if (tcpRequested) {
		if (opts.port === undefined) {
			throw new ValidationError("--host requires --port", {
				recoveryHint:
					"pass --port <n> alongside --host, or drop --host to use the default 127.0.0.1",
			});
		}
		return {
			kind: "tcp",
			hostname: opts.host ?? "127.0.0.1",
			port: parsePort(opts.port),
		};
	}
	return { kind: "unix", path: defaults.socketPath };
}

export function parsePort(raw: string): number {
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n < 0 || n > 65535 || String(n) !== raw) {
		throw new ValidationError(`--port expects an integer in [0, 65535], got '${raw}'`);
	}
	return n;
}

function defaultSocketPath(client: Client): string {
	return `${client.paths.cacheDir}/burrow.sock`;
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
	if (signal.aborted) return;
	await new Promise<void>((resolve) => {
		signal.addEventListener("abort", () => resolve(), { once: true });
	});
}

function emitStartupBanner(summary: ServeCommandSummary, input: ServeCommandInput): void {
	if (input.options.json) {
		input.stdout.write(
			`${JSON.stringify({
				url: summary.url,
				transport: summary.transport,
				authMode: summary.authMode,
				pid: process.pid,
			})}\n`,
		);
		return;
	}
	const authLine =
		summary.authMode === "bearer" ? "bearer (BURROW_API_TOKEN)" : "disabled (--no-auth)";
	input.stdout.write(`burrow serve listening on ${summary.url}\n`);
	input.stdout.write(`  auth: ${authLine}\n`);
	input.stdout.write("  press Ctrl-C to stop\n");
}
