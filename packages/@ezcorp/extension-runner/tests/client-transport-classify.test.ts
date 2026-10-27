import { expect, test } from "bun:test";
import { RunnerError } from "../src";
import { transportFailure } from "../src/client";

/** The classification behind client-transport-errors.test.ts, for every code the end-to-end cases cannot open. */
test("only the four transport codes, and only before a response, are mapped", () => {
  const withCode = (code?: string) => Object.assign(new Error("transport"), code ? { code } : {});
  for (const code of ["ECONNRESET", "ECONNREFUSED", "EPIPE"]) {
    expect(transportFailure(withCode(code), false)).toMatchObject({ code: "runner_unavailable", retryable: true, detail: { errorClass: "Error", errorCode: code } });
    // After a response began, the failure is not "unreachable".
    expect(transportFailure(withCode(code), true)).toMatchObject({ code });
  }
  for (const other of [withCode("ENOENT"), withCode(undefined), new RunnerError("runner_timeout", "timed out")]) {
    expect(transportFailure(other, false)).toBe(other);
  }
});
