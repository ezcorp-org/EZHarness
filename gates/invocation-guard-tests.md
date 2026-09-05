# Durable invocation guard seam

- [x] Test denial before worker start, async rechecks, reverse calls, and child input separation.
  EVIDENCE: Missing pre-start guard fails /tmp/v4-guard-boundary-red.log; missing final remote policy guard fails /tmp/v4-guard-mcp-red.log. Fresh root source passes /tmp/v4-guard-final.log, including transport-ambient context replacement with captured host context.
- [x] Test exact guard forwarding through executor and MCP.
  EVIDENCE: /tmp/v4-guard-all-green.log — 80 tests, 321 assertions; final boundary additions pass /tmp/v4-guard-final.log — 65 tests, 278 assertions. Nested invocation controls committed separately in c7e5df1a.
- [x] Prove mutation transaction receives guard and rolls back refused writes using actual SQL.
  EVIDENCE: Actual SQL test captures exact transaction object, refuses guard after tentative write, proves rollback and no context leakage outside effect. Lifecycle store owner confirms supplied transaction uses FOR SHARE on durable control row. Root owns copied guard source; only tests are committed here.

Review finding: Direct host entity tools bypass storage-handler's fenced transaction. Reported to root for guard-aware transaction integration; wrapping only the handler in effect scope does not protect raw storage queries. Full backend/test types pass; root-owned browser fixture ByRoleOptions exact properties still fail web typecheck in this leaf snapshot.

Entity follow-up: /tmp/v4-entity-guard-red.log proves two SQL rows (record and index) survive a cancelled read before the fix. With root's transaction-bound entity handler, /tmp/v4-entity-guard-green.log passes 12 tests and 44 assertions: zero stored rows, exact guard/read transaction identity, no worker dispatch. /tmp/v4-entity-guard-types.log passes backend/test typecheck.
