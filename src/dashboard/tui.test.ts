/**
 * Tests for the TUI runtime (src/dashboard/tui.ts) — the only impure piece
 * of the dashboard stack. Acceptance criteria covered map to pl-2085:
 *   - #6 clean alt-screen exit on Ctrl+C
 *   - #8 leak-free bus subscription
 *   - keypress dispatch + reducer wiring
 *   - resize listener with trailing-edge debounce
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type BurrowDb, openDatabase } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { appendAndPublish } from "../events/publish.ts";
import { EventBus } from "../events/tail.ts";
import {
	ALT_SCREEN_ENTER,
	ALT_SCREEN_EXIT,
	CURSOR_HIDE,
	CURSOR_HOME,
	CURSOR_SHOW,
	runTui,
	type TuiStdin,
	type TuiStdout,
	translateKeyBytes,
} from "./tui.ts";

function seedBurrow(repos: Repos, name: string) {
	return repos.burrows.create({
		kind: "project",
		name,
		projectRoot: `/work/${name}`,
		workspacePath: `/work/${name}/.burrow/ws`,
		branch: "main",
		provider: "local",
		profile: {},
	});
}

class FakeStdin implements TuiStdin {
	private listeners = new Set<(chunk: Buffer) => void>();
	isRaw = false;
	rawCalls: boolean[] = [];
	resumed = 0;
	paused = 0;

	on(_event: "data", listener: (chunk: Buffer) => void): unknown {
		this.listeners.add(listener);
		return this;
	}
	off(_event: "data", listener: (chunk: Buffer) => void): unknown {
		this.listeners.delete(listener);
		return this;
	}
	setRawMode(raw: boolean): unknown {
		this.rawCalls.push(raw);
		this.isRaw = raw;
		return this;
	}
	resume(): unknown {
		this.resumed += 1;
		return this;
	}
	pause(): unknown {
		this.paused += 1;
		return this;
	}

	send(s: string): void {
		const buf = Buffer.from(s, "utf8");
		// Snapshot listeners before invoking so listener mutations during
		// dispatch don't trip a Set.iterator invalidation.
		for (const listener of [...this.listeners]) listener(buf);
	}

	listenerCount(): number {
		return this.listeners.size;
	}
}

class FakeStdout implements TuiStdout {
	chunks: string[] = [];
	columns = 80;
	rows = 24;

	write(data: string): unknown {
		this.chunks.push(data);
		return true;
	}

	get text(): string {
		return this.chunks.join("");
	}
}

interface ResizeHarness {
	subscribe: (handler: () => void) => () => void;
	trigger: () => void;
	subscriberCount: () => number;
}

function makeResizeHarness(): ResizeHarness {
	const handlers = new Set<() => void>();
	return {
		subscribe: (handler) => {
			handlers.add(handler);
			return () => {
				handlers.delete(handler);
			};
		},
		trigger: () => {
			for (const h of [...handlers]) h();
		},
		subscriberCount: () => handlers.size,
	};
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("translateKeyBytes", () => {
	test("maps named keys to KeyName", () => {
		expect(translateKeyBytes(Buffer.from("q"))).toBe("q");
		expect(translateKeyBytes(Buffer.from("j"))).toBe("j");
		expect(translateKeyBytes(Buffer.from("k"))).toBe("k");
	});
	test("\\r and \\n both map to enter", () => {
		expect(translateKeyBytes(Buffer.from("\r"))).toBe("enter");
		expect(translateKeyBytes(Buffer.from("\n"))).toBe("enter");
	});
	test("lone ESC maps to esc; CSI sequences map to arrow / page keys", () => {
		expect(translateKeyBytes(Buffer.from("\x1b"))).toBe("esc");
		expect(translateKeyBytes(Buffer.from("\x1b[A"))).toBe("up");
		expect(translateKeyBytes(Buffer.from("\x1b[B"))).toBe("down");
		expect(translateKeyBytes(Buffer.from("\x1b[5~"))).toBe("pageUp");
		expect(translateKeyBytes(Buffer.from("\x1b[6~"))).toBe("pageDown");
	});
	test("Ctrl+C maps to q (raw mode swallows SIGINT)", () => {
		expect(translateKeyBytes(Buffer.from("\x03"))).toBe("q");
	});
	test("unknown bytes return null", () => {
		expect(translateKeyBytes(Buffer.from(""))).toBeNull();
		expect(translateKeyBytes(Buffer.from("Q"))).toBeNull();
		expect(translateKeyBytes(Buffer.from("x"))).toBeNull();
		expect(translateKeyBytes(Buffer.from("\x1b[Z"))).toBeNull();
	});
});

describe("runTui", () => {
	let db: BurrowDb;
	let repos: Repos;
	let bus: EventBus;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		bus = new EventBus();
	});

	afterEach(() => {
		bus.close();
		db.close();
	});

	test("emits initial frame and tears down cleanly on external abort", async () => {
		seedBurrow(repos, "alpha");
		const stdin = new FakeStdin();
		const stdout = new FakeStdout();
		const resize = makeResizeHarness();
		const ac = new AbortController();

		const run = runTui({
			repos,
			bus,
			signal: ac.signal,
			stdin,
			stdout,
			onResize: resize.subscribe,
			initialTermSize: { columns: 80, rows: 24 },
			coalesceMs: 0,
			pollIntervalMs: 0,
		});

		// Yield the event loop so the initial snapshot is emitted + rendered.
		await sleep(5);
		expect(stdout.chunks[0]).toBe(`${ALT_SCREEN_ENTER}${CURSOR_HIDE}`);
		expect(stdin.rawCalls[0]).toBe(true);
		expect(stdin.resumed).toBe(1);
		expect(stdout.text).toContain(CURSOR_HOME);
		// Header shows the count; list body shows the seeded burrow's row.
		expect(stdout.text).toContain("1 burrow");
		expect(stdout.text).toContain("active");

		ac.abort();
		const summary = await run;

		expect(summary.quitReason).toBe("abort");
		expect(summary.framesRendered).toBeGreaterThanOrEqual(1);

		// Cleanup: cursor + alt-screen restored, raw mode reset, listeners detached.
		expect(stdout.chunks.at(-1)).toBe(`${CURSOR_SHOW}${ALT_SCREEN_EXIT}`);
		expect(stdin.rawCalls.at(-1)).toBe(false);
		expect(stdin.listenerCount()).toBe(0);
		expect(bus.listenerCount()).toBe(0);
		expect(resize.subscriberCount()).toBe(0);
	});

	test("'q' keypress quits with reason='user' (acceptance §pl-2085#6)", async () => {
		seedBurrow(repos, "alpha");
		const stdin = new FakeStdin();
		const stdout = new FakeStdout();
		const resize = makeResizeHarness();

		const run = runTui({
			repos,
			bus,
			stdin,
			stdout,
			onResize: resize.subscribe,
			initialTermSize: { columns: 80, rows: 24 },
			coalesceMs: 0,
			pollIntervalMs: 0,
		});

		await sleep(5);
		stdin.send("q");
		const summary = await run;

		expect(summary.quitReason).toBe("user");
		// Alt-screen restored — terminal "usable" post-exit.
		expect(stdout.text.endsWith(`${CURSOR_SHOW}${ALT_SCREEN_EXIT}`)).toBe(true);
		expect(bus.listenerCount()).toBe(0);
	});

	test("Ctrl+C cleanly exits the alt-screen buffer (acceptance §pl-2085#6)", async () => {
		seedBurrow(repos, "alpha");
		const stdin = new FakeStdin();
		const stdout = new FakeStdout();
		const resize = makeResizeHarness();

		const run = runTui({
			repos,
			bus,
			stdin,
			stdout,
			onResize: resize.subscribe,
			initialTermSize: { columns: 80, rows: 24 },
			coalesceMs: 0,
			pollIntervalMs: 0,
		});

		await sleep(5);
		stdin.send("\x03");
		const summary = await run;

		expect(summary.quitReason).toBe("user");
		expect(stdout.text).toContain(ALT_SCREEN_ENTER);
		expect(stdout.text.endsWith(`${CURSOR_SHOW}${ALT_SCREEN_EXIT}`)).toBe(true);
		expect(stdin.rawCalls).toEqual([true, false]);
		expect(stdin.listenerCount()).toBe(0);
		expect(bus.listenerCount()).toBe(0);
		expect(resize.subscriberCount()).toBe(0);
	});

	test("'j' shifts selection and re-renders", async () => {
		seedBurrow(repos, "alpha");
		seedBurrow(repos, "beta");
		const stdin = new FakeStdin();
		const stdout = new FakeStdout();
		const resize = makeResizeHarness();
		const ac = new AbortController();

		const run = runTui({
			repos,
			bus,
			signal: ac.signal,
			stdin,
			stdout,
			onResize: resize.subscribe,
			initialTermSize: { columns: 100, rows: 24 },
			coalesceMs: 0,
			pollIntervalMs: 0,
		});

		await sleep(5);
		const framesBeforeKey = stdout.chunks.length;
		stdin.send("j");
		// Reducer + re-render are synchronous off the data event.
		expect(stdout.chunks.length).toBeGreaterThan(framesBeforeKey);

		ac.abort();
		const summary = await run;
		expect(summary.framesRendered).toBeGreaterThanOrEqual(2);
	});

	test("identity keypress (no state change) does not re-render", async () => {
		seedBurrow(repos, "only");
		const stdin = new FakeStdin();
		const stdout = new FakeStdout();
		const resize = makeResizeHarness();
		const ac = new AbortController();

		const run = runTui({
			repos,
			bus,
			signal: ac.signal,
			stdin,
			stdout,
			onResize: resize.subscribe,
			initialTermSize: { columns: 80, rows: 24 },
			coalesceMs: 0,
			pollIntervalMs: 0,
		});

		await sleep(5);
		const framesBefore = stdout.chunks.length;
		// Single burrow, can't move down — selection unchanged.
		stdin.send("j");
		stdin.send("k");
		expect(stdout.chunks.length).toBe(framesBefore);

		ac.abort();
		await run;
	});

	test("bus event triggers a fresh frame", async () => {
		const burrow = seedBurrow(repos, "alpha");
		const stdin = new FakeStdin();
		const stdout = new FakeStdout();
		const resize = makeResizeHarness();
		const ac = new AbortController();

		const run = runTui({
			repos,
			bus,
			signal: ac.signal,
			stdin,
			stdout,
			onResize: resize.subscribe,
			initialTermSize: { columns: 80, rows: 24 },
			coalesceMs: 5,
			pollIntervalMs: 0,
		});

		await sleep(5);
		const framesBeforeEvent = stdout.chunks.length;
		appendAndPublish({
			repo: repos.events,
			bus,
			burrowId: burrow.id,
			kind: "tool_use",
			stream: "stdout",
			payload: { x: 1 },
			ts: new Date(2000),
		});
		await sleep(20);

		expect(stdout.chunks.length).toBeGreaterThan(framesBeforeEvent);

		ac.abort();
		await run;
	});

	test("resize listener debounces and renders on the trailing edge (pl-2085 risk #2)", async () => {
		seedBurrow(repos, "alpha");
		const stdin = new FakeStdin();
		const stdout = new FakeStdout();
		const resize = makeResizeHarness();
		const ac = new AbortController();

		const run = runTui({
			repos,
			bus,
			signal: ac.signal,
			stdin,
			stdout,
			onResize: resize.subscribe,
			initialTermSize: { columns: 80, rows: 24 },
			resizeDebounceMs: 20,
			coalesceMs: 0,
			pollIntervalMs: 0,
		});

		await sleep(5);
		const framesBefore = stdout.chunks.length;

		// A burst of resize signals — only one redraw should land.
		stdout.columns = 100;
		stdout.rows = 30;
		resize.trigger();
		resize.trigger();
		resize.trigger();
		await sleep(5);
		expect(stdout.chunks.length).toBe(framesBefore);
		await sleep(40);
		expect(stdout.chunks.length).toBe(framesBefore + 1);

		ac.abort();
		await run;
	});

	test("opening + closing 100 runs leaves zero residual listeners", async () => {
		seedBurrow(repos, "alpha");
		expect(bus.listenerCount()).toBe(0);

		for (let i = 0; i < 100; i++) {
			const stdin = new FakeStdin();
			const stdout = new FakeStdout();
			const resize = makeResizeHarness();
			const ac = new AbortController();

			const run = runTui({
				repos,
				bus,
				signal: ac.signal,
				stdin,
				stdout,
				onResize: resize.subscribe,
				initialTermSize: { columns: 80, rows: 24 },
				coalesceMs: 0,
				pollIntervalMs: 0,
			});

			await sleep(2);
			ac.abort();
			await run;

			expect(stdin.listenerCount()).toBe(0);
			expect(resize.subscriberCount()).toBe(0);
		}

		expect(bus.listenerCount()).toBe(0);
	});

	test("respects external signal already aborted before start", async () => {
		seedBurrow(repos, "alpha");
		const stdin = new FakeStdin();
		const stdout = new FakeStdout();
		const resize = makeResizeHarness();
		const ac = new AbortController();
		ac.abort();

		const summary = await runTui({
			repos,
			bus,
			signal: ac.signal,
			stdin,
			stdout,
			onResize: resize.subscribe,
			initialTermSize: { columns: 80, rows: 24 },
			coalesceMs: 0,
			pollIntervalMs: 0,
		});

		expect(summary.quitReason).toBe("abort");
		expect(summary.framesRendered).toBe(0);
		// Cleanup still runs in finally.
		expect(stdout.chunks.at(-1)).toBe(`${CURSOR_SHOW}${ALT_SCREEN_EXIT}`);
		expect(bus.listenerCount()).toBe(0);
	});

	test("falls back to default term size when stdout has no columns/rows", async () => {
		seedBurrow(repos, "alpha");
		const stdin = new FakeStdin();
		// Plain stdout with no columns/rows fields.
		const stdout: TuiStdout = {
			chunks: [] as string[],
			write(data: string) {
				(this as unknown as { chunks: string[] }).chunks.push(data);
				return true;
			},
		} as TuiStdout & { chunks: string[] };
		const resize = makeResizeHarness();
		const ac = new AbortController();

		const run = runTui({
			repos,
			bus,
			signal: ac.signal,
			stdin,
			stdout,
			onResize: resize.subscribe,
			coalesceMs: 0,
			pollIntervalMs: 0,
		});

		await sleep(5);
		ac.abort();
		const summary = await run;

		// Frame must be exactly 24 lines (default rows) joined by \n.
		const chunks = (stdout as unknown as { chunks: string[] }).chunks;
		const frameChunk = chunks.find((c) => c.startsWith(CURSOR_HOME));
		expect(frameChunk).toBeDefined();
		const frame = frameChunk?.slice(CURSOR_HOME.length) ?? "";
		expect(frame.split("\n")).toHaveLength(24);
		expect(summary.quitReason).toBe("abort");
	});
});
