import { describe, expect, test } from "bun:test";
import type { BurrowRow, MessageRow, RunRow } from "../db/schema.ts";
import {
	encodePiStdin,
	PI_DEFAULT_MODEL,
	PI_ENV_PASSTHROUGH,
	PI_FORCED_ARGV,
	piRuntime,
} from "./pi.ts";

function fakeBurrow(): BurrowRow {
	return {
		id: "bur_pi",
		parentId: null,
		kind: "project",
		name: null,
		projectRoot: "/r",
		workspacePath: "/r/ws",
		branch: "main",
		provider: "local",
		providerStateJson: null,
		profileJson: {},
		state: "active",
		createdAt: new Date(0),
		updatedAt: new Date(0),
		destroyedAt: null,
	};
}

function fakeRun(extra: Partial<RunRow> = {}): RunRow {
	return {
		id: "run_pi",
		burrowId: "bur_pi",
		agentId: "pi",
		prompt: "hello",
		resumeOfRunId: null,
		state: "queued",
		exitCode: null,
		errorMessage: null,
		metadataJson: null,
		queuedAt: new Date(0),
		startedAt: null,
		completedAt: null,
		...extra,
	};
}

function fakeMessage(extra: Partial<MessageRow> = {}): MessageRow {
	return {
		id: "msg_1",
		burrowId: "bur_pi",
		fromActor: "user",
		body: "stop and write tests first",
		priority: "high",
		state: "unread",
		deliveredAtRunId: null,
		createdAt: new Date(0),
		deliveredAt: null,
		...extra,
	};
}

describe("piRuntime identity", () => {
	test("declares id, displayName, and supportsResume:false (V1 one-shot)", () => {
		expect(piRuntime.id).toBe("pi");
		expect(piRuntime.displayName).toBe("Pi");
		expect(piRuntime.supportsResume).toBe(false);
		// V1 is one-shot — no resume command surface.
		expect(piRuntime.buildResumeCommand).toBeUndefined();
	});
});

describe("piRuntime.buildSpawnCommand", () => {
	test("renders the locked argv prefix and pins the model", () => {
		const cmd = piRuntime.buildSpawnCommand({
			burrow: fakeBurrow(),
			run: fakeRun(),
			prompt: "fix the bug",
			pendingMessages: [],
			envResolved: {},
			workspacePath: "/ws",
		});
		// Argv prefix is locked — any drop of these flags re-introduces the
		// Gemini-default / interactive-extension / session-persistence
		// hazards documented in src/runtime/pi.ts.
		expect(cmd.argv.slice(0, PI_FORCED_ARGV.length)).toEqual([...PI_FORCED_ARGV]);
		const modelIdx = cmd.argv.indexOf("--model");
		expect(modelIdx).toBeGreaterThan(-1);
		expect(cmd.argv[modelIdx + 1]).toBe(PI_DEFAULT_MODEL);
	});

	test("PI_FORCED_ARGV is the exact frozen prefix (regression guard)", () => {
		// Frozen list — bumping requires verifying the new flag set against
		// pi's RPC behavior and regenerating the golden fixtures.
		expect([...PI_FORCED_ARGV]).toEqual([
			"pi",
			"--mode",
			"rpc",
			"--no-session",
			"--no-extensions",
			"--provider",
			"anthropic",
		]);
	});

	test("stdin carries a single RPC prompt command for a plain prompt", () => {
		const cmd = piRuntime.buildSpawnCommand({
			burrow: fakeBurrow(),
			run: fakeRun(),
			prompt: "fix the bug",
			pendingMessages: [],
			envResolved: {},
			workspacePath: "/ws",
		});
		expect(typeof cmd.stdin).toBe("string");
		const lines = (cmd.stdin as string).split("\n");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] ?? "")).toEqual({
			type: "prompt",
			message: "fix the bug",
		});
	});

	test("prepends each pending steering message as its own RPC prompt command", () => {
		const cmd = piRuntime.buildSpawnCommand({
			burrow: fakeBurrow(),
			run: fakeRun(),
			prompt: "fix the bug",
			pendingMessages: [fakeMessage()],
			envResolved: {},
			workspacePath: "/ws",
		});
		const lines = (cmd.stdin as string).split("\n");
		expect(lines).toHaveLength(2);
		const first = JSON.parse(lines[0] ?? "") as { message: string };
		const second = JSON.parse(lines[1] ?? "") as { message: string };
		expect(first.message).toBe("fix the bug");
		expect(second.message).toContain("[STEERING]");
		expect(second.message).toContain("priority: high");
		expect(second.message).toContain("stop and write tests first");
	});

	test("does not set custom env or cwd (sandbox owns those)", () => {
		const cmd = piRuntime.buildSpawnCommand({
			burrow: fakeBurrow(),
			run: fakeRun(),
			prompt: "p",
			pendingMessages: [],
			envResolved: {},
			workspacePath: "/ws",
		});
		expect(cmd.env).toBeUndefined();
		expect(cmd.cwd).toBeUndefined();
	});
});

