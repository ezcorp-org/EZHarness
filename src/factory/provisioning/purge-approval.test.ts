/**
 * The provisioner side of the purge approval, over a recording client. The
 * installation side (issue) runs against a real schema in
 * `src/__tests__/helpers/factory-installation-bootstrap-suite.ts`, and the
 * verify query runs against real PostgreSQL in
 * `tests/postgres/factory-provisioning.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { factoryRejection } from "../../__tests__/helpers/factory-private-root";
import type { FactoryInstallationContext } from "./installation";
import { factoryDatabasePurgeApprovals, type FactoryPurgeApprovalClient } from "./purge-approval";

const APPROVAL = "0f8b2f7a-1c1d-4a4e-9a0b-6d1f2e3c4b5a";
const installation = { installationId: "inst-1", productDatabase: "factory_product_abc" } as FactoryInstallationContext;

/** A client that answers each query from a queue and records what it was asked. */
function client(answers: unknown[][]) {
  const queries: { text: string; values: unknown[] }[] = [];
  const urls: string[] = [];
  let closed = 0;
  const connect = (url: string): FactoryPurgeApprovalClient => {
    urls.push(url);
    const query = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push({ text: strings.join("?"), values });
      return answers.shift() ?? [];
    }) as FactoryPurgeApprovalClient;
    query.close = async () => { closed += 1; };
    return query;
  };
  return { connect, queries, urls, closed: () => closed };
}

describe("factoryDatabasePurgeApprovals.verify", () => {
  test("an approval of this installation by an active administrator returns the lowercased membership reference", async () => {
    const fake = client([[{ present: true }], [{ email: "Ada@Example.COM" }]]);
    const approval = await factoryDatabasePurgeApprovals("postgres://admin@127.0.0.1:5432/postgres", fake.connect).verify(installation, APPROVAL);
    expect(approval).toEqual({ approvedBy: "admin:ada@example.com" });
    expect(Object.isFrozen(approval)).toBe(true);
    expect(new URL(fake.urls[0]!).pathname).toBe("/factory_product_abc");
    expect(fake.queries[1]!.values).toEqual([APPROVAL, "inst-1"]);
    for (const condition of ["expires_at > now()", "u.role = 'admin'", "u.status = 'active'", "a.installation_id = ?"]) expect(fake.queries[1]!.text).toContain(condition);
    expect(fake.closed()).toBe(1);
  });

  test("a malformed approval ID is refused before any connection", async () => {
    const fake = client([]);
    for (const id of ["", "not-a-uuid", `${APPROVAL}x`, APPROVAL.toUpperCase(), `${APPROVAL}'; DROP TABLE users; --`]) {
      expect((await factoryRejection(factoryDatabasePurgeApprovals("postgres://127.0.0.1/postgres", fake.connect).verify(installation, id))).code).toBe("purge_approval_invalid");
    }
    expect(fake.urls).toEqual([]);
  });

  test("an installation that never migrated the approvals table is refused, and the connection closed", async () => {
    const fake = client([[{ present: false }]]);
    expect((await factoryRejection(factoryDatabasePurgeApprovals("postgres://127.0.0.1/postgres", fake.connect).verify(installation, APPROVAL))).code).toBe("purge_approval_invalid");
    expect(fake.queries).toHaveLength(1);
    expect(fake.closed()).toBe(1);
  });

  test("no matching row (wrong installation, expired, not an active administrator) is refused, and the connection closed", async () => {
    const fake = client([[{ present: true }], []]);
    expect((await factoryRejection(factoryDatabasePurgeApprovals("postgres://127.0.0.1/postgres", fake.connect).verify(installation, APPROVAL))).code).toBe("purge_approval_invalid");
    expect(fake.closed()).toBe(1);
  });

  test("a connection failure propagates as itself and is never read as a refusal", async () => {
    const refused = await factoryRejection(factoryDatabasePurgeApprovals("postgres://nobody:none@127.0.0.1:1/postgres").verify(installation, APPROVAL));
    expect(refused.code).not.toBe("purge_approval_invalid");
  });
});
