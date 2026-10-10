import { expect, test } from "bun:test";
import { ApprovalContextError, approvalContextDigest, assertApprovalUsable, canonicalApprovalContext, consumeApproval } from "./approval-context";

const context = { subjectId: "release", subjectDigest: "a".repeat(64), principalId: "human", scope: "project", grants: ["write", "read", "write"], expectedGeneration: 2, expiresAtMs: 100 } as const;

test("canonical approval contexts bind sorted grants and all revalidation facts", () => {
  expect(canonicalApprovalContext(context).grants).toEqual(["read", "write"]);
  expect(approvalContextDigest(context)).toBe(approvalContextDigest({ ...context, grants: ["read", "write"] }));
  expect(() => assertApprovalUsable("approved", context, { subjectDigest: context.subjectDigest, principalId: "human", scope: "project", expectedGeneration: 2 }, 99, true)).not.toThrow();
  for (const current of [{ subjectDigest: "b".repeat(64), principalId: "human", scope: "project", expectedGeneration: 2 }, { subjectDigest: context.subjectDigest, principalId: "other", scope: "project", expectedGeneration: 2 }, { subjectDigest: context.subjectDigest, principalId: "human", scope: "other", expectedGeneration: 2 }, { subjectDigest: context.subjectDigest, principalId: "human", scope: "project", expectedGeneration: 3 }]) expect(() => assertApprovalUsable("approved", context, current, 99, true)).toThrow(ApprovalContextError);
  expect(() => assertApprovalUsable("pending", context, { subjectDigest: context.subjectDigest, principalId: "human", scope: "project", expectedGeneration: 2 }, 100, false)).toThrow("approval_stale");
});

test("invalid or non-approved contexts cannot become consumed", () => {
  expect(() => canonicalApprovalContext({ ...context, subjectId: "", grants: [] })).toThrow("approval_context_invalid");
  expect(consumeApproval("approved")).toBe("consumed");
  for (const status of ["pending", "rejected", "consumed", "revoked"] as const) expect(() => consumeApproval(status)).toThrow("approval_not_consumable");
});
