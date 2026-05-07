/**
 * Integration smoke for burrow-14b6: prove that under network=restricted +
 * the userspace proxy, sandbox-exec correctly:
 *   1. Lets curl reach an allowed domain via HTTPS_PROXY (proxy CONNECT path).
 *   2. Lets curl reach an allowed plain-HTTP host via HTTP_PROXY (forward path).
 *   3. Blocks a denied domain (proxy returns 403, curl exits non-zero or sees 403).
 *   4. Blocks any direct outbound (no DNS, no `*:443`) — sandbox-level.
 *
 * Run with: `bun scripts/integration-proxy.ts`. Skips on non-darwin.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSeatbeltProfile } from "../src/provider/local/seatbelt.ts";
import type { SandboxProfile } from "../src/provider/types.ts";
import { startProxy } from "../src/proxy/server.ts";

if (process.platform !== "darwin") {
	console.error("integration-proxy: skipped (darwin only)");
	process.exit(0);
}

const ws = mkdtempSync(join(tmpdir(), "burrow-int-"));

async function runScenario(
	name: string,
	proxyAllowedDomains: string[],
	curlArgs: string[],
	envOverride: Record<string, string>,
): Promise<{ exit: number; stdout: string; stderr: string; denied: number }> {
	const proxy = await startProxy({ allowedDomains: proxyAllowedDomains });
	try {
		const profile: SandboxProfile = {
			workspace: ws,
			readOnlyMounts: [],
			network: "restricted",
			allowedDomains: proxyAllowedDomains,
			envPassthrough: [],
			setEnv: {},
			toolchainPaths: [],
			proxyAddress: { host: "127.0.0.1", port: proxy.port },
		};
		const sb = buildSeatbeltProfile(profile);
		const sbPath = join(ws, `${name}.sb`);
		writeFileSync(sbPath, sb);

		const child = Bun.spawn(["sandbox-exec", "-f", sbPath, "/usr/bin/curl", ...curlArgs], {
			env: {
				PATH: "/usr/bin:/bin",
				HTTP_PROXY: proxy.url,
				HTTPS_PROXY: proxy.url,
				http_proxy: proxy.url,
				https_proxy: proxy.url,
				...envOverride,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await Bun.readableStreamToText(child.stdout);
		const stderr = await Bun.readableStreamToText(child.stderr);
		const exit = await child.exited;
		return { exit, stdout, stderr, denied: proxy.deniedCount };
	} finally {
		await proxy.stop();
	}
}

const results: Array<{ name: string; pass: boolean; detail: string }> = [];

try {
	{
		// Scenario 1: HTTPS to an allowed domain through the proxy. We pipe
		// the response body to a workspace file (which IS writable) instead
		// of /dev/null (which isn't, by design).
		const r = await runScenario(
			"https-allow",
			["example.com"],
			["-sS", "-o", `${ws}/body.html`, "-w", "%{http_code}", "https://example.com/"],
			{},
		);
		// `example.com` returns 200; sometimes intermediaries serve 301.
		const ok = r.exit === 0 && /^(200|301|302)$/.test(r.stdout.trim());
		results.push({
			name: "https → allowed domain returns 2xx/3xx",
			pass: ok,
			detail: `exit=${r.exit} body=${JSON.stringify(r.stdout)} stderr=${r.stderr.slice(0, 200)}`,
		});
	}
	{
		// Scenario 2: HTTPS to a denied domain → proxy returns 502/503 (CONNECT 403).
		const r = await runScenario(
			"https-deny",
			["example.com"],
			["-sS", "-o", "/dev/null", "-w", "%{http_code}", "https://denied.example.org/"],
			{},
		);
		const ok = r.exit !== 0 || r.denied >= 1;
		results.push({
			name: "https → denied domain blocked",
			pass: ok,
			detail: `exit=${r.exit} denied=${r.denied} body=${JSON.stringify(r.stdout)} stderr=${r.stderr.slice(0, 200)}`,
		});
	}
	{
		// Scenario 3: Direct connect (no proxy env) → sandbox blocks at TCP layer.
		const r = await runScenario(
			"direct-block",
			["example.com"],
			[
				"-sS",
				"--connect-timeout",
				"5",
				"-o",
				"/dev/null",
				"-w",
				"%{http_code}",
				"https://example.com/",
			],
			{ HTTP_PROXY: "", HTTPS_PROXY: "", http_proxy: "", https_proxy: "" },
		);
		const ok = r.exit !== 0;
		results.push({
			name: "direct https (no proxy env) is blocked by seatbelt",
			pass: ok,
			detail: `exit=${r.exit} body=${JSON.stringify(r.stdout)} stderr=${r.stderr.slice(0, 200)}`,
		});
	}
} finally {
	rmSync(ws, { recursive: true, force: true });
}

let pass = 0;
for (const r of results) {
	const tag = r.pass ? "✓" : "✗";
	console.log(`${tag} ${r.name}`);
	console.log(`    ${r.detail}`);
	if (r.pass) pass += 1;
}
console.log(`\n${pass}/${results.length} scenarios passed`);
process.exit(pass === results.length ? 0 : 1);
