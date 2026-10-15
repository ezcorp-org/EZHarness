import { describe, expect, test } from "bun:test";
import { ERROR_CHAIN_MAX_LINKS, errorChain, isDriverStatementDesync } from "./error-chain";

/** The shape Bun.sql's PostgresError takes behind a DrizzleQueryError (W09f field log). */
function bunDriverError(): Error {
  const cause = Object.assign(new Error('bind message supplies 2 parameters, but prepared statement "Pselect $5" requires 1'), {
    code: "ERR_POSTGRES_SERVER_ERROR",
    errno: "08P01",
    routine: "exec_bind_message",
    severity: "ERROR",
  });
  return new Error("Failed query: SELECT audit.project_id FROM factory_audit_batches AS audit", { cause });
}

describe("errorChain", () => {
  test("names the server's failure behind a driver wrapper, in order", () => {
    expect(errorChain(bunDriverError())).toEqual([
      { message: "Failed query: SELECT audit.project_id FROM factory_audit_batches AS audit" },
      {
        message: 'bind message supplies 2 parameters, but prepared statement "Pselect $5" requires 1',
        code: "ERR_POSTGRES_SERVER_ERROR",
        errno: "08P01",
        routine: "exec_bind_message",
        severity: "ERROR",
        statement: "Pselect $5",
      },
    ]);
  });

  test("names a driver statement whose name carries quotes", () => {
    const [link] = errorChain(new Error('bind message supplies 2 parameters, but prepared statement "Pselect "id", "managed_by_extension_id", $5" requires 1'));
    expect(link!.statement).toBe('Pselect "id", "managed_by_extension_id", $5');
    expect(errorChain(new Error("no statement here"))[0]!.statement).toBeUndefined();
  });

  test("normalizes facts to strings and skips absent or null ones", () => {
    expect(errorChain({ message: "unique", code: 23505, errno: null, routine: undefined })).toEqual([{ message: "unique", code: "23505" }]);
  });

  test("describes a value that is not an error object", () => {
    expect(errorChain("plain failure")).toEqual([{ message: "plain failure" }]);
    expect(errorChain({ code: "XX000" })).toEqual([{ message: "[object Object]", code: "XX000" }]);
    expect(errorChain(new Error("outer", { cause: 42 }))).toEqual([{ message: "outer" }, { message: "42" }]);
  });

  test("has nothing to say about an absent error", () => {
    expect(errorChain(undefined)).toEqual([]);
    expect(errorChain(null)).toEqual([]);
  });

  test("stops at a cause cycle instead of looping", () => {
    const first = new Error("first");
    const second = new Error("second", { cause: first });
    (first as { cause?: unknown }).cause = second;
    expect(errorChain(first).map((link) => link.message)).toEqual(["first", "second"]);
  });

  test("stops after the link limit on a deep chain", () => {
    let error = new Error("depth-0");
    for (let depth = 1; depth < ERROR_CHAIN_MAX_LINKS + 5; depth++) error = new Error(`depth-${depth}`, { cause: error });
    const chain = errorChain(error);
    expect(chain).toHaveLength(ERROR_CHAIN_MAX_LINKS);
    expect(chain[0]!.message).toBe(`depth-${ERROR_CHAIN_MAX_LINKS + 4}`);
  });
});

describe("isDriverStatementDesync", () => {
  test("recognises the statement-bookkeeping states on the error or any cause", () => {
    expect(isDriverStatementDesync(bunDriverError())).toBe(true);
    expect(isDriverStatementDesync(new Error("wrapped", { cause: { message: "gone", errno: "26000" } }))).toBe(true);
    expect(isDriverStatementDesync({ message: "exists", code: "42P05" })).toBe(true);
  });

  test("does not treat ordinary query failures as a desync", () => {
    expect(isDriverStatementDesync(new Error("wrapped", { cause: { message: "duplicate key", errno: "23505" } }))).toBe(false);
    expect(isDriverStatementDesync(new Error("Connection closed"))).toBe(false);
    expect(isDriverStatementDesync(undefined)).toBe(false);
  });
});
