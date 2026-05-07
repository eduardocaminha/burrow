/**
 * Drizzle Kit config — used by `drizzle-kit generate` to emit SQL migrations
 * from the schema. Runtime migration application happens in src/db/client.ts
 * via drizzle-orm/bun-sqlite/migrator.
 */

import type { Config } from "drizzle-kit";

export default {
	schema: "./src/db/schema.ts",
	out: "./src/db/migrations",
	dialect: "sqlite",
} satisfies Config;
