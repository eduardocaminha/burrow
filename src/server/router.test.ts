import { describe, expect, test } from "bun:test";
import { jsonResponse } from "./response.ts";
import { compilePattern, matchRoute, pathExists } from "./router.ts";
import type { Route } from "./types.ts";

const noopHandler = () => jsonResponse(200, {});

function route(method: Route["method"], pattern: string): Route {
	return { method, pattern, handler: noopHandler };
}

describe("compilePattern", () => {
	test("captures named params in order", () => {
		const compiled = compilePattern("GET", "/burrows/:id/runs/:runId");
		expect(compiled.paramNames).toEqual(["id", "runId"]);
		const match = compiled.regex.exec("/burrows/bur_abc/runs/run_42");
		expect(match?.[1]).toBe("bur_abc");
		expect(match?.[2]).toBe("run_42");
	});

	test("anchors at the full pathname", () => {
		const compiled = compilePattern("GET", "/burrows/:id");
		expect(compiled.regex.exec("/burrows/bur_a/extra")).toBeNull();
		expect(compiled.regex.exec("/before/burrows/bur_a")).toBeNull();
	});

	test("escapes regex metacharacters in literal segments", () => {
		const compiled = compilePattern("GET", "/burrows.json");
		expect(compiled.regex.exec("/burrows.json")).not.toBeNull();
		expect(compiled.regex.exec("/burrowsXjson")).toBeNull();
	});

	test("rejects patterns that don't start with /", () => {
		expect(() => compilePattern("GET", "burrows")).toThrow();
	});
});

describe("matchRoute", () => {
	const routes: Route[] = [
		route("GET", "/burrows"),
		route("POST", "/burrows"),
		route("GET", "/burrows/:id"),
		route("GET", "/burrows/:id/runs"),
		route("DELETE", "/messages/:id"),
	];

	test("returns first matching method+pattern", () => {
		const result = matchRoute(routes, "GET", "/burrows/bur_42");
		expect(result?.route.pattern).toBe("/burrows/:id");
		expect(result?.params).toEqual({ id: "bur_42" });
	});

	test("uppercases the method before comparing", () => {
		const result = matchRoute(routes, "get", "/burrows");
		expect(result?.route.pattern).toBe("/burrows");
	});

	test("strips a trailing slash", () => {
		const result = matchRoute(routes, "GET", "/burrows/bur_42/");
		expect(result?.route.pattern).toBe("/burrows/:id");
	});

	test("preserves the bare root", () => {
		const rootRoute = route("GET", "/");
		const withRoot: Route[] = [rootRoute];
		expect(matchRoute(withRoot, "GET", "/")?.route.pattern).toBe("/");
	});

	test("decodes percent-escaped param values", () => {
		const result = matchRoute(routes, "DELETE", "/messages/msg%2F1");
		expect(result?.params.id).toBe("msg/1");
	});

	test("returns null when path is unknown", () => {
		expect(matchRoute(routes, "GET", "/nope")).toBeNull();
	});

	test("returns null when method is wrong even if path matches", () => {
		expect(matchRoute(routes, "PUT", "/burrows")).toBeNull();
	});
});

describe("pathExists", () => {
	const routes: Route[] = [
		route("GET", "/burrows"),
		route("POST", "/burrows"),
		route("GET", "/burrows/:id"),
	];

	test("true when any method matches the path", () => {
		expect(pathExists(routes, "/burrows")).toBe(true);
		expect(pathExists(routes, "/burrows/bur_1")).toBe(true);
	});

	test("false when no route matches", () => {
		expect(pathExists(routes, "/nope")).toBe(false);
	});
});
