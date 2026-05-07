/**
 * Repository for the `meta` key/value table — schema_version, app_version,
 * install_id, etc. Drizzle-kit owns the migration journal separately, so this
 * is a free-form bag for runtime-managed values.
 */

import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../client.ts";
import { meta } from "../schema.ts";

export class MetaRepo {
	constructor(private readonly db: DrizzleDb) {}

	get(key: string): string | null {
		const row = this.db.select().from(meta).where(eq(meta.key, key)).get();
		return row?.value ?? null;
	}

	set(key: string, value: string): void {
		this.db
			.insert(meta)
			.values({ key, value })
			.onConflictDoUpdate({ target: meta.key, set: { value } })
			.run();
	}

	delete(key: string): void {
		this.db.delete(meta).where(eq(meta.key, key)).run();
	}

	all(): Record<string, string> {
		const rows = this.db.select().from(meta).all();
		const out: Record<string, string> = {};
		for (const r of rows) out[r.key] = r.value;
		return out;
	}
}
