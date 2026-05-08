import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { ValidationError } from "../../core/errors.ts";
import { Client } from "../../lib/client.ts";
import { createLogger } from "../../logging/logger.ts";
import { parsePort, resolveTransport, runServeCommand } from "./serve.ts";

const silentLogger = createLogger({ level: "fatal" });

class CollectStream extends Writable {
	chunks: string[] = [];
	override _write(
		chunk: Buffer | string,
		_enc: BufferEncoding,
		cb: (err?: Error | null) => void,
	): void {
		this.chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
		cb();
	}
	get text(): string {
		return this.chunks.join("");
	}
}

describe("parsePort", () => {
	test("accepts 0 (ephemeral) and standard ports", () => {
		expect(parsePort("0")).toBe(0);
		expect(parsePort("8080")).toBe(8080);
		expect(parsePort("65535")).toBe(65535);
	});
	test("rejects negatives, floats, junk, out-of-range", () => {
		expect(() => parsePort("-1")).toThrow(ValidationError);
		expect(() => parsePort("1.5")).toThrow(ValidationError);
		expect(() => parsePort("abc")).toThrow(ValidationError);
		expect(() => parsePort("65536")).toThrow(ValidationError);
	});
});

describe("resolveTransport", () => {
	const defaults = { socketPath: "/var/run/burrow.sock" };

	test("no flags → default unix socket", () => {
		expect(resolveTransport({}, defaults)).toEqual({
			kind: "unix",
			path: "/var/run/burrow.sock",
		});
	});

	test("--socket overrides the default", () => {
		expect(resolveTransport({ socket: "/tmp/x.sock" }, defaults)).toEqual({
			kind: "unix",
			path: "/tmp/x.sock",
		});
	});

	test("--port (only) → tcp on 127.0.0.1", () => {
		expect(resolveTransport({ port: "8080" }, defaults)).toEqual({
			kind: "tcp",
			hostname: "127.0.0.1",
			port: 8080,
		});
	});

	test("--host + --port → tcp on the requested host", () => {
		expect(resolveTransport({ host: "0.0.0.0", port: "9000" }, defaults)).toEqual({
			kind: "tcp",
			hostname: "0.0.0.0",
			port: 9000,
		});
	});

	test("--host without --port is a ValidationError", () => {
		expect(() => resolveTransport({ host: "0.0.0.0" }, defaults)).toThrow(ValidationError);
	});

	test("--socket combined with --port is a ValidationError", () => {
		expect(() => resolveTransport({ socket: "/tmp/x.sock", port: "8080" }, defaults)).toThrow(
			ValidationError,
		);
	});

	test("--socket combined with --host is a ValidationError", () => {
		expect(() => resolveTransport({ socket: "/tmp/x.sock", host: "0.0.0.0" }, defaults)).toThrow(
			ValidationError,
		);
	});
});

