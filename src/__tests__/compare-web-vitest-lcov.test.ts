import { expect, test } from "bun:test";
import { missingSelectedEvidence, parseLcovLines } from "../../scripts/compare-web-vitest-lcov";

test("requires every selected source and DA line in the full V8 receipt", () => {
  const selected = parseLcovLines([
    "SF:/tmp/old-worktree/web/src/routes/api/example/+server.ts",
    "DA:3,2",
    "DA:4,0",
    "end_of_record",
  ].join("\n"));
  const full = parseLcovLines([
    "SF:/tmp/new-worktree/web/src/routes/api/example/+server.ts",
    "DA:3,5",
    "DA:4,1",
    "DA:5,0",
    "end_of_record",
  ].join("\n"));
  expect(missingSelectedEvidence(selected, full)).toEqual([]);
});

test("rejects a missing source, DA line, or lost covered line", () => {
  const selected = parseLcovLines("SF:web/src/lib/old.ts\nDA:1,1\nDA:2,0\nend_of_record\n");
  expect(missingSelectedEvidence(selected, parseLcovLines(""))).toEqual([
    "web/src/lib/old.ts: no full-pool SF record",
  ]);
  const missingLine = parseLcovLines("SF:web/src/lib/old.ts\nDA:1,1\nend_of_record\n");
  expect(missingSelectedEvidence(selected, missingLine)).toEqual([
    "web/src/lib/old.ts:2: full-pool receipt has no DA record",
  ]);
  const lostHit = parseLcovLines("SF:web/src/lib/old.ts\nDA:1,0\nDA:2,0\nend_of_record\n");
  expect(missingSelectedEvidence(selected, lostHit)).toEqual([
    "web/src/lib/old.ts:1: selected receipt covered it but full-pool receipt did not",
  ]);
});

import { receiptProblems } from "../../scripts/compare-web-vitest-lcov";

test("rejects empty, malformed, and executable zero-DA receipts", () => {
  expect(receiptProblems("", "selected receipt")).toEqual([
    "selected receipt: no SF records",
    "selected receipt: no valid DA records",
  ]);
  expect(receiptProblems("SF:web/src/lib/mention-logic.ts\nDA:bad,1\nend_of_record\n", "selected receipt")).toEqual([
    "selected receipt: no valid DA records",
    "selected receipt: malformed DA record web/src/lib/mention-logic.ts: DA:bad,1",
    "selected receipt: executable source has no DA record: web/src/lib/mention-logic.ts",
  ]);
});
