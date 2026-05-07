/**
 * `burrow completions <shell>` — emit a static completion script for the
 * configured `Command` tree (SPEC §16.1: shell completions via
 * `burrow completions <shell>`).
 *
 * Walks the registered subcommands once and renders bash, zsh, or fish output.
 * Burrow ships two binaries (`burrow` and `bw`); each emitted script registers
 * completions for both names so users only need to source one file.
 */

import type { Command, Option } from "commander";
import { ValidationError } from "../../core/errors.ts";

export const SUPPORTED_SHELLS = ["bash", "zsh", "fish"] as const;
export type Shell = (typeof SUPPORTED_SHELLS)[number];

export const COMPLETION_BINARIES = ["burrow", "bw"] as const;

interface CommandInfo {
	name: string;
	description: string;
	options: OptionInfo[];
	subcommands: CommandInfo[];
}

interface OptionInfo {
	flags: string[];
	description: string;
}

export function isShell(raw: string): raw is Shell {
	return (SUPPORTED_SHELLS as readonly string[]).includes(raw);
}

export function renderCompletions(program: Command, shell: Shell): string {
	const tree = collectCommands(program);
	switch (shell) {
		case "bash":
			return renderBash(tree);
		case "zsh":
			return renderZsh(tree);
		case "fish":
			return renderFish(tree);
	}
}

export function runCompletionsCommand(program: Command, shell: string): string {
	if (!isShell(shell)) {
		throw new ValidationError(
			`unknown shell '${shell}' — expected one of: ${SUPPORTED_SHELLS.join(", ")}`,
			{ recoveryHint: "run `burrow completions --help` to see supported shells" },
		);
	}
	return renderCompletions(program, shell);
}

function collectCommands(program: Command): CommandInfo[] {
	const result: CommandInfo[] = [];
	for (const cmd of program.commands) {
		if (cmd.name() === "completions") continue;
		result.push(toInfo(cmd));
	}
	return result;
}

function toInfo(cmd: Command): CommandInfo {
	return {
		name: cmd.name(),
		description: cmd.description(),
		options: cmd.options.map(optionInfo),
		subcommands: cmd.commands.map(toInfo),
	};
}

function optionInfo(opt: Option): OptionInfo {
	const flags: string[] = [];
	if (opt.short) flags.push(opt.short);
	if (opt.long) flags.push(opt.long);
	if (flags.length === 0) flags.push(opt.flags);
	return { flags, description: opt.description };
}

function escapeShellSingle(raw: string): string {
	return raw.replace(/'/g, "'\\''");
}

function renderBash(cmds: CommandInfo[]): string {
	const topLevel = cmds.map((c) => c.name).join(" ");
	const branches: string[] = [];

	for (const cmd of cmds) {
		const subs = cmd.subcommands.map((s) => s.name);
		const flags = cmd.options.flatMap((o) => o.flags);
		const tokens = [...subs, ...flags];
		if (tokens.length === 0) continue;
		branches.push(
			`        ${cmd.name})\n` +
				`            COMPREPLY=( $(compgen -W "${tokens.join(" ")}" -- "$cur") )\n` +
				`            return 0\n` +
				`            ;;`,
		);
	}

	const caseBlock =
		branches.length > 0 ? `    case "\${COMP_WORDS[1]}" in\n${branches.join("\n")}\n    esac` : "";

	const body = `_burrow_completions() {
    local cur prev
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"

    if [[ \${COMP_CWORD} -eq 1 ]]; then
        COMPREPLY=( $(compgen -W "${topLevel}" -- "$cur") )
        return 0
    fi

${caseBlock}
}
`;

	const registrations = COMPLETION_BINARIES.map((bin) => `complete -F _burrow_completions ${bin}`);
	return `# bash completion for burrow / bw\n${body}\n${registrations.join("\n")}\n`;
}

function renderZsh(cmds: CommandInfo[]): string {
	const cmdLines = cmds.map((c) => `        '${c.name}:${escapeShellSingle(c.description)}'`);

	const branchBlocks: string[] = [];
	for (const cmd of cmds) {
		const parts: string[] = [];
		for (const o of cmd.options) {
			const flag = o.flags.join(",");
			parts.push(`        '(${flag})'{${flag}}'[${escapeShellSingle(o.description)}]'`);
		}
		if (cmd.subcommands.length > 0) {
			const subDescs = cmd.subcommands
				.map((s) => `            '${s.name}:${escapeShellSingle(s.description)}'`)
				.join("\n");
			parts.push(`        '1: :((\n${subDescs}\n        ))'`);
		}
		if (parts.length === 0) continue;
		branchBlocks.push(
			`    ${cmd.name})\n        _arguments -s \\\n${parts.join(" \\\n")}\n        ;;`,
		);
	}

	const branchCase =
		branchBlocks.length > 0 ? `    case "$words[1]" in\n${branchBlocks.join("\n")}\n    esac` : "";

	const fn = `_burrow() {
    local -a commands
    commands=(
${cmdLines.join("\n")}
    )

    _arguments -s \\
        '1:command:->cmd' \\
        '*::arg:->args'

    case "$state" in
    cmd)
        _describe -t commands 'burrow command' commands
        ;;
    args)
${branchCase}
        ;;
    esac
}
`;

	const registrations = COMPLETION_BINARIES.map((bin) => `compdef _burrow ${bin}`);
	return `#compdef ${COMPLETION_BINARIES.join(" ")}\n\n${fn}\n${registrations.join("\n")}\n`;
}

function renderFish(cmds: CommandInfo[]): string {
	const lines: string[] = ["# fish completions for burrow / bw"];
	const topLevelNames = cmds.map((c) => c.name);
	const seenCond = topLevelNames.map((n) => `__fish_seen_subcommand_from ${n}`).join("; or ");

	for (const bin of COMPLETION_BINARIES) {
		lines.push(`complete -c ${bin} -f`);
	}
	lines.push("");

	for (const bin of COMPLETION_BINARIES) {
		for (const cmd of cmds) {
			lines.push(
				`complete -c ${bin} -n "not ${seenCond}" -a ${cmd.name} -d '${escapeShellSingle(cmd.description)}'`,
			);
		}
	}
	lines.push("");

	for (const bin of COMPLETION_BINARIES) {
		for (const cmd of cmds) {
			for (const sub of cmd.subcommands) {
				lines.push(
					`complete -c ${bin} -n "__fish_seen_subcommand_from ${cmd.name}" -a ${sub.name} -d '${escapeShellSingle(sub.description)}'`,
				);
			}
			for (const o of cmd.options) {
				const long = o.flags.find((f) => f.startsWith("--"));
				const short = o.flags.find((f) => /^-[^-]/.test(f));
				const longBit = long ? ` -l ${long.replace(/^--/, "")}` : "";
				const shortBit = short ? ` -s ${short.replace(/^-/, "")}` : "";
				if (!longBit && !shortBit) continue;
				lines.push(
					`complete -c ${bin} -n "__fish_seen_subcommand_from ${cmd.name}"${shortBit}${longBit} -d '${escapeShellSingle(o.description)}'`,
				);
			}
		}
	}
	lines.push("");
	return lines.join("\n");
}
