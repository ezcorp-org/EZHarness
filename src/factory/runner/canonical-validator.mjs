#!/usr/bin/env node
// The SDK owns C02 semantics.  Other runner languages call this tiny bridge
// after validating the generated wire schema they were given.
import { validateFactoryRunnerRequest, validateFactoryRunnerResult } from "@ezcorp/factory-sdk";

let envelope;
try {
  envelope = JSON.parse(await new Response(process.stdin).text());
} catch {
  process.stdout.write(JSON.stringify({ ok: false, code: "INVALID_JSON" }));
  process.exitCode = 1;
  process.exit();
}

const result = envelope?.kind === "request"
  ? validateFactoryRunnerRequest(envelope.value)
  : envelope?.kind === "result"
    ? validateFactoryRunnerResult(envelope.value)
    : { ok: false, issues: [{ code: "INVALID_KIND" }] };
process.stdout.write(JSON.stringify(result));