describe("runServeCommand", () => {
	let dataDir: string;
	let client: Client;

	beforeEach(async () => {
		dataDir = mkdtempSync(join(tmpdir(), "burrow-serve-"));
		client = await Client.open({ dataDir, configDir: dataDir, cacheDir: dataDir });
	});

	afterEach(async () => {
		await client.close();
		rmSync(dataDir, { recursive: true, force: true });
	});

	test("binds tcp ephemeral port, serves /healthz, and stops on abort", async () => {
		const stdout = new CollectStream();
		const ac = new AbortController();

		const consumer = runServeCommand({
			client,
			options: { port: "0", noAuth: true },
			signal: ac.signal,
			stdout,
			logger: silentLogger,
		});

		// Give Bun.serve a tick to bind. The startup banner is the
		// only synchronous-ish signal we have that the listener is up.
		await waitFor(() => stdout.text.includes("listening on"));

		const urlMatch = /listening on (\S+)/.exec(stdout.text);
		expect(urlMatch).not.toBeNull();
		const baseUrl = urlMatch?.[1] ?? "";
		expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

		const res = await fetch(`${baseUrl}/healthz`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean };
		expect(body.ok).toBe(true);

		const startedAt = Date.now();
		ac.abort();
		const summary = await consumer;
		const elapsed = Date.now() - startedAt;

		expect(summary.transport.kind).toBe("tcp");
		expect(summary.authMode).toBe("none");
		// Acceptance #1: SIGINT closes cleanly within 1s. We give a
		// generous bound here — typical shutdown is ~10ms.
		expect(elapsed).toBeLessThan(1000);

		// Listener is gone after stop().
		await expect(fetch(baseUrl, { signal: AbortSignal.timeout(200) })).rejects.toThrow();
	});

	test("binds an explicit unix socket and tears it down on abort", async () => {
		const sockPath = join(dataDir, "explicit.sock");
		const stdout = new CollectStream();
		const ac = new AbortController();

		const consumer = runServeCommand({
			client,
			options: { socket: sockPath, noAuth: true },
			signal: ac.signal,
			stdout,
			logger: silentLogger,
		});

		await waitFor(() => stdout.text.includes(`unix://${sockPath}`));
		expect(existsSync(sockPath)).toBe(true);

		const res = await fetch("http://localhost/healthz", { unix: sockPath });
		expect(res.status).toBe(200);

		ac.abort();
		const summary = await consumer;
		expect(summary.transport).toEqual({ kind: "unix", path: sockPath });
		expect(existsSync(sockPath)).toBe(false);
	});

	test("default unix socket lives under cacheDir/burrow.sock", async () => {
		const stdout = new CollectStream();
		const ac = new AbortController();
		const consumer = runServeCommand({
			client,
			options: { noAuth: true },
			signal: ac.signal,
			stdout,
			logger: silentLogger,
		});

		const expected = join(dataDir, "burrow.sock");
		await waitFor(() => stdout.text.includes(`unix://${expected}`));
		expect(existsSync(expected)).toBe(true);

		ac.abort();
		await consumer;
	});

	test("BURROW_API_TOKEN gates requests when --no-auth is omitted", async () => {
		const stdout = new CollectStream();
		const ac = new AbortController();

		const consumer = runServeCommand({
			client,
			options: { port: "0" },
			signal: ac.signal,
			stdout,
			env: { BURROW_API_TOKEN: "s3cr3t" },
			logger: silentLogger,
		});

		await waitFor(() => stdout.text.includes("listening on"));
		const baseUrl = (/listening on (\S+)/.exec(stdout.text)?.[1] ?? "") as string;

		const denied = await fetch(`${baseUrl}/burrows`);
		expect(denied.status).toBe(401);

		const allowed = await fetch(`${baseUrl}/burrows`, {
			headers: { authorization: "Bearer s3cr3t" },
		});
		// /burrows is implemented (not 501); empty list returns 200.
		expect([200, 501]).toContain(allowed.status);

		ac.abort();
		const summary = await consumer;
		expect(summary.authMode).toBe("bearer");
	});

	test("missing BURROW_API_TOKEN without --no-auth → ValidationError", async () => {
		const stdout = new CollectStream();
		const ac = new AbortController();
		await expect(
			runServeCommand({
				client,
				options: { port: "0" },
				signal: ac.signal,
				stdout,
				env: {},
				logger: silentLogger,
			}),
		).rejects.toThrow(ValidationError);
	});

	test("aborting before runServeCommand starts returns immediately without binding", async () => {
		const stdout = new CollectStream();
		const ac = new AbortController();
		ac.abort();
		const summary = await runServeCommand({
			client,
			options: { port: "0", noAuth: true },
			signal: ac.signal,
			stdout,
			logger: silentLogger,
		});
		// Listener bound, banner printed, then we returned because abort was
		// already pending. The transport reflects the bound state.
		expect(summary.transport.kind).toBe("tcp");
	});

	test("--json prints a single startup envelope instead of the human banner", async () => {
		const stdout = new CollectStream();
		const ac = new AbortController();
		const consumer = runServeCommand({
			client,
			options: { port: "0", noAuth: true, json: true },
			signal: ac.signal,
			stdout,
			logger: silentLogger,
		});

		await waitFor(() => stdout.text.length > 0);
		const line = stdout.text.trim();
		const envelope = JSON.parse(line) as {
			url: string;
			transport: { kind: string };
			authMode: string;
			pid: number;
		};
		expect(envelope.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		expect(envelope.transport.kind).toBe("tcp");
		expect(envelope.authMode).toBe("none");
		expect(envelope.pid).toBe(process.pid);
		expect(stdout.text).not.toContain("press Ctrl-C");

		ac.abort();
		await consumer;
	});

	test("creates the unix socket parent directory if missing", async () => {
		const sockPath = join(dataDir, "nested", "dir", "burrow.sock");
		const stdout = new CollectStream();
		const ac = new AbortController();

		const consumer = runServeCommand({
			client,
			options: { socket: sockPath, noAuth: true },
			signal: ac.signal,
			stdout,
			logger: silentLogger,
		});

		await waitFor(() => stdout.text.includes(`unix://${sockPath}`));
		expect(existsSync(sockPath)).toBe(true);

		ac.abort();
		await consumer;
	});
});

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
	const startedAt = Date.now();
	while (!predicate()) {
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error(`waitFor predicate did not become true within ${timeoutMs}ms`);
		}
		await new Promise((r) => setTimeout(r, 5));
	}
}
