import { getCriticalBundledExtensions } from "../extensions/bundled";
import { getExtensionByName } from "../db/queries/extensions";
import { logger } from "../logger";
import { consequenceFor } from "../extensions/critical-consequence";

const log = logger.child("startup/assert-critical-extensions");

export interface CriticalAssertionResult {
  checked: string[];
  violations: string[];
  remediated: string[];
  unremediated: string[];
  userDisabled: string[];
}

export async function assertCriticalExtensions(): Promise<CriticalAssertionResult> {
  const result: CriticalAssertionResult = { checked: [], violations: [], remediated: [], unremediated: [], userDisabled: [] };
  for (const entry of getCriticalBundledExtensions()) {
    result.checked.push(entry.name);
    try {
      const extension = await getExtensionByName(entry.name);
      if (extension?.enabled && extension.source === "release-v4") continue;
      if (extension?.disabledByUser) result.userDisabled.push(entry.name);
      else {
        result.violations.push(entry.name);
        result.unremediated.push(entry.name);
      }
      const reason = extension?.disabledByUser ? "disabled by the user" : "awaits a verified, human-approved release";
      log.warn(`Critical extension ${entry.name} ${reason}: ${consequenceFor(entry.name)}`, { name: entry.name });
    } catch (error) {
      result.violations.push(entry.name);
      result.unremediated.push(entry.name);
      log.error("Critical extension status unavailable", { name: entry.name, error: String(error) });
    }
  }
  return result;
}
