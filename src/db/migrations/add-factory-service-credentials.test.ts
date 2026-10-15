import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { up } from "./add-factory-service-credentials";

describe("factory service credential migration", () => {
  test("creates a metadata-only credential table with scoped constraints and live index", async () => {
    const statements: string[] = [];
    const dialect = new PgDialect();
    await up({ execute: async query => { statements.push(dialect.sqlToQuery(query as SQL).sql); } });
    const ddl = statements.join("\n");
    expect(statements).toHaveLength(3);
    expect(ddl).toContain("uniq_service_accounts_id_project");
    expect(ddl).toContain("CREATE TABLE IF NOT EXISTS factory_service_credentials");
    expect(ddl).toContain("REFERENCES service_accounts(id, project_id) ON DELETE CASCADE");
    expect(ddl).toContain("REFERENCES factory_projects(tenant_id, project_id) ON DELETE RESTRICT");
    expect(ddl).toContain("jsonb_array_length(scopes) BETWEEN 1 AND 3");
    expect(ddl).toContain("expires_at <= issued_at + INTERVAL '1 hour'");
    expect(ddl).not.toContain("token");
    expect(ddl).toContain("idx_factory_service_credentials_live");
  });
});
