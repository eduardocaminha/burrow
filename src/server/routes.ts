/**
 * Route table for `burrow serve`. All handlers return 501 NotImplemented in
 * step 1 — steps 2 (CRUD) and 3 (streaming) of pl-5b40 fill them in. The
 * shape and ordering here is the contract: tests in step 7 lock the route
 * list against this file.
 *
 * Routes mirror `Client` (src/lib/client.ts) namespaces 1:1:
 *   §15.1 BurrowsClient   → /burrows
 *   §15.2 RunsClient      → /burrows/:burrowId/runs, /runs/:id
 *   §15.3 InboxClient     → /burrows/:burrowId/inbox, /messages/:id
 *   §15.4 EventsClient    → /burrows/:burrowId/events
 *   §15.5 AgentsClient    → /agents
 *   §26   Dashboard       → /watch
 */

import { notImplemented } from "./errors.ts";
import { jsonResponse } from "./response.ts";
import type { Route, RouteHandler } from "./types.ts";

/**
 * Scaffold the canonical route table. Step 1 wires every route to a stub that
 * returns 501; later steps swap individual entries for real handlers.
 *
 * `client` is unused today but kept in the signature so steps 2-3 can pull
 * from it without churning every callsite.
 */
export function buildRoutes(_client: unknown): Route[] {
	return ROUTE_TABLE.map((entry) => ({
		method: entry.method,
		pattern: entry.pattern,
		handler: stubHandler(entry.method, entry.pattern),
	}));
}

/**
 * Health check — exempt from auth (when step 4 lands) and always returns a
 * concrete response so a serving process can be liveness-probed without a
 * token. Wired here in step 1 since it's the one route that doesn't depend
 * on the Library API.
 */
const healthRoutes: readonly Route[] = [
	{
		method: "GET",
		pattern: "/healthz",
		handler: () => jsonResponse(200, { ok: true }),
	},
];

export function buildRoutesWithHealth(client: unknown): Route[] {
	return [...healthRoutes, ...buildRoutes(client)];
}

interface RouteEntry {
	readonly method: Route["method"];
	readonly pattern: string;
}

const ROUTE_TABLE: readonly RouteEntry[] = [
	{ method: "GET", pattern: "/burrows" },
	{ method: "POST", pattern: "/burrows" },
	{ method: "GET", pattern: "/burrows/:id" },
	{ method: "DELETE", pattern: "/burrows/:id" },
	{ method: "POST", pattern: "/burrows/:id/stop" },
	{ method: "POST", pattern: "/burrows/:id/resume" },

	{ method: "GET", pattern: "/burrows/:id/runs" },
	{ method: "POST", pattern: "/burrows/:id/runs" },
	{ method: "GET", pattern: "/runs/:id" },
	{ method: "POST", pattern: "/runs/:id/cancel" },
	{ method: "GET", pattern: "/runs/:id/stream" },

	{ method: "GET", pattern: "/burrows/:id/inbox" },
	{ method: "POST", pattern: "/burrows/:id/inbox" },
	{ method: "DELETE", pattern: "/messages/:id" },

	{ method: "GET", pattern: "/burrows/:id/events" },

	{ method: "GET", pattern: "/agents" },
	{ method: "GET", pattern: "/agents/:id" },

	{ method: "GET", pattern: "/watch" },
];

export const ROUTE_PATTERNS: readonly RouteEntry[] = ROUTE_TABLE;

function stubHandler(method: string, pattern: string): RouteHandler {
	return () => {
		const { status, envelope } = notImplemented(`${method} ${pattern}`);
		return jsonResponse(status, envelope);
	};
}
