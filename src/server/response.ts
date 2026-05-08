/**
 * Shared response constructors. Centralising these keeps Content-Type and
 * encoding consistent across handlers — and gives the lock-test in step 7
 * a single seam to assert on (mx-1785cc wire-shape pattern).
 */

const JSON_CT = "application/json; charset=utf-8";
const NDJSON_CT = "application/x-ndjson";

export function jsonResponse(status: number, body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		status,
		...init,
		headers: mergeHeaders(init?.headers, { "content-type": JSON_CT }),
	});
}

export function ndjsonResponse(stream: ReadableStream<Uint8Array>, init?: ResponseInit): Response {
	return new Response(stream, {
		status: 200,
		...init,
		headers: mergeHeaders(init?.headers, {
			"content-type": NDJSON_CT,
			"cache-control": "no-store",
		}),
	});
}

function mergeHeaders(
	provided: HeadersInit | undefined,
	defaults: Record<string, string>,
): Headers {
	const headers = new Headers(provided);
	for (const [key, value] of Object.entries(defaults)) {
		if (!headers.has(key)) headers.set(key, value);
	}
	return headers;
}
