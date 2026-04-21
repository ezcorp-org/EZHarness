/**
 * Integration tests verifying the Memory Management Team and its member agents
 * are correctly defined in the seed-marketplace data.
 *
 * These tests read the seed file as source and validate structural correctness
 * without running the actual seed script (which mutates the database).
 */
import { test, expect, describe } from "bun:test";

const seedPath = new URL("../db/seed-marketplace.ts", import.meta.url).pathname;
const seedContent = await Bun.file(seedPath).text();

describe("memory team — seed agent definitions", () => {
  test("SEED_AGENTS contains Memory Validator", () => {
    expect(seedContent).toContain('"Memory Validator"');
    expect(seedContent).toContain("memory system validator");
  });

  test("SEED_AGENTS contains Memory Organizer", () => {
    expect(seedContent).toContain('"Memory Organizer"');
    expect(seedContent).toContain("memory system organizer");
  });

  test("SEED_AGENTS contains Memory Tester", () => {
    expect(seedContent).toContain('"Memory Tester"');
    expect(seedContent).toContain("memory validation test suite");
  });

  test("all memory agents have category Productivity", () => {
    // Extract the 3 agent blocks by searching between name and closing brace
    const memAgents = ["Memory Validator", "Memory Organizer", "Memory Tester"];
    for (const name of memAgents) {
      const nameIdx = seedContent.indexOf(`"${name}"`);
      expect(nameIdx).toBeGreaterThan(-1);
      // Find the next closing brace after the name (end of agent object)
      const blockEnd = seedContent.indexOf("},", nameIdx);
      const block = seedContent.slice(nameIdx, blockEnd);
      expect(block).toContain('"Productivity"');
    }
  });

  test("all memory agents have llm capability", () => {
    const memAgents = ["Memory Validator", "Memory Organizer", "Memory Tester"];
    for (const name of memAgents) {
      const nameIdx = seedContent.indexOf(`"${name}"`);
      const blockEnd = seedContent.indexOf("},", nameIdx);
      const block = seedContent.slice(nameIdx, blockEnd);
      expect(block).toContain('"llm"');
    }
  });

  test("all memory agents have memory tag", () => {
    const memAgents = ["Memory Validator", "Memory Organizer", "Memory Tester"];
    for (const name of memAgents) {
      const nameIdx = seedContent.indexOf(`"${name}"`);
      const blockEnd = seedContent.indexOf("},", nameIdx);
      const block = seedContent.slice(nameIdx, blockEnd);
      expect(block).toContain('"memory"');
    }
  });
});

