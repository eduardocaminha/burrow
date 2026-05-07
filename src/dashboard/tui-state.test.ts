/**
 * Unit tests for the pure TUI view-state reducer (`src/dashboard/tui-state.ts`).
 * Covers every {@link KeyName} transition, edge cases at selection / scroll
 * bounds, simulated multi-key sequences, and the snapshot-resync behavior.
 */

import { describe, expect, test } from "bun:test";
import {
	DETAIL_SCROLL_PAGE_SIZE,
	initialViewState,
	type KeyName,
	reduce,
	syncToSnapshot,
	type ViewState,
} from "./tui-state.ts";
import {
	type BurrowCard,
	DASHBOARD_SNAPSHOT_VERSION,
	type DashboardSnapshot,
	type EventTailEntry,
	type RunSummary,
} from "./types.ts";

function run(burrowId: string, idSuffix: string, state: RunSummary["state"]): RunSummary {
	const isTerminal = state === "succeeded" || state === "failed" || state === "cancelled";
	return {
		id: `run_${idSuffix}`,
		burrowId,
		agentId: "claude-code",
		state,
		exitCode: state === "succeeded" ? 0 : null,
		errorMessage: null,
		queuedAt: "2026-05-07T18:59:00.000Z",
		startedAt: state === "queued" ? null : "2026-05-07T18:59:01.000Z",
		completedAt: isTerminal ? "2026-05-07T19:00:00.000Z" : null,
	};
}

function event(burrowId: string, seq: number): EventTailEntry {
	return {
		burrowId,
		runId: "run_1",
		seq,
		kind: "tool_use",
		stream: "stdout",
		ts: `2026-05-07T19:00:${String(seq).padStart(2, "0")}.000Z`,
		payload: { seq },
	};
}

function card(id: string, eventCount = 0): BurrowCard {
	const tail = Array.from({ length: eventCount }, (_, i) => event(id, i + 1));
	return {
		id,
		parentId: null,
		kind: "project",
		name: id,
		state: "active",
		projectRoot: `/work/${id}`,
		workspacePath: `/work/${id}/.burrow/workspaces/${id}`,
		branch: `burrow/${id}`,
		provider: "local",
		createdAt: "2026-05-07T18:00:00.000Z",
		updatedAt: "2026-05-07T19:00:00.000Z",
		destroyedAt: null,
		runs: [run(id, "1", "running")],
		activeRun: run(id, "1", "running"),
		eventTail: tail,
		lastEventSeq: tail.length === 0 ? null : tail.length,
	};
}

function snap(...cards: BurrowCard[]): DashboardSnapshot {
	return {
		type: "snapshot",
		version: DASHBOARD_SNAPSHOT_VERSION,
		ts: "2026-05-07T19:00:00.000Z",
		burrows: cards,
	};
}

function press(state: ViewState, snapshot: DashboardSnapshot, ...keys: KeyName[]): ViewState {
	return keys.reduce((s, k) => reduce(s, k, snapshot), state);
}

describe("initialViewState", () => {
	test("selects the first burrow when present", () => {
		const s = initialViewState(snap(card("a"), card("b")));
		expect(s).toEqual({
			mode: "list",
			selectedBurrowId: "a",
			detailScrollOffset: 0,
			quit: false,
		});
	});

	test("selection is null on an empty snapshot", () => {
		const s = initialViewState(snap());
		expect(s.selectedBurrowId).toBeNull();
		expect(s.mode).toBe("list");
	});
});

describe("reduce — quit", () => {
	test("'q' sets quit:true from list mode", () => {
		const s0 = initialViewState(snap(card("a")));
		const s1 = reduce(s0, "q", snap(card("a")));
		expect(s1.quit).toBe(true);
	});

	test("'q' sets quit:true from detail mode", () => {
		const ss = snap(card("a"));
		const s = press(initialViewState(ss), ss, "enter", "q");
		expect(s.quit).toBe(true);
		expect(s.mode).toBe("detail");
	});

	test("once quit, every subsequent keypress is a no-op (referentially equal)", () => {
		const ss = snap(card("a"), card("b"));
		const s1 = reduce(initialViewState(ss), "q", ss);
		for (const k of ["j", "k", "enter", "esc", "pageDown", "pageUp"] as const) {
			expect(reduce(s1, k, ss)).toBe(s1);
		}
	});
});

