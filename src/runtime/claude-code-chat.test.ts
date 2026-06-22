import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BurrowRow, MessageRow, RunRow } from "../db/schema.ts";
import {
	CLAUDE_CODE_ENV_PASSTHROUGH,
	claudeCodeBurrowTmpdir,
} from "./claude-code.ts";
import { buildChatPrompt, claudeCodeChatRuntime } from "./claude-code-chat.ts";

function fakeBurrow(): BurrowRow {
	return {
		id: "bur_test",
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
		id: "run_test",
		burrowId: "bur_test",
		agentId: "claude-code-chat",
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
		burrowId: "bur_test",
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

// ---------------------------------------------------------------------------
// buildChatPrompt
// ---------------------------------------------------------------------------

describe("buildChatPrompt", () => {
	test("returns just the prompt when no messages", () => {
		expect(buildChatPrompt("fix the bug", [])).toBe("fix the bug");
	});

	test("returns empty string when both prompt and messages are absent", () => {
		expect(buildChatPrompt("", [])).toBe("");
	});

	test("appends messages with [STEERING] prefix after the prompt", () => {
		const result = buildChatPrompt("do X", [
			fakeMessage({ body: "stop and write tests first", priority: "high" }),
		]);
		const lines = result.split("\n");
		expect(lines[0]).toBe("do X");
		expect(lines[1]).toContain("[STEERING]");
		expect(lines[1]).toContain("priority: high");
		expect(lines[1]).toContain("stop and write tests first");
	});

	test("omits prompt line when prompt is empty but messages exist", () => {
		const result = buildChatPrompt("", [fakeMessage({ body: "urgent" })]);
		expect(result.startsWith("[STEERING]")).toBe(true);
	});

	test("encodes multiple messages one per line", () => {
		const result = buildChatPrompt("start", [
			fakeMessage({ id: "msg_a", body: "first", priority: "urgent" }),
			fakeMessage({ id: "msg_b", body: "second", priority: "low" }),
		]);
		const lines = result.split("\n");
		expect(lines).toHaveLength(3);
		expect(lines[1]).toContain("priority: urgent");
		expect(lines[2]).toContain("priority: low");
	});
});

// ---------------------------------------------------------------------------
// buildSpawnCommand
// ---------------------------------------------------------------------------

describe("claudeCodeChatRuntime.buildSpawnCommand", () => {
	test("uses -p <prompt> instead of --input-format stream-json", () => {
		const cmd = claudeCodeChatRuntime.buildSpawnCommand({
			burrow: fakeBurrow(),
			run: fakeRun(),
			prompt: "fix the bug",
			pendingMessages: [],
			envResolved: {},
			workspacePath: "/ws",
		});
		expect(cmd.argv).toContain("-p");
		expect(cmd.argv[cmd.argv.indexOf("-p") + 1]).toBe("fix the bug");
		expect(cmd.argv).not.toContain("--input-format");
	});

	test("includes --output-format stream-json --verbose --dangerously-skip-permissions", () => {
		const cmd = claudeCodeChatRuntime.buildSpawnCommand({
			burrow: fakeBurrow(),
			run: fakeRun(),
			prompt: "p",
			pendingMessages: [],
			envResolved: {},
			workspacePath: "/ws",
		});
		expect(cmd.argv).toContain("--output-format");
		expect(cmd.argv[cmd.argv.indexOf("--output-format") + 1]).toBe("stream-json");
		expect(cmd.argv).toContain("--verbose");
		expect(cmd.argv).toContain("--dangerously-skip-permissions");
	});

	test("does not include --bare (non-bare so OAuth loads)", () => {
		const cmd = claudeCodeChatRuntime.buildSpawnCommand({
			burrow: fakeBurrow(),
			run: fakeRun(),
			prompt: "p",
			pendingMessages: [],
			envResolved: {},
			workspacePath: "/ws",
		});
		expect(cmd.argv).not.toContain("--bare");
	});

	test("folds pending messages into the -p prompt text", () => {
		const cmd = claudeCodeChatRuntime.buildSpawnCommand({
			burrow: fakeBurrow(),
			run: fakeRun(),
			prompt: "do X",
			pendingMessages: [fakeMessage({ body: "urgent note", priority: "urgent" })],
			envResolved: {},
			workspacePath: "/ws",
		});
		const promptIdx = cmd.argv.indexOf("-p") + 1;
		const promptText = cmd.argv[promptIdx] ?? "";
		expect(promptText).toContain("do X");
		expect(promptText).toContain("[STEERING]");
		expect(promptText).toContain("urgent note");
	});

	test("does not use stdin (prompt is in argv, not stdin)", () => {
		const cmd = claudeCodeChatRuntime.buildSpawnCommand({
			burrow: fakeBurrow(),
			run: fakeRun(),
			prompt: "p",
			pendingMessages: [],
			envResolved: {},
			workspacePath: "/ws",
		});
		expect(cmd.stdin).toBeUndefined();
	});

	test("sets per-burrow TMPDIR to .burrow-tmp (burrow-8452)", () => {
		const cmd = claudeCodeChatRuntime.buildSpawnCommand({
			burrow: fakeBurrow(),
			run: fakeRun(),
			prompt: "p",
			pendingMessages: [],
			envResolved: {},
			workspacePath: "/host/ws",
		});
		expect(cmd.env?.TMPDIR).toBe(claudeCodeBurrowTmpdir("/host/ws"));
	});
});

// ---------------------------------------------------------------------------
// buildResumeCommand
// ---------------------------------------------------------------------------

describe("claudeCodeChatRuntime.buildResumeCommand", () => {
	test("appends --resume <session_id> when prior run has session_id", () => {
		const cmd = claudeCodeChatRuntime.buildResumeCommand?.({
			burrow: fakeBurrow(),
			run: fakeRun({ id: "run_new" }),
			priorRun: fakeRun({
				id: "run_prior",
				state: "succeeded",
				metadataJson: { session_id: "sess-abc" },
			}),
			prompt: "next turn",
			pendingMessages: [],
			envResolved: {},
			workspacePath: "/ws",
		});
		expect(cmd?.argv).toContain("--resume");
		expect(cmd?.argv.at(-1)).toBe("sess-abc");
	});

	test("falls back to a fresh spawn when no session_id in metadata", () => {
		const cmd = claudeCodeChatRuntime.buildResumeCommand?.({
			burrow: fakeBurrow(),
			run: fakeRun({ id: "run_new" }),
			priorRun: fakeRun({ id: "run_prior", state: "succeeded" }),
			prompt: "next turn",
			pendingMessages: [],
			envResolved: {},
			workspacePath: "/ws",
		});
		expect(cmd?.argv).not.toContain("--resume");
	});

	test("still uses -p <prompt> for the resumed turn", () => {
		const cmd = claudeCodeChatRuntime.buildResumeCommand?.({
			burrow: fakeBurrow(),
			run: fakeRun({ id: "run_new" }),
			priorRun: fakeRun({
				id: "run_prior",
				state: "succeeded",
				metadataJson: { session_id: "sess-x" },
			}),
			prompt: "continued",
			pendingMessages: [],
			envResolved: {},
			workspacePath: "/ws",
		});
		expect(cmd?.argv).toContain("-p");
		expect(cmd?.argv[cmd.argv.indexOf("-p") + 1]).toBe("continued");
	});

	test("resume folds pending messages into -p prompt text", () => {
		const cmd = claudeCodeChatRuntime.buildResumeCommand?.({
			burrow: fakeBurrow(),
			run: fakeRun({ id: "run_new" }),
			priorRun: fakeRun({
				id: "run_prior",
				state: "succeeded",
				metadataJson: { session_id: "sess-x" },
			}),
			prompt: "prompt",
			pendingMessages: [fakeMessage({ body: "steering", priority: "high" })],
			envResolved: {},
			workspacePath: "/ws",
		});
		const promptIdx = (cmd?.argv.indexOf("-p") ?? -1) + 1;
		const promptText = cmd?.argv[promptIdx] ?? "";
		expect(promptText).toContain("[STEERING]");
	});

	test("resume inherits per-burrow TMPDIR (burrow-8452)", () => {
		const cmd = claudeCodeChatRuntime.buildResumeCommand?.({
			burrow: fakeBurrow(),
			run: fakeRun({ id: "run_new" }),
			priorRun: fakeRun({
				id: "run_prior",
				state: "succeeded",
				metadataJson: { session_id: "sess-x" },
			}),
			prompt: "p",
			pendingMessages: [],
			envResolved: {},
			workspacePath: "/host/ws",
		});
		expect(cmd?.env?.TMPDIR).toBe(claudeCodeBurrowTmpdir("/host/ws"));
	});
});

// ---------------------------------------------------------------------------
// parseEvents + extractMetadata (session_id capture)
// ---------------------------------------------------------------------------

describe("claudeCodeChatRuntime.parseEvents / extractMetadata", () => {
	const ctx = { burrow: fakeBurrow(), run: fakeRun({ id: "run_chat_1" }) };

	test("maps result envelope to agent_end (turn boundary, not terminal)", () => {
		const line = JSON.stringify({ type: "system", subtype: "init", session_id: "s1" });
		const sysEvents = claudeCodeChatRuntime.parseEvents(line, ctx);
		expect(sysEvents[0]?.kind).toBe("state_change");

		const resultLine = JSON.stringify({ type: "result", subtype: "success", is_error: false });
		const events = claudeCodeChatRuntime.parseEvents(resultLine, ctx);
		expect(events[0]?.kind).toBe("agent_end");
		expect(events[0]?.kind).not.toBe("state_change");
	});

	test("extractMetadata returns session_id captured from agent_end payload", async () => {
		const runId = "run_extract_1";
		const parseCtx = { burrow: fakeBurrow(), run: fakeRun({ id: runId }) };

		// Feed system/init to capture session_id
		claudeCodeChatRuntime.parseEvents(
			JSON.stringify({ type: "system", subtype: "init", session_id: "sess-xyz" }),
			parseCtx,
		);
		// Feed result to trigger agent_end (session_id is in payload)
		claudeCodeChatRuntime.parseEvents(
			JSON.stringify({ type: "result", subtype: "success", is_error: false }),
			parseCtx,
		);

		const meta = await claudeCodeChatRuntime.extractMetadata?.({
			burrow: fakeBurrow(),
			run: fakeRun({ id: runId }),
			workspacePath: "/ws",
		});
		expect(meta).toEqual({ session_id: "sess-xyz" });
	});

	test("extractMetadata returns undefined when no agent_end was emitted", async () => {
		const runId = "run_extract_no_end";
		// No parseEvents calls for this run
		const meta = await claudeCodeChatRuntime.extractMetadata?.({
			burrow: fakeBurrow(),
			run: fakeRun({ id: runId }),
			workspacePath: "/ws",
		});
		expect(meta).toBeUndefined();
	});

	test("extractMetadata cleans up parser state (idempotent second call returns undefined)", async () => {
		const runId = "run_extract_cleanup";
		const parseCtx = { burrow: fakeBurrow(), run: fakeRun({ id: runId }) };

		claudeCodeChatRuntime.parseEvents(
			JSON.stringify({ type: "system", subtype: "init", session_id: "sess-cleanup" }),
			parseCtx,
		);
		claudeCodeChatRuntime.parseEvents(
			JSON.stringify({ type: "result", subtype: "success" }),
			parseCtx,
		);

		const extCtx = { burrow: fakeBurrow(), run: fakeRun({ id: runId }), workspacePath: "/ws" };
		await claudeCodeChatRuntime.extractMetadata?.(extCtx);
		// Second call: parser and session_id already cleaned up
		const second = await claudeCodeChatRuntime.extractMetadata?.(extCtx);
		expect(second).toBeUndefined();
	});

	test("parser instances are independent per run — session_id does not leak across runs", async () => {
		const run1Id = "run_iso_1";
		const run2Id = "run_iso_2";

		// Run 1 sees a session_id
		claudeCodeChatRuntime.parseEvents(
			JSON.stringify({ type: "system", subtype: "init", session_id: "sess-run1" }),
			{ burrow: fakeBurrow(), run: fakeRun({ id: run1Id }) },
		);
		claudeCodeChatRuntime.parseEvents(
			JSON.stringify({ type: "result", subtype: "success" }),
			{ burrow: fakeBurrow(), run: fakeRun({ id: run1Id }) },
		);

		// Run 2 never gets a result — should have no session_id
		const meta2 = await claudeCodeChatRuntime.extractMetadata?.({
			burrow: fakeBurrow(),
			run: fakeRun({ id: run2Id }),
			workspacePath: "/ws",
		});
		expect(meta2).toBeUndefined();

		// Run 1 should still have its session_id
		const meta1 = await claudeCodeChatRuntime.extractMetadata?.({
			burrow: fakeBurrow(),
			run: fakeRun({ id: run1Id }),
			workspacePath: "/ws",
		});
		expect(meta1).toEqual({ session_id: "sess-run1" });
	});
});

// ---------------------------------------------------------------------------
// envPassthrough + encodeInboxMessage + spawn-per-turn marker
// ---------------------------------------------------------------------------

describe("claudeCodeChatRuntime.envPassthrough", () => {
	test("forwards the same env names as the batch claude-code runtime (burrow-e9e7)", () => {
		expect(claudeCodeChatRuntime.envPassthrough).toBe(CLAUDE_CODE_ENV_PASSTHROUGH);
	});
});

describe("claudeCodeChatRuntime.encodeInboxMessage", () => {
	test("is defined (marks runtime as spawn-per-turn, SPEC §12.1)", () => {
		expect(typeof claudeCodeChatRuntime.encodeInboxMessage).toBe("function");
	});

	test("returns {stdin} (a no-op; messages are delivered via -p prompt text)", () => {
		const out = claudeCodeChatRuntime.encodeInboxMessage?.([fakeMessage()]);
		expect(out).toBeDefined();
		expect(typeof out?.stdin).toBe("string");
	});
});

// ---------------------------------------------------------------------------
// prepareWorkspace (delegates to claudeCodeRuntime)
// ---------------------------------------------------------------------------

describe("claudeCodeChatRuntime.prepareWorkspace", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "burrow-cc-chat-prep-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test("writes .claude/settings.local.json (delegated to claudeCodeRuntime)", async () => {
		await claudeCodeChatRuntime.prepareWorkspace?.({
			burrow: fakeBurrow(),
			run: fakeRun(),
			workspacePath: dir,
		});
		const { readFile } = await import("node:fs/promises");
		const body = await readFile(join(dir, ".claude/settings.local.json"), "utf8");
		expect(JSON.parse(body)).toMatchObject({ permissions: {}, hooks: {} });
	});

	test("plants .burrow-tmp/ + .gitignore (burrow-8452)", async () => {
		await claudeCodeChatRuntime.prepareWorkspace?.({
			burrow: fakeBurrow(),
			run: fakeRun(),
			workspacePath: dir,
		});
		const fs = await import("node:fs");
		const { readFile } = await import("node:fs/promises");
		const tmpDir = join(dir, ".burrow-tmp");
		expect(fs.statSync(tmpDir).isDirectory()).toBe(true);
		expect(await readFile(join(tmpDir, ".gitignore"), "utf8")).toBe("*\n");
	});
});
