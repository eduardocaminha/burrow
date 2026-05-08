/**
 * Pure pattern-matching router for the HTTP server.
 *
 * `compilePattern` turns a `/burrows/:id/runs/:runId` template into a regex
 * plus an ordered `paramNames` list. `matchRoute` walks the route table and
 * returns the first match (with extracted params) or null.
 *
 * The router is intentionally synchronous and side-effect-free so step 1 can
 * unit-test it without spinning up Bun.serve. Dispatch (calling the handler,
 * rendering the response) lives in server.ts.
 */

import type { HttpMethod, Route, RoutePattern } from "./types.ts";

interface MatchResult {
	readonly route: Route;
	readonly params: Readonly<Record<string, string>>;
}

const PARAM_RE = /:([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Compile a path template like `/burrows/:id/events` into a regex anchored at
 * the full pathname. Trailing slashes on the pattern are NOT tolerated — the
 * server normalises request paths in `matchRoute` instead so policy lives in
 * one place.
 */
export function compilePattern(method: HttpMethod, pattern: string): RoutePattern {
	if (!pattern.startsWith("/")) {
		throw new Error(`route pattern must start with '/': ${pattern}`);
	}
	const paramNames: string[] = [];
	const regexSource = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(PARAM_RE, (_match, name: string) => {
			paramNames.push(name);
			return "([^/]+)";
		});
	return {
		method,
		pattern,
		regex: new RegExp(`^${regexSource}$`),
		paramNames,
	};
}

/**
 * Find the first route whose method+pattern matches the incoming request.
 * Trailing slashes on the request path are stripped (except for the bare
 * root `/`) so `/burrows` and `/burrows/` resolve to the same route.
 */
export function matchRoute(
	routes: readonly Route[],
	method: string,
	pathname: string,
): MatchResult | null {
	const normalised = normalisePathname(pathname);
	const upperMethod = method.toUpperCase();
	for (const route of routes) {
		if (route.method !== upperMethod) continue;
		const compiled = compileForRoute(route);
		const match = compiled.regex.exec(normalised);
		if (!match) continue;
		const params: Record<string, string> = {};
		compiled.paramNames.forEach((name, i) => {
			const value = match[i + 1];
			if (value !== undefined) params[name] = decodeURIComponent(value);
		});
		return { route, params };
	}
	return null;
}

/**
 * Returns true if any route in the table matches `pathname` for any HTTP
 * method. Used to distinguish 404 (no such resource) from 405 (resource
 * exists but the verb is wrong).
 */
export function pathExists(routes: readonly Route[], pathname: string): boolean {
	const normalised = normalisePathname(pathname);
	for (const route of routes) {
		if (compileForRoute(route).regex.test(normalised)) return true;
	}
	return false;
}

function normalisePathname(pathname: string): string {
	if (pathname.length > 1 && pathname.endsWith("/")) {
		return pathname.slice(0, -1);
	}
	return pathname;
}

const compileCache = new WeakMap<Route, RoutePattern>();

function compileForRoute(route: Route): RoutePattern {
	const cached = compileCache.get(route);
	if (cached) return cached;
	const compiled = compilePattern(route.method, route.pattern);
	compileCache.set(route, compiled);
	return compiled;
}