describe("reduce — selection (j/k/down/up)", () => {
	test("'j' moves selection down by one", () => {
		const ss = snap(card("a"), card("b"), card("c"));
		const s = press(initialViewState(ss), ss, "j");
		expect(s.selectedBurrowId).toBe("b");
	});

	test("'down' is an alias for 'j'", () => {
		const ss = snap(card("a"), card("b"), card("c"));
		const viaJ = press(initialViewState(ss), ss, "j");
		const viaDown = press(initialViewState(ss), ss, "down");
		expect(viaDown).toEqual(viaJ);
	});

	test("'k' moves selection up by one", () => {
		const ss = snap(card("a"), card("b"), card("c"));
		const s = press(initialViewState(ss), ss, "j", "j", "k");
		expect(s.selectedBurrowId).toBe("b");
	});

	test("'up' is an alias for 'k'", () => {
		const ss = snap(card("a"), card("b"), card("c"));
		const viaK = press(initialViewState(ss), ss, "j", "j", "k");
		const viaUp = press(initialViewState(ss), ss, "j", "j", "up");
		expect(viaUp).toEqual(viaK);
	});

	test("'j' past the last burrow clamps and is a no-op (referentially equal)", () => {
		const ss = snap(card("a"), card("b"));
		const s1 = press(initialViewState(ss), ss, "j");
		const s2 = reduce(s1, "j", ss);
		expect(s2).toBe(s1);
		expect(s2.selectedBurrowId).toBe("b");
	});

	test("'k' before the first burrow clamps and is a no-op", () => {
		const ss = snap(card("a"), card("b"));
		const s0 = initialViewState(ss);
		const s1 = reduce(s0, "k", ss);
		expect(s1).toBe(s0);
		expect(s1.selectedBurrowId).toBe("a");
	});

	test("j/k are no-ops on an empty snapshot", () => {
		const ss = snap();
		const s0 = initialViewState(ss);
		expect(reduce(s0, "j", ss)).toBe(s0);
		expect(reduce(s0, "k", ss)).toBe(s0);
	});

	test("j/k are no-ops in detail mode (use esc to leave first)", () => {
		const ss = snap(card("a"), card("b"));
		const s = press(initialViewState(ss), ss, "enter");
		expect(s.mode).toBe("detail");
		expect(reduce(s, "j", ss)).toBe(s);
		expect(reduce(s, "k", ss)).toBe(s);
	});

	test("moving selection resets detail scroll offset", () => {
		const ss = snap(card("a", 50), card("b", 50));
		const focused = press(initialViewState(ss), ss, "enter", "pageUp", "pageUp", "esc");
		expect(focused.detailScrollOffset).toBe(0);
		const moved = reduce(focused, "j", ss);
		expect(moved.selectedBurrowId).toBe("b");
		expect(moved.detailScrollOffset).toBe(0);
	});
});

describe("reduce — focus (enter/esc)", () => {
	test("'enter' transitions list → detail when a burrow is selected", () => {
		const ss = snap(card("a"));
		const s = press(initialViewState(ss), ss, "enter");
		expect(s.mode).toBe("detail");
		expect(s.selectedBurrowId).toBe("a");
	});

	test("'enter' is a no-op when selection is null", () => {
		const ss = snap();
		const s0 = initialViewState(ss);
		expect(reduce(s0, "enter", ss)).toBe(s0);
	});

	test("'enter' is a no-op when already in detail mode", () => {
		const ss = snap(card("a"));
		const s1 = press(initialViewState(ss), ss, "enter");
		expect(reduce(s1, "enter", ss)).toBe(s1);
	});

	test("'esc' transitions detail → list and resets scroll", () => {
		const ss = snap(card("a", 50));
		const scrolled = press(initialViewState(ss), ss, "enter", "pageUp");
		expect(scrolled.detailScrollOffset).toBe(DETAIL_SCROLL_PAGE_SIZE);
		const back = reduce(scrolled, "esc", ss);
		expect(back.mode).toBe("list");
		expect(back.detailScrollOffset).toBe(0);
	});

	test("'esc' is a no-op in list mode", () => {
		const ss = snap(card("a"));
		const s0 = initialViewState(ss);
		expect(reduce(s0, "esc", ss)).toBe(s0);
	});
});

describe("reduce — scroll (pageUp/pageDown)", () => {
	test("'pageUp' scrolls back by DETAIL_SCROLL_PAGE_SIZE in detail mode", () => {
		const ss = snap(card("a", 100));
		const s = press(initialViewState(ss), ss, "enter", "pageUp");
		expect(s.detailScrollOffset).toBe(DETAIL_SCROLL_PAGE_SIZE);
	});

	test("'pageDown' scrolls forward by DETAIL_SCROLL_PAGE_SIZE", () => {
		const ss = snap(card("a", 100));
		const s = press(initialViewState(ss), ss, "enter", "pageUp", "pageUp", "pageDown");
		expect(s.detailScrollOffset).toBe(DETAIL_SCROLL_PAGE_SIZE);
	});

	test("'pageDown' at offset 0 clamps and is a no-op", () => {
		const ss = snap(card("a", 100));
		const s = press(initialViewState(ss), ss, "enter");
		expect(reduce(s, "pageDown", ss)).toBe(s);
	});

	test("'pageUp' clamps to eventTail.length", () => {
		const ss = snap(card("a", 5));
		// 5 events, page size 10 — single pageUp should land at 5, not 10.
		const s = press(initialViewState(ss), ss, "enter", "pageUp");
		expect(s.detailScrollOffset).toBe(5);
		// A second pageUp is a no-op (already at top).
		expect(reduce(s, "pageUp", ss)).toBe(s);
	});

	test("scroll keys are no-ops in list mode", () => {
		const ss = snap(card("a", 100));
		const s0 = initialViewState(ss);
		expect(reduce(s0, "pageUp", ss)).toBe(s0);
		expect(reduce(s0, "pageDown", ss)).toBe(s0);
	});

	test("scrolling a burrow with empty eventTail is a no-op", () => {
		const ss = snap(card("a", 0));
		const s = press(initialViewState(ss), ss, "enter");
		expect(reduce(s, "pageUp", ss)).toBe(s);
		expect(reduce(s, "pageDown", ss)).toBe(s);
	});
});

