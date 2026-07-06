/**
 * Unit tests for the sensitive-settings deny-list. The generic settings API
 * (GET/PUT/DELETE /api/settings/:key) must never touch these keys, even for an
 * admin — they are owned by dedicated code paths and a write could forge
 * credentials or API-key rows.
 */
import { test, expect, describe } from "bun:test";
import { isSensitiveSettingKey } from "../../routes/api/settings/deny-list";

describe("isSensitiveSettingKey", () => {
  test("blocks the API-key store rows (apikey: / apikeyhash:)", () => {
    // A generic PUT here could forge an admin-ROLE key row, bypassing the
    // mint route's canMintRole anti-escalation, or desync the hash index.
    expect(isSensitiveSettingKey("apikey:u1:8f3c")).toBe(true);
    expect(isSensitiveSettingKey("apikeyhash:deadbeefcafe")).toBe(true);
  });

  test("still blocks the pre-existing sensitive prefixes", () => {
    expect(isSensitiveSettingKey("instance:jwtSecret")).toBe(true);
    expect(isSensitiveSettingKey("provider:apiKey:openai")).toBe(true);
    expect(isSensitiveSettingKey("provider:oauth:google")).toBe(true);
  });

  test("allows ordinary keys and does not over-match near-miss prefixes", () => {
    expect(isSensitiveSettingKey("ui:theme")).toBe(false);
    // `apikeyhash:` needs its own pattern — `^apikey:` alone would NOT catch it.
    expect(isSensitiveSettingKey("apikeys:list")).toBe(false); // no colon right after "apikey"
    expect(isSensitiveSettingKey("compaction:strategy")).toBe(false);
  });
});
