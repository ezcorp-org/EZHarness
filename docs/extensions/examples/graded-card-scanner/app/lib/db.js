// @ts-check
import { invokeScannerTool } from "./bridge.js";

/**
 * @typedef {{
 * cert:string,status:"pending"|"done"|"error",error?:string,
 * record:import("./format.js").CardRecord|null,scans:string[],savedAt:string,updatedAt:string
 * }} SavedCard
 */

/** @param {SavedCard} card @returns {Promise<void>} */
export async function putCard(card) {
  await invokeScannerTool("scanner_saved_upsert", { card });
}

/** @param {string} cert @returns {Promise<SavedCard|undefined>} */
export async function getCard(cert) {
  return (await invokeScannerTool("scanner_saved_get", { cert })) ?? undefined;
}

/** @returns {Promise<SavedCard[]>} */
export async function listCards() {
  /** @type {SavedCard[]} */
  const rows = [];
  /** @type {string|undefined} */
  let cursor;
  do {
    const page = await invokeScannerTool("scanner_saved_list", cursor ? { cursor } : {});
    if (!Array.isArray(page?.cards) || (page.nextCursor !== null && (typeof page.nextCursor !== "string" || (cursor && page.nextCursor <= cursor)))) throw new Error("Invalid saved-card page.");
    rows.push(...page.cards);
    if (rows.length > 500) throw new Error("Saved-card list exceeds its limit.");
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return rows.sort((first, second) => second.updatedAt.localeCompare(first.updatedAt));
}

/** @param {string} cert @returns {Promise<void>} */
export async function deleteCard(cert) { await invokeScannerTool("scanner_saved_delete", { cert }); }

/** @returns {Promise<void>} */
export async function clearCards() { await invokeScannerTool("scanner_saved_clear", {}); }
