import { describe, expect, test } from "bun:test";
import { createLogger } from "./logger.ts";

interface CapturedStream {
	chunks: string[];
	write(chunk: string): boolean;
}

function captureStream(): CapturedStream {
	const stream: CapturedStream = {
		chunks: [],
		write(chunk: string) {
			stream.chunks.push(chunk);
			return true;
		},
	};
	return stream;
}

describe("createLogger redaction (pl-5b40 risk #6)", () => {
	test("authorization header values are scrubbed", () => {
		const stream = captureStream();
		const logger = createLogger({ level: "info", pretty: false, destination: stream });
		logger.info({ req: { headers: { authorization: "Bearer s3cr3t" } } }, "incoming");
		const output = stream.chunks.join("");
		expect(output).not.toContain("s3cr3t");
		expect(output).toContain("[REDACTED]");
	});

	test("top-level token field is scrubbed", () => {
		const stream = captureStream();
		const logger = createLogger({ level: "info", pretty: false, destination: stream });
		logger.info({ token: "s3cr3t" }, "with-token");
		const output = stream.chunks.join("");
		expect(output).not.toContain("s3cr3t");
	});

	test("BURROW_API_TOKEN env value is scrubbed", () => {
		const stream = captureStream();
		const logger = createLogger({ level: "info", pretty: false, destination: stream });
		logger.info({ env: { BURROW_API_TOKEN: "s3cr3t" } }, "env-snapshot");
		const output = stream.chunks.join("");
		expect(output).not.toContain("s3cr3t");
	});
});