describe("reduce — simulated key sequences", () => {
	test("vim-style navigate-then-focus-then-scroll-then-back", () => {
		const ss = snap(card("a", 50), card("b", 50), card("c", 50));
		const s = press(
			initialViewState(ss),
			ss,
			"j", // → b
			"j", // → c
			"enter", // focus c
			"pageUp",
			"pageUp",
			"pageUp",
			"esc", // back to list, reset scroll
			"k", // → b
		);
		expect(s.mode).toBe("list");
		expect(s.selectedBurrowId).toBe("b");
		expect(s.detailScrollOffset).toBe(0);
	});

	test("PgDn beyond bottom never goes negative across many presses", () => {
		const ss = snap(card("a", 30));
		const s = press(
			initialViewState(ss),
			ss,
			"enter",
			"pageDown",
			"pageDown",
			"pageDown",
			"pageDown",
		);
		expect(s.detailScrollOffset).toBe(0);
	});

	test("PgUp beyond top clamps to eventTail.length across many presses", () => {
		const ss = snap(card("a", 25));
		const s = press(
			initialViewState(ss),
			ss,
			"enter",
			"pageUp",
			"pageUp",
			"pageUp",
			"pageUp",
			"pageUp",
		);
		expect(s.detailScrollOffset).toBe(25);
	});
});

describe("syncToSnapshot", () => {
	test("returns the same state when the selected burrow is still present", () => {
		const ss1 = snap(card("a"), card("b"));
		const s = press(initialViewState(ss1), ss1, "j");
		const ss2 = snap(card("a"), card("b"), card("c"));
		expect(syncToSnapshot(s, ss2)).toBe(s);
	});

	test("re-pins selection to first burrow when current one disappears", () => {
		const ss1 = snap(card("a"), card("b"));
		const s = press(initialViewState(ss1), ss1, "j", "enter");
		expect(s.selectedBurrowId).toBe("b");
		const ss2 = snap(card("a"), card("c"));
		const s2 = syncToSnapshot(s, ss2);
		expect(s2.selectedBurrowId).toBe("a");
		expect(s2.mode).toBe("list");
		expect(s2.detailScrollOffset).toBe(0);
		expect(s2.quit).toBe(false);
	});

	test("falls back to null when the snapshot becomes empty", () => {
		const ss1 = snap(card("a"));
		const s = press(initialViewState(ss1), ss1, "enter");
		const s2 = syncToSnapshot(s, snap());
		expect(s2.selectedBurrowId).toBeNull();
		expect(s2.mode).toBe("list");
	});

	test("picks the first burrow when starting from a null selection", () => {
		const empty = snap();
		const s0 = initialViewState(empty);
		expect(s0.selectedBurrowId).toBeNull();
		const s1 = syncToSnapshot(s0, snap(card("a"), card("b")));
		expect(s1.selectedBurrowId).toBe("a");
	});

	test("clamps detail scroll when eventTail shrinks under the offset", () => {
		const ss1 = snap(card("a", 30));
		const s = press(initialViewState(ss1), ss1, "enter", "pageUp", "pageUp"); // offset 20
		expect(s.detailScrollOffset).toBe(20);
		const ss2 = snap(card("a", 5));
		const s2 = syncToSnapshot(s, ss2);
		expect(s2.detailScrollOffset).toBe(5);
		expect(s2.mode).toBe("detail");
	});

	test("preserves the quit flag across snapshot resyncs", () => {
		const ss = snap(card("a"));
		const quit = press(initialViewState(ss), ss, "q");
		const synced = syncToSnapshot(quit, snap(card("a"), card("b")));
		expect(synced.quit).toBe(true);
	});
});

describe("purity", () => {
	test("reduce never mutates its input state", () => {
		const ss = snap(card("a", 30), card("b"));
		const s0 = initialViewState(ss);
		const frozen = Object.freeze({ ...s0 });
		// Throws TypeError if reduce attempts to mutate.
		const s1 = reduce(frozen, "j", ss);
		expect(s1).not.toBe(frozen);
		expect(frozen.selectedBurrowId).toBe("a");
	});

	test("reduce never mutates the snapshot", () => {
		const ss = snap(card("a", 30));
		const beforeIds = ss.burrows.map((b) => b.id);
		const beforeTailLen = ss.burrows[0]?.eventTail.length;
		press(initialViewState(ss), ss, "enter", "pageUp", "pageUp", "esc", "j");
		expect(ss.burrows.map((b) => b.id)).toEqual(beforeIds);
		expect(ss.burrows[0]?.eventTail.length).toBe(beforeTailLen);
	});
});