describe("encodePiStdin", () => {
	test("omits the prompt line when the prompt is empty (steering-only nudge)", () => {
		const blob = encodePiStdin("", [fakeMessage()]);
		const lines = blob.split("\n");
		expect(lines).toHaveLength(1);
		const parsed = JSON.parse(lines[0] ?? "") as { type: string; message: string };
		expect(parsed.type).toBe("prompt");
		expect(parsed.message).toContain("[STEERING]");
	});

	test("returns an empty string when both prompt and messages are empty", () => {
		expect(encodePiStdin("", [])).toBe("");
	});

	test("emits one RPC line per pending steering message in order", () => {
		const blob = encodePiStdin("", [
			fakeMessage({ id: "msg_a", body: "first", priority: "urgent" }),
			fakeMessage({ id: "msg_b", body: "second", priority: "low" }),
		]);
		const lines = blob.split("\n");
		expect(lines).toHaveLength(2);
		const parsed = lines.map((l) => JSON.parse(l) as { type: string; message: string });
		expect(parsed[0]?.type).toBe("prompt");
		expect(parsed[0]?.message).toContain("priority: urgent");
		expect(parsed[0]?.message).toContain("first");
		expect(parsed[1]?.message).toContain("priority: low");
		expect(parsed[1]?.message).toContain("second");
	});
});

describe("piRuntime.envPassthrough", () => {
	test("forwards the anthropic env trio and nothing else (locked)", () => {
		// Frozen list — argv pins --provider anthropic, so forwarding
		// other-provider keys would leak host secrets into a sandbox that
		// can't authenticate against them. Bumping requires lifting the
		// provider pin too.
		expect(piRuntime.envPassthrough).toBe(PI_ENV_PASSTHROUGH);
		expect([...PI_ENV_PASSTHROUGH]).toEqual([
			"ANTHROPIC_API_KEY",
			"ANTHROPIC_AUTH_TOKEN",
			"ANTHROPIC_BASE_URL",
		]);
	});
});

describe("piRuntime.encodeInboxMessage", () => {
	test("emits one prompt RPC envelope per message tagged with priority", () => {
		const out = piRuntime.encodeInboxMessage?.([
			fakeMessage({ id: "msg_a", body: "first", priority: "urgent" }),
			fakeMessage({ id: "msg_b", body: "second", priority: "low" }),
		]);
		const lines = out?.stdin.split("\n") ?? [];
		expect(lines).toHaveLength(2);
		const parsed = lines.map((l) => JSON.parse(l) as { type: string; message: string });
		expect(parsed[0]?.type).toBe("prompt");
		expect(parsed[0]?.message).toContain("priority: urgent");
		expect(parsed[1]?.message).toContain("priority: low");
	});
});

describe("piRuntime.parseEvents", () => {
	test("delegates to parsePiEvents — RPC ack becomes state_change/system", () => {
		const events = piRuntime.parseEvents(
			JSON.stringify({ type: "response", command: "prompt", success: true }),
			{ burrow: fakeBurrow(), run: fakeRun() },
		);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("state_change");
		expect(events[0]?.stream).toBe("system");
	});
});
