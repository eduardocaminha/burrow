/**
 * `burrow agents` — registry inspection (SPEC §16, §15.5).
 *
 * Three subcommands:
 *   - list: every registered runtime, with display name and install status.
 *   - show <id>: detailed view of one runtime (id, supportsResume, install).
 *   - validate <file>: parse an AgentConfig (JSON) and report errors.
 *
 * Validate uses `parseAgentConfig` rather than `loadAgentConfig` so users get
 * structured errors back; `loadAgentConfig` throws on the first issue.
 */

import { readFile } from "node:fs/promises";
import { NotFoundError, ValidationError } from "../../core/errors.ts";
import type { AgentsClient } from "../../lib/client.ts";
import type { AgentRuntime, InstallCheckResult } from "../../runtime/runtime.ts";
import { type AgentConfigParseError, parseAgentConfig } from "../../schemas/agent-config.ts";

export interface AgentsListItem {
	id: string;
	displayName: string;
	supportsResume: boolean;
	install: InstallCheckResult;
}

export async function runAgentsList(client: { agents: AgentsClient }): Promise<AgentsListItem[]> {
	const runtimes = client.agents.list();
	return Promise.all(
		runtimes.map(async (rt) => ({
			id: rt.id,
			displayName: rt.displayName,
			supportsResume: rt.supportsResume,
			install: await rt.installCheck(),
		})),
	);
}

export function renderAgentsList(items: AgentsListItem[]): string {
	if (items.length === 0) return "no agents registered.";
	return items
		.map((it) => {
			const installed = it.install.installed ? "✓" : "✗";
			const version = it.install.version ? ` v${it.install.version}` : "";
			const hint = !it.install.installed && it.install.hint ? `\n    → ${it.install.hint}` : "";
			return `${installed} ${it.id}${version} — ${it.displayName}${hint}`;
		})
		.join("\n");
}

export interface AgentShowReport {
	runtime: {
		id: string;
		displayName: string;
		supportsResume: boolean;
		spawnPerTurn: boolean;
	};
	install: InstallCheckResult;
}

export async function runAgentShow(
	client: { agents: AgentsClient },
	id: string,
): Promise<AgentShowReport> {
	const runtime = client.agents.get(id);
	if (!runtime) {
		throw new NotFoundError(`agent runtime not registered: ${id}`, {
			recoveryHint: "run `burrow agents list` to see what's available",
		});
	}
	const install = await runtime.installCheck();
	return {
		runtime: runtimeSummary(runtime),
		install,
	};
}

export function renderAgentShow(report: AgentShowReport): string {
	const lines = [
		`Agent ${report.runtime.id}`,
		`  display:        ${report.runtime.displayName}`,
		`  supportsResume: ${report.runtime.supportsResume}`,
		`  spawnPerTurn:   ${report.runtime.spawnPerTurn}`,
		`  installed:      ${report.install.installed}`,
	];
	if (report.install.version) lines.push(`  version:        ${report.install.version}`);
	if (!report.install.installed && report.install.hint)
		lines.push(`  hint:           ${report.install.hint}`);
	return lines.join("\n");
}

function runtimeSummary(rt: AgentRuntime): AgentShowReport["runtime"] {
	return {
		id: rt.id,
		displayName: rt.displayName,
		supportsResume: rt.supportsResume,
		spawnPerTurn: typeof rt.encodeInboxMessage === "function",
	};
}

export interface AgentValidateOk {
	ok: true;
	id: string;
	displayName: string;
}

export interface AgentValidateError {
	ok: false;
	errors: AgentConfigParseError[];
}

export type AgentValidateResult = AgentValidateOk | AgentValidateError;

export async function runAgentValidate(file: string): Promise<AgentValidateResult> {
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch (err) {
		throw new ValidationError(
			`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new ValidationError(
			`agent config must be JSON: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	const result = parseAgentConfig(parsed);
	if (!result.ok || !result.config) return { ok: false, errors: result.errors ?? [] };
	return { ok: true, id: result.config.id, displayName: result.config.displayName };
}

export function renderAgentValidate(result: AgentValidateResult): string {
	if (result.ok) {
		return `✓ agent config valid (id=${result.id}, displayName=${result.displayName})`;
	}
	const lines = ["✗ agent config invalid:"];
	for (const e of result.errors) {
		lines.push(`  - ${e.path.join(".") || "(root)"}: ${e.message}`);
	}
	return lines.join("\n");
}
