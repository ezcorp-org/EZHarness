// @ts-check
import { invokeScannerTool } from "./bridge.js";

/** @param {string} cert @param {{fresh?:boolean}} [opts] @returns {Promise<import("./format.js").CardRecord>} */
export async function lookupCard(cert, opts = {}) {
  const record = await invokeScannerTool("lookup_card", { cert, fresh: opts.fresh === true });
  if (typeof record?.cert !== "string" || !Array.isArray(record?.grades)) throw new Error("Lookup returned an unexpected shape.");
  return record;
}