describe("memory team — seed team definition", () => {
  test("SEED_TEAMS contains Memory Management Team", () => {
    expect(seedContent).toContain('"Memory Management Team"');
  });

  test("team references all 3 member agents", () => {
    const teamIdx = seedContent.indexOf('"Memory Management Team"');
    const teamBlockEnd = seedContent.indexOf("},", teamIdx);
    const teamBlock = seedContent.slice(teamIdx, teamBlockEnd);

    expect(teamBlock).toContain('"Memory Validator"');
    expect(teamBlock).toContain('"Memory Organizer"');
    expect(teamBlock).toContain('"Memory Tester"');
  });

  test("team has memberNames array with exactly 3 members", () => {
    const teamIdx = seedContent.indexOf('"Memory Management Team"');
    const teamBlockEnd = seedContent.indexOf("},", teamIdx);
    const teamBlock = seedContent.slice(teamIdx, teamBlockEnd);

    const memberNamesMatch = teamBlock.match(/memberNames:\s*\[(.*?)\]/s);
    expect(memberNamesMatch).not.toBeNull();

    const memberNames = memberNamesMatch![1]!
      .split(",")
      .map(s => s.trim().replace(/"/g, ""))
      .filter(Boolean);

    expect(memberNames).toEqual(["Memory Validator", "Memory Organizer", "Memory Tester"]);
  });

  test("team has autoSpinUp set to false", () => {
    const teamIdx = seedContent.indexOf('"Memory Management Team"');
    const teamBlockEnd = seedContent.indexOf("},", teamIdx);
    const teamBlock = seedContent.slice(teamIdx, teamBlockEnd);
    expect(teamBlock).toContain("autoSpinUp: false");
  });

  test("team has coordination prompt describing validate-fix-test workflow", () => {
    const teamIdx = seedContent.indexOf('"Memory Management Team"');
    const teamBlockEnd = seedContent.indexOf("},", teamIdx);
    const teamBlock = seedContent.slice(teamIdx, teamBlockEnd);
    expect(teamBlock).toContain("Memory Validator");
    expect(teamBlock).toContain("Memory Organizer");
    expect(teamBlock).toContain("Memory Tester");
    expect(teamBlock).toMatch(/validate|Validator/i);
  });
});

describe("memory team — seed structural integrity", () => {
  test("member agent names in team match SEED_AGENTS entries", () => {
    const memAgentNames = ["Memory Validator", "Memory Organizer", "Memory Tester"];
    for (const name of memAgentNames) {
      // Verify the name appears in SEED_AGENTS (before the SEED_TEAMS block)
      const seedTeamsIdx = seedContent.indexOf("SEED_TEAMS");
      const agentsSection = seedContent.slice(0, seedTeamsIdx);
      expect(agentsSection).toContain(`"${name}"`);
    }
  });

  test("SEED_AGENTS total count includes memory agents", () => {
    // Count name: entries in SEED_AGENTS
    const seedTeamsIdx = seedContent.indexOf("SEED_TEAMS");
    const agentsSection = seedContent.slice(0, seedTeamsIdx);
    const nameMatches = agentsSection.match(/name:\s*"/g);
    expect(nameMatches).not.toBeNull();
    // Original 12 agents + 3 memory agents = 15
    expect(nameMatches!.length).toBeGreaterThanOrEqual(15);
  });

  test("SEED_TEAMS total count includes memory team", () => {
    const seedTeamsIdx = seedContent.indexOf("SEED_TEAMS");
    const teamsSection = seedContent.slice(seedTeamsIdx);
    const nameMatches = teamsSection.match(/name:\s*"/g);
    expect(nameMatches).not.toBeNull();
    // Original 4 teams + 1 memory team = 5
    expect(nameMatches!.length).toBeGreaterThanOrEqual(5);
  });
});

describe("seed memories — data definitions", () => {
  const VALID_CATEGORIES = new Set(["preferences", "biographical", "technical", "decisions_goals"]);
  const VALID_CONFIDENCES = new Set(["high", "medium", "low"]);

  test("SEED_MEMORIES array is defined in seed file", () => {
    expect(seedContent).toContain("SEED_MEMORIES");
  });

  test("seed memories cover all 4 categories", () => {
    for (const cat of VALID_CATEGORIES) {
      expect(seedContent).toContain(`"${cat}"`);
    }
  });

  test("seed memories use only valid category values", () => {
    // Extract category assignments from the SEED_MEMORIES block
    const memStart = seedContent.indexOf("SEED_MEMORIES");
    const memBlockEnd = seedContent.indexOf("];", memStart);
    const memBlock = seedContent.slice(memStart, memBlockEnd);

    const categoryMatches = memBlock.match(/category:\s*"([^"]+)"/g) ?? [];
    expect(categoryMatches.length).toBeGreaterThan(0);

    for (const match of categoryMatches) {
      const cat = match.match(/"([^"]+)"/)![1];
      expect(VALID_CATEGORIES.has(cat!)).toBe(true);
    }
  });

  test("seed memories use only valid confidence values", () => {
    const memStart = seedContent.indexOf("SEED_MEMORIES");
    const memBlockEnd = seedContent.indexOf("];", memStart);
    const memBlock = seedContent.slice(memStart, memBlockEnd);

    const confMatches = memBlock.match(/confidence:\s*"([^"]+)"/g) ?? [];
    expect(confMatches.length).toBeGreaterThan(0);

    for (const match of confMatches) {
      const conf = match.match(/"([^"]+)"/)![1];
      expect(VALID_CONFIDENCES.has(conf!)).toBe(true);
    }
  });

  test("seed memories have at least 10 entries", () => {
    const memStart = seedContent.indexOf("SEED_MEMORIES");
    const memBlockEnd = seedContent.indexOf("];", memStart);
    const memBlock = seedContent.slice(memStart, memBlockEnd);

    const contentMatches = memBlock.match(/content:\s*"/g) ?? [];
    expect(contentMatches.length).toBeGreaterThanOrEqual(10);
  });

  test("all seed memories have content and category", () => {
    const memStart = seedContent.indexOf("SEED_MEMORIES");
    const memBlockEnd = seedContent.indexOf("];", memStart);
    const memBlock = seedContent.slice(memStart, memBlockEnd);

    const contentCount = (memBlock.match(/content:\s*"/g) ?? []).length;
    const categoryCount = (memBlock.match(/category:\s*"/g) ?? []).length;
    expect(contentCount).toBe(categoryCount);
  });

  test("seed creates audit log entries for each memory", () => {
    expect(seedContent).toContain("memoryAuditLog");
    expect(seedContent).toContain("Seeded for development/testing");
  });

  test("seed is idempotent — skips if memories already exist", () => {
    expect(seedContent).toContain("Memories already exist, skipping");
  });
});
