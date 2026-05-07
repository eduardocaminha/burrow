/**
 * `burrow agents add <id...>` — append `[[agents]]` stanzas to an existing
 * `burrow.toml` (SPEC §17, §12.3).
 *
 * Built-ins are already auto-registered in the runtime registry, but a
 * `[[agents]]` entry in `burrow.toml` makes the choice explicit (and is the
 * place to patch built-in defaults — settings template, prompt delivery, etc).
 *
 * Implementation notes:
 *   - smol-toml is parse-only, so we render the stanza as text and append it.
 *     We then re-parse the whole file via `parseBurrowTomlOrThrow` to verify
 *     we didn't produce something invalid (defensive belt-and-suspenders).
 *   - The result is *idempotent*: repeated calls with the same id no-op
 *     after the first (returns `{ added: false }`) so users can safely re-run.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BURROW_TOML_FILENAME, loadBurrowToml } from "../../config/burrow-toml-loader.ts";
import { NotFoundError, ValidationError } from "../../core/errors.ts";
import { knownBuiltInIds, resolveAgentAlias } from "../../runtime/aliases.ts";
import { parseBurrowTomlOrThrow } from "../../schemas/burrow-toml.ts";

export interface AgentsAddInput {
	projectRoot?: string;
	tokens: string[];
}

export interface AgentsAddPerToken {
	token: string;
	canonicalId: string;
	added: boolean;
	reason?: string;
}

export interface AgentsAddResult {
	source: string;
	outcomes: AgentsAddPerToken[];
}

export async function runAgentsAdd(input: AgentsAddInput): Promise<AgentsAddResult> {
	const projectRoot = resolve(input.projectRoot ?? process.cwd());
	const source = join(projectRoot, BURROW_TOML_FILENAME);

	if (input.tokens.length === 0) {
		throw new ValidationError("expected at least one agent id (e.g. `bw agents add claude`)", {
			recoveryHint: `known built-ins: ${knownBuiltInIds().join(", ")}`,
		});
	}

	// Resolve aliases up front so we error before mutating anything.
	const resolved: { token: string; canonicalId: string }[] = [];
	for (const token of input.tokens) {
		const canonical = resolveAgentAlias(token);
		if (!canonical) {
			throw new ValidationError(`unknown agent: '${token}'`, {
				recoveryHint: `known built-ins: ${knownBuiltInIds().join(", ")}`,
			});
		}
		resolved.push({ token, canonicalId: canonical });
	}

	const loaded = await loadBurrowToml(projectRoot);
	if (loaded === null) {
		throw new NotFoundError(`${source} not found`, {
			recoveryHint:
				"run `burrow init` first, or `burrow init <agent>` to scaffold with the agent baked in",
		});
	}

	const existingIds = new Set((loaded.config.agents ?? []).map((a) => a.id));
	const raw = await readFile(source, "utf8");
	let mutated = raw.endsWith("\n") ? raw : `${raw}\n`;
	const outcomes: AgentsAddPerToken[] = [];

	for (const { token, canonicalId } of resolved) {
		if (existingIds.has(canonicalId)) {
			outcomes.push({
				token,
				canonicalId,
				added: false,
				reason: "already declared in burrow.toml",
			});
			continue;
		}
		mutated += `\n${renderAgentStanza(canonicalId)}`;
		existingIds.add(canonicalId);
		outcomes.push({ token, canonicalId, added: true });
	}

	if (outcomes.some((o) => o.added)) {
		// Validate the final file before writing — better to catch a bad
		// merge than to leave the user with a broken burrow.toml.
		parseBurrowTomlOrThrow(mutated, source);
		await writeFile(source, mutated, "utf8");
	}

	return { source, outcomes };
}

/**
 * Render an `[[agents]]` stanza for a built-in id. Built-ins only need the
 * `id` field — the runtime registry already supplies a working default — but
 * we include a comment hinting at the override knobs so users discover them.
 */
export function renderAgentStanza(canonicalId: string): string {
	const known = knownBuiltInIds();
	if (!known.includes(canonicalId)) {
		// For non-built-ins (declarative AgentConfig) the user has to fill in
		// command/args themselves, so we render a skeleton.
		return [
			`[[agents]]`,
			`id = "${canonicalId}"`,
			`# displayName = "Custom"`,
			`# command = "./scripts/agent.sh"`,
			`# args = ["--prompt", "{{prompt}}"]`,
			`# outputFormat = "raw-text"`,
			`# promptDelivery = "arg"`,
			``,
		].join("\n");
	}
	return [
		`[[agents]]`,
		`id = "${canonicalId}"`,
		`# Built-in runtime — registered automatically. Patch settings here.`,
		``,
	].join("\n");
}

export function renderAgentsAddResult(result: AgentsAddResult): string {
	const lines = [`burrow agents add → ${result.source}`];
	for (const o of result.outcomes) {
		const tokenSuffix = o.token === o.canonicalId ? "" : ` (alias for ${o.token})`;
		if (o.added) {
			lines.push(`  ✓ added [[agents]] id = "${o.canonicalId}"${tokenSuffix}`);
		} else {
			lines.push(`  - ${o.canonicalId}${tokenSuffix} — ${o.reason ?? "unchanged"}`);
		}
	}
	return lines.join("\n");
}
