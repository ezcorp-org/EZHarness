import { compileValueSchema } from "@ezcorp/sdk/v4";
import { toolResult, type Storage, type ToolHandler } from "@ezcorp/sdk/runtime";

const text = { type: "string", maxLength: 2048 };
const amount = { type: ["number", "null"], minimum: 0 };
const stamp = { type: "object", additionalProperties: false, required: ["source", "fetchedAt"], properties: { source: text, fetchedAt: text } };
export const savedCardSchema = {
  type: "object", additionalProperties: false,
  required: ["cert", "status", "record", "scans", "savedAt", "updatedAt"],
  properties: {
    cert: { type: "string", pattern: "^[0-9]{5,10}$" },
    status: { type: "string", enum: ["pending", "done", "error"] },
    error: text,
    record: { anyOf: [{ type: "null" }, {
      type: "object", additionalProperties: false, required: ["cert", "identity", "grades", "sources"],
      properties: {
        cert: { type: "string", pattern: "^[0-9]{5,10}$" },
        identity: { type: "object", additionalProperties: false, required: ["subject", "year", "set", "cardNo", "variety", "grade"], properties: { subject: text, year: text, set: text, cardNo: text, variety: text, grade: text } },
        grades: { type: "array", maxItems: 40, items: { type: "object", additionalProperties: false, required: ["grade", "pop", "price"], properties: { grade: text, pop: amount, price: amount } } },
        sources: { type: "object", additionalProperties: false, properties: { identity: stamp, pop: stamp, price: stamp } },
      },
    }] },
    scans: { type: "array", minItems: 1, maxItems: 1000, items: { type: "string", format: "date-time" } },
    savedAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
};
const validateCard = compileValueSchema(savedCardSchema, 16384);
const prefix = "scanner-card:";
const certSchema = { type: "object", additionalProperties: false, required: ["cert"], properties: { cert: savedCardSchema.properties.cert } };
export const savedCardTools = [
  { name: "scanner_saved_list", description: "List the calling user's saved scanner cards in bounded pages.", inputSchema: { type: "object", additionalProperties: false, properties: { cursor: savedCardSchema.properties.cert } } },
  { name: "scanner_saved_get", description: "Read one saved scanner card belonging to the calling user.", inputSchema: certSchema },
  { name: "scanner_saved_upsert", description: "Save a scanner card in the calling user's private list.", inputSchema: { type: "object", additionalProperties: false, required: ["card"], properties: { card: savedCardSchema } } },
  { name: "scanner_saved_delete", description: "Delete one card from the calling user's saved scanner list.", inputSchema: certSchema },
  { name: "scanner_saved_clear", description: "Clear only the calling user's saved scanner cards.", inputSchema: { type: "object", additionalProperties: false, properties: {} } },
];

export function createSavedCardTools(storage: Pick<Storage, "get" | "set" | "delete" | "list" | "batch">): Record<string, ToolHandler> {
  const keys = async () => (await storage.list({ prefix, limit: 1000 })).keys.filter(key => /^scanner-card:[0-9]{5,10}$/.test(key)).sort();
  const handlers: Record<string, (input: Record<string, unknown>) => Promise<unknown>> = {
    scanner_saved_list: async input => {
      const remaining = (await keys()).filter(key => !input.cursor || key > prefix + String(input.cursor));
      const page = remaining.slice(0, 25);
      const cards: unknown[] = [];
      for (const key of page) {
        const row = await storage.get(key);
        if (row.exists) { validateCard(row.value); cards.push(row.value); }
      }
      return { cards, nextCursor: remaining.length > page.length ? page.at(-1)!.slice(prefix.length) : null };
    },
    scanner_saved_get: async input => {
      const row = await storage.get(prefix + input.cert);
      if (row.exists) validateCard(row.value);
      return row.exists ? row.value : null;
    },
    scanner_saved_upsert: async input => {
      validateCard(input.card);
      const card = input.card as { cert: string; record: { cert: string } | null };
      if (card.record && card.record.cert !== card.cert) throw new Error("Saved card certificate does not match its record.");
      const key = prefix + card.cert;
      if (!(await storage.get(key)).exists && (await keys()).length >= 500) throw new Error("Saved card limit reached. Delete a card before adding another.");
      await storage.set(key, card);
      return { saved: true };
    },
    scanner_saved_delete: async input => storage.delete(prefix + input.cert),
    scanner_saved_clear: async () => {
      const cards = await keys();
      for (let offset = 0; offset < cards.length; offset += 50) await storage.batch(cards.slice(offset, offset + 50).map(key => ({ action: "delete" as const, key })));
      return { deleted: cards.length };
    },
  };
  return Object.fromEntries(savedCardTools.map(definition => {
    const validate = compileValueSchema(definition.inputSchema);
    return [definition.name, async (input: Record<string, unknown>) => { validate(input); return toolResult(JSON.stringify(await handlers[definition.name]!(input))); }];
  }));
}
