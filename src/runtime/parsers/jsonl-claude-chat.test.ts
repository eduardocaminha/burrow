import { describe, expect, test } from "bun:test";
import { createJsonlClaudeChatParser } from "./jsonl-claude-chat.ts";

describe("createJsonlClaudeChatParser", () => {
	test("empty / whitespace lines yield no events", () => {
		const parse = createJsonlClaudeChatParser();
		expect(parse("")).toEqual([]);
		expect(parse("   ")).toEqual([]);
	});

	test("invalid JSON falls back to a text event with parseError", () => {
		const parse = createJsonlClaudeChatParser();
		const events = parse("{ not json");
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("text");
		expect(events[0]?.payload).toMatchObject({ parseError: "invalid JSON" });
	});

	test("top-level JSON arrays degrade to text events", () => {
		const parse = createJsonlClaudeChatParser();
		const events = parse('[{"type":"assistant"}]');
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("text");
	});

	test("system/init becomes state_change and captures session_id", () => {
		const parse = createJsonlClaudeChatParser();
		const line = JSON.stringify({
			type: "system",
			subtype: "init",
			session_id: "sess-abc",
			model: "claude-sonnet-4-6",
		});
		const events = parse(line);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("state_change");
		expect(events[0]?.stream).toBe("system");
		expect(events[0]?.payload).toMatchObject({ type: "system", session_id: "sess-abc" });
	});

	test("result after system/init becomes agent_end with captured session_id", () => {
		const parse = createJsonlClaudeChatParser();
		parse(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-abc" }));
		const events = parse(
			JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }),
		);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("agent_end");
		expect(events[0]?.stream).toBe("system");
		expect(events[0]?.payload).toMatchObject({
			type: "result",
			subtype: "success",
			session_id: "sess-abc",
		});
	});

	test("result without preceding system/init emits agent_end with undefined session_id", () => {
		const parse = createJsonlClaudeChatParser();
		const events = parse(
			JSON.stringify({ type: "result", subtype: "success", is_error: false }),
		);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("agent_end");
		// session_id is undefined / not in payload when never captured
		expect((events[0]?.payload as Record<string, unknown>).session_id).toBeUndefined();
	});

	test("result envelope's own session_id wins over captured one", () => {
		const parse = createJsonlClaudeChatParser();
		parse(JSON.stringify({ type: "system", subtype: "init", session_id: "from-init" }));
		const events = parse(
			JSON.stringify({ type: "result", subtype: "success", session_id: "from-result" }),
		);
		expect(events).toHaveLength(1);
		expect((events[0]?.payload as Record<string, unknown>).session_id).toBe("from-result");
	});

	test("result is never a state_change in chat mode", () => {
		const parse = createJsonlClaudeChatParser();
		const events = parse(JSON.stringify({ type: "result", subtype: "success" }));
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).not.toBe("state_change");
		expect(events[0]?.kind).toBe("agent_end");
	});

	test("rate_limit_event becomes telemetry on the system stream", () => {
		const parse = createJsonlClaudeChatParser();
		const events = parse(
			JSON.stringify({ type: "rate_limit_event", rate_limit_info: { type: "anthropic_session" } }),
		);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("telemetry");
		expect(events[0]?.stream).toBe("system");
	});

	test("assistant text + tool_use + thinking expand to one event per block", () => {
		const parse = createJsonlClaudeChatParser();
		const events = parse(
			JSON.stringify({
				type: "assistant",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "hello" },
						{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } },
						{ type: "thinking", thinking: "reasoning..." },
					],
				},
			}),
		);
		expect(events.map((e) => e.kind)).toEqual(["text", "tool_use", "thinking"]);
		expect(events[0]?.payload).toEqual({ text: "hello" });
		expect(events[2]?.payload).toEqual({ text: "reasoning..." });
	});

	test("empty thinking blocks are dropped", () => {
		const parse = createJsonlClaudeChatParser();
		const events = parse(
			JSON.stringify({
				type: "assistant",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "" },
						{ type: "text", text: "after" },
					],
				},
			}),
		);
		expect(events.map((e) => e.kind)).toEqual(["text"]);
	});

	test("user tool_result blocks emit tool_result; other user content is dropped", () => {
		const parse = createJsonlClaudeChatParser();
		const events = parse(
			JSON.stringify({
				type: "user",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "user prompt" },
						{ type: "tool_result", tool_use_id: "tu1", content: "stdout" },
					],
				},
			}),
		);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("tool_result");
	});

	test("each parser instance is independent — session_id does not leak across instances", () => {
		const parse1 = createJsonlClaudeChatParser();
		const parse2 = createJsonlClaudeChatParser();
		parse1(JSON.stringify({ type: "system", subtype: "init", session_id: "turn-1" }));
		// parse2 never saw system/init; its result should have no session_id
		const events = parse2(JSON.stringify({ type: "result", subtype: "success" }));
		expect(events).toHaveLength(1);
		expect((events[0]?.payload as Record<string, unknown>).session_id).toBeUndefined();
	});

	test("multi-turn sequence: session_id from turn 1 init propagates into its result", () => {
		// Simulate a full turn: system/init → assistant → result
		const parse = createJsonlClaudeChatParser();
		parse(JSON.stringify({ type: "system", subtype: "init", session_id: "turn-1-id" }));
		parse(
			JSON.stringify({
				type: "assistant",
				message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
			}),
		);
		const resultEvents = parse(
			JSON.stringify({ type: "result", subtype: "success", result: "hello" }),
		);
		expect(resultEvents[0]?.kind).toBe("agent_end");
		expect((resultEvents[0]?.payload as Record<string, unknown>).session_id).toBe("turn-1-id");
	});

	test("unknown envelope types fall through to text events", () => {
		const parse = createJsonlClaudeChatParser();
		const events = parse(JSON.stringify({ type: "unknown_future_type", data: 42 }));
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("text");
	});
});
