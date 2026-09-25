/**
 * Checks what a failed pass left behind: `bun verify-diagnostics.ts <dir> <label>`.
 *
 * Writes `<label>.diagnostics-check.json` next to the record and exits non-zero
 * unless every process log exists, is non-empty, and ends with its exit line,
 * and every readiness file was carried out of the stack.
 */
import { join } from "node:path";
import { checkPassDiagnostics } from "./diagnostics";

const [dir, label] = process.argv.slice(2) as [string, string];
const check = await checkPassDiagnostics({ dir, label });
await Bun.write(join(dir, `${label}.diagnostics-check.json`), JSON.stringify(check, null, 2));
console.log(JSON.stringify({ label, ok: check.ok, problems: check.problems }));
process.exit(check.ok ? 0 : 1);
