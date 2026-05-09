import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../core/errors.ts";
import { RESERVED_WORKSPACE_ENTRIES, resolveWorkspaceFilePath } from "./workspace-paths.ts";

describe("resolveWorkspaceFilePath", () => {
	let workspace: string;

	beforeEach(async () => {
		workspace = await mkdtemp(join(tmpdir(), "burrow-paths-"));
	});

	afterEach(async () => {
		await rm(workspace, { recursive: true, force: true });
	});

	test("returns canonical path for plain relative file", async () => {
		const out = await resolveWorkspaceFilePath(workspace, "foo.txt");
		// realpath collapses any /var → /private/var aliasing on macOS, so we
		// compare against the realpath-d workspace prefix.
		expect(out.endsWith("/foo.txt")).toBe(true);
		expect(out.startsWith(`${await realpathOf(workspace)}/`)).toBe(true);
	});

	test("returns canonical path for nested non-existent dirs", async () => {
		const out = await resolveWorkspaceFilePath(workspace, "a/b/c.txt");
		expect(out.endsWith("/a/b/c.txt")).toBe(true);
	});

	test("collapses leading './' and intermediate '.' segments", async () => {
		const out = await resolveWorkspaceFilePath(workspace, "./a/./b.txt");
		expect(out.endsWith("/a/b.txt")).toBe(true);
	});

	test("collapses double slashes", async () => {
		const out = await resolveWorkspaceFilePath(workspace, "a//b.txt");
		expect(out.endsWith("/a/b.txt")).toBe(true);
	});

	test("rejects empty path", async () => {
		await expect(resolveWorkspaceFilePath(workspace, "")).rejects.toBeInstanceOf(ValidationError);
	});

	test("rejects path that resolves to no file (just '.')", async () => {
		await expect(resolveWorkspaceFilePath(workspace, ".")).rejects.toThrow(/resolves to no file/);
	});

	test("rejects NUL byte", async () => {
		await expect(resolveWorkspaceFilePath(workspace, "foo\0.txt")).rejects.toThrow(/NUL byte/);
	});

	test("rejects absolute path", async () => {
		await expect(resolveWorkspaceFilePath(workspace, "/etc/passwd")).rejects.toThrow(
			/must be workspace-relative/,
		);
	});

	test("rejects '..' as the only segment", async () => {
		await expect(resolveWorkspaceFilePath(workspace, "..")).rejects.toThrow(/'\.\.' traversal/);
	});

	test("rejects '..' anywhere in the path", async () => {
		await expect(resolveWorkspaceFilePath(workspace, "a/../b.txt")).rejects.toThrow(
			/'\.\.' traversal/,
		);
		await expect(resolveWorkspaceFilePath(workspace, "../escape.txt")).rejects.toThrow(
			/'\.\.' traversal/,
		);
		await expect(resolveWorkspaceFilePath(workspace, "a/b/../../c")).rejects.toThrow(
			/'\.\.' traversal/,
		);
	});

	test("rejects exact reserved entries", async () => {
		for (const reserved of RESERVED_WORKSPACE_ENTRIES) {
			await expect(resolveWorkspaceFilePath(workspace, reserved)).rejects.toThrow(/reserved/);
		}
	});

	test("rejects descendants of reserved entries", async () => {
		await expect(resolveWorkspaceFilePath(workspace, ".git/HEAD")).rejects.toThrow(/reserved/);
		await expect(resolveWorkspaceFilePath(workspace, ".git/config")).rejects.toThrow(/reserved/);
		await expect(resolveWorkspaceFilePath(workspace, ".git/objects/pack/foo")).rejects.toThrow(
			/reserved/,
		);
	});

	test("does NOT reject paths that merely share a prefix with a reserved entry", async () => {
		// .gitignore, .gitkeep, .gitconfig.burrow_old etc. are user files.
		await expect(resolveWorkspaceFilePath(workspace, ".gitignore")).resolves.toEndWith(
			"/.gitignore",
		);
		await expect(resolveWorkspaceFilePath(workspace, ".gitkeep")).resolves.toEndWith("/.gitkeep");
		await expect(resolveWorkspaceFilePath(workspace, ".gitconfig.burrow_old")).resolves.toEndWith(
			"/.gitconfig.burrow_old",
		);
	});

	test("rejects path that traverses through a symlink escaping the workspace", async () => {
		await symlink("/etc", join(workspace, "escape"));
		await expect(resolveWorkspaceFilePath(workspace, "escape/passwd")).rejects.toThrow(/escapes/);
	});

	test("rejects path that IS a symlink whose target escapes", async () => {
		await symlink("/etc/passwd", join(workspace, "leak"));
		await expect(resolveWorkspaceFilePath(workspace, "leak")).rejects.toThrow(/escapes/);
	});

	test("rejects dangling symlink whose target escapes", async () => {
		// Dangling symlinks can't be realpath'd; our manual readlink walk still
		// catches them.
		await symlink("/tmp/does-not-exist-for-burrow-test", join(workspace, "dangling"));
		await expect(resolveWorkspaceFilePath(workspace, "dangling/foo")).rejects.toThrow(/escapes/);
	});

	test("rejects relative symlink that climbs out of the workspace", async () => {
		await symlink("../../etc", join(workspace, "climb"));
		await expect(resolveWorkspaceFilePath(workspace, "climb/passwd")).rejects.toThrow(/escapes/);
	});

	test("accepts a symlink that points to another path INSIDE the workspace", async () => {
		await mkdir(join(workspace, "real"), { recursive: true });
		await writeFile(join(workspace, "real", "ok.txt"), "x");
		await symlink("real", join(workspace, "alias"));

		const out = await resolveWorkspaceFilePath(workspace, "alias/ok.txt");
		expect(out.endsWith("/real/ok.txt")).toBe(true);
		expect(out.startsWith(`${await realpathOf(workspace)}/`)).toBe(true);
	});

	test("accepts a chain of symlinks that all stay inside the workspace", async () => {
		await mkdir(join(workspace, "dest"), { recursive: true });
		await writeFile(join(workspace, "dest", "f.txt"), "x");
		await symlink("dest", join(workspace, "hop1"));
		await symlink("hop1", join(workspace, "hop2"));

		const out = await resolveWorkspaceFilePath(workspace, "hop2/f.txt");
		expect(out.endsWith("/dest/f.txt")).toBe(true);
	});

	test("rejects symlink loop with a depth cap rather than hanging", async () => {
		await symlink("loopB", join(workspace, "loopA"));
		await symlink("loopA", join(workspace, "loopB"));

		await expect(resolveWorkspaceFilePath(workspace, "loopA/x")).rejects.toThrow(
			/symlink indirections/,
		);
	});

	test("handles workspace root that is itself a symlink", async () => {
		// Mirror the macOS /var → /private/var case: pass an aliased path in,
		// and the canonical result should be on the realpath side.
		const real = await mkdtemp(join(tmpdir(), "burrow-paths-real-"));
		const alias = `${real}-alias`;
		await symlink(real, alias);
		try {
			const out = await resolveWorkspaceFilePath(alias, "sub/file.txt");
			expect(out.startsWith(`${await realpathOf(real)}/`)).toBe(true);
			expect(out.endsWith("/sub/file.txt")).toBe(true);
		} finally {
			await rm(alias, { force: true });
			await rm(real, { recursive: true, force: true });
		}
	});

	test("rejects when workspace root itself does not exist", async () => {
		const ghost = join(workspace, "ghost-root");
		await expect(resolveWorkspaceFilePath(ghost, "foo.txt")).rejects.toThrow(/not accessible/);
	});

	test("rejects when an existing target is a symlink whose final target escapes via two hops", async () => {
		const outsideDir = await mkdtemp(join(tmpdir(), "burrow-paths-out-"));
		try {
			// alias-in-ws → outsideDir
			await symlink(outsideDir, join(workspace, "out"));
			// And put a file underneath in the outside dir
			await writeFile(join(outsideDir, "secret.txt"), "x");
			await expect(resolveWorkspaceFilePath(workspace, "out/secret.txt")).rejects.toThrow(
				/escapes/,
			);
		} finally {
			await rm(outsideDir, { recursive: true, force: true });
		}
	});
});

async function realpathOf(p: string): Promise<string> {
	const { realpath } = await import("node:fs/promises");
	return realpath(p);
}
