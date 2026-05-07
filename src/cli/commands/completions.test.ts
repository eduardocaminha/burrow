import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { ValidationError } from "../../core/errors.ts";
import { renderCompletions, runCompletionsCommand, SUPPORTED_SHELLS } from "./completions.ts";

function buildProgram(): Command {
	const program = new Command();
	program.name("burrow").description("test program").version("0.0.0");
	program
		.command("up")
		.description("create + start a project burrow")
		.option("--name <name>", "burrow label")
		.option("--json", "machine-readable JSON");
	const agents = program.command("agents").description("inspect registered agent runtimes");
	agents
		.command("list")
		.description("list every registered agent runtime")
		.option("--json", "machine-readable JSON");
	program.command("completions <shell>").description("emit shell completion script");
	return program;
}

describe("renderCompletions", () => {
	const program = buildProgram();

	test("emits a bash script that registers both burrow and bw", () => {
		const out = renderCompletions(program, "bash");
		expect(out).toContain("complete -F _burrow_completions burrow");
		expect(out).toContain("complete -F _burrow_completions bw");
		// Top-level command names appear; the completions command itself does not.
		expect(out).toContain("up agents");
		expect(out).not.toContain("completions)");
	});

	test("bash branch lists both subcommands and option flags", () => {
		const out = renderCompletions(program, "bash");
		expect(out).toContain("up)");
		expect(out).toContain("--name --json");
		expect(out).toContain("agents)");
		expect(out).toContain(`compgen -W "list"`);
	});

	test("emits zsh #compdef header for both binaries", () => {
		const out = renderCompletions(program, "zsh");
		expect(out.startsWith("#compdef burrow bw\n")).toBe(true);
		expect(out).toContain("compdef _burrow burrow");
		expect(out).toContain("compdef _burrow bw");
	});

	test("emits fish completions disabling file completions for both binaries", () => {
		const out = renderCompletions(program, "fish");
		expect(out).toContain("complete -c burrow -f");
		expect(out).toContain("complete -c bw -f");
		expect(out).toContain("-a up -d 'create + start a project burrow'");
		expect(out).toContain("__fish_seen_subcommand_from agents");
	});
});

describe("runCompletionsCommand", () => {
	const program = buildProgram();

	test("rejects an unknown shell with a ValidationError", () => {
		expect(() => runCompletionsCommand(program, "powershell")).toThrow(ValidationError);
	});

	test("returns a script for every supported shell", () => {
		for (const shell of SUPPORTED_SHELLS) {
			const out = runCompletionsCommand(program, shell);
			expect(out.length).toBeGreaterThan(0);
		}
	});
});
