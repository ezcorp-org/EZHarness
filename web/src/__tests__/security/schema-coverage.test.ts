import { test, expect, describe } from "bun:test";
import { setupSchema } from "../../routes/api/auth/setup/schema";
import { createInviteSchema } from "../../routes/api/auth/invite/schema";
import { createConversationSchema, updateConversationSchema } from "../../routes/api/conversations/schema";
import { runAgentSchema } from "../../routes/api/agents/[name]/run/schema";
import { generateAgentConfigSchema } from "../../routes/api/agent-configs/generate/schema";
import { importManifestSchema } from "../../routes/api/marketplace/import/schema";
import { uploadKBFileSchema } from "../../routes/api/knowledge-base/schema";
import { searchMemoriesQuerySchema } from "../../routes/api/memories/schema";
import { createApiKeySchema, deleteApiKeySchema } from "../../routes/api/settings/developer/schema";

// These tests cover schemas NOT tested in validation-routes.test.ts

describe("setupSchema", () => {
  test("accepts valid setup input", () => {
    expect(setupSchema.safeParse({
      name: "Admin", email: "admin@test.com", password: "Secure123",
    }).success).toBe(true);
  });

  test("rejects empty name", () => {
    expect(setupSchema.safeParse({
      name: "", email: "admin@test.com", password: "Secure123",
    }).success).toBe(false);
  });

  test("rejects short password", () => {
    expect(setupSchema.safeParse({
      name: "Admin", email: "admin@test.com", password: "short",
    }).success).toBe(false);
  });

  test("rejects invalid email", () => {
    expect(setupSchema.safeParse({
      name: "Admin", email: "not-email", password: "secure123",
    }).success).toBe(false);
  });

  test("rejects password over 256 chars", () => {
    expect(setupSchema.safeParse({
      name: "Admin", email: "a@b.com", password: "x".repeat(257),
    }).success).toBe(false);
  });
});

describe("createInviteSchema", () => {
  test("accepts valid invite", () => {
    expect(createInviteSchema.safeParse({ email: "user@test.com" }).success).toBe(true);
  });

  test("defaults role to member", () => {
    const result = createInviteSchema.safeParse({ email: "user@test.com" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.role).toBe("member");
  });

  test("accepts admin role", () => {
    expect(createInviteSchema.safeParse({ email: "a@b.com", role: "admin" }).success).toBe(true);
  });

  test("rejects invalid role", () => {
    expect(createInviteSchema.safeParse({ email: "a@b.com", role: "superuser" }).success).toBe(false);
  });

  test("rejects invalid email", () => {
    expect(createInviteSchema.safeParse({ email: "bad" }).success).toBe(false);
  });
});

describe("createConversationSchema", () => {
  test("accepts minimal valid input", () => {
    expect(createConversationSchema.safeParse({
      projectId: "550e8400-e29b-41d4-a716-446655440000",
    }).success).toBe(true);
  });

  test("accepts full input", () => {
    expect(createConversationSchema.safeParse({
      projectId: "550e8400-e29b-41d4-a716-446655440000",
      title: "My Chat",
      model: "gpt-4",
      provider: "openai",
      agentConfigId: "660e8400-e29b-41d4-a716-446655440000",
      test: true,
    }).success).toBe(true);
  });

  test("rejects non-UUID projectId", () => {
    expect(createConversationSchema.safeParse({ projectId: "bad" }).success).toBe(false);
  });

  test("accepts 'global' projectId (seeded org-wide project)", () => {
    expect(createConversationSchema.safeParse({ projectId: "global" }).success).toBe(true);
  });

  test("accepts 'self' projectId (seeded dev-workspace project)", () => {
    expect(createConversationSchema.safeParse({ projectId: "self" }).success).toBe(true);
  });

  test("rejects missing projectId", () => {
    expect(createConversationSchema.safeParse({}).success).toBe(false);
  });

  test("rejects title over 500 chars", () => {
    expect(createConversationSchema.safeParse({
      projectId: "550e8400-e29b-41d4-a716-446655440000",
      title: "x".repeat(501),
    }).success).toBe(false);
  });
});

describe("updateConversationSchema", () => {
  test("accepts empty update (all optional)", () => {
    expect(updateConversationSchema.safeParse({}).success).toBe(true);
  });

  test("accepts partial update", () => {
    expect(updateConversationSchema.safeParse({ title: "New Title" }).success).toBe(true);
  });

  test("rejects systemPrompt over 50000 chars", () => {
    expect(updateConversationSchema.safeParse({
      systemPrompt: "x".repeat(50001),
    }).success).toBe(false);
  });
});

describe("runAgentSchema", () => {
  test("accepts empty object (projectId optional)", () => {
    expect(runAgentSchema.safeParse({}).success).toBe(true);
  });

  test("accepts with projectId", () => {
    expect(runAgentSchema.safeParse({
      projectId: "550e8400-e29b-41d4-a716-446655440000",
    }).success).toBe(true);
  });

  test("passes through extra fields", () => {
    const result = runAgentSchema.safeParse({ projectId: "550e8400-e29b-41d4-a716-446655440000", custom: "data" });
    expect(result.success).toBe(true);
    if (result.success) expect((result.data as any).custom).toBe("data");
  });

  test("rejects invalid UUID projectId", () => {
    expect(runAgentSchema.safeParse({ projectId: "bad" }).success).toBe(false);
  });

  test("accepts 'self' projectId; still rejects 'global'", () => {
    expect(runAgentSchema.safeParse({ projectId: "self" }).success).toBe(true);
    expect(runAgentSchema.safeParse({ projectId: "global" }).success).toBe(false);
  });
});

describe("generateAgentConfigSchema", () => {
  test("accepts valid messages", () => {
    expect(generateAgentConfigSchema.safeParse({
      messages: [{ role: "user", content: "Hello" }],
    }).success).toBe(true);
  });

  test("rejects empty messages array", () => {
    expect(generateAgentConfigSchema.safeParse({ messages: [] }).success).toBe(false);
  });

  test("rejects message with empty role", () => {
    expect(generateAgentConfigSchema.safeParse({
      messages: [{ role: "", content: "Hello" }],
    }).success).toBe(false);
  });

  test("rejects message with empty content", () => {
    expect(generateAgentConfigSchema.safeParse({
      messages: [{ role: "user", content: "" }],
    }).success).toBe(false);
  });

  test("rejects missing messages", () => {
    expect(generateAgentConfigSchema.safeParse({}).success).toBe(false);
  });
});

describe("importManifestSchema", () => {
  const valid = {
    schemaVersion: 1,
    name: "Test Extension",
    version: "1.0.0",
    description: "A test",
  };

  test("accepts valid minimal manifest", () => {
    expect(importManifestSchema.safeParse(valid).success).toBe(true);
  });

  test("accepts full manifest with agent config", () => {
    expect(importManifestSchema.safeParse({
      ...valid,
      author: { name: "Dev", id: "123" },
      agent: { prompt: "Be helpful", category: "utility", temperature: 0.7 },
      tags: ["test"],
    }).success).toBe(true);
  });

  test("rejects missing name", () => {
    const { name, ...noName } = valid;
    expect(importManifestSchema.safeParse(noName).success).toBe(false);
  });

  test("rejects missing version", () => {
    const { version, ...noVersion } = valid;
    expect(importManifestSchema.safeParse(noVersion).success).toBe(false);
  });

  test("rejects description over 2000 chars", () => {
    expect(importManifestSchema.safeParse({
      ...valid, description: "x".repeat(2001),
    }).success).toBe(false);
  });

  test("passes through extra fields", () => {
    const result = importManifestSchema.safeParse({ ...valid, customField: 42 });
    expect(result.success).toBe(true);
    if (result.success) expect((result.data as any).customField).toBe(42);
  });
});

describe("uploadKBFileSchema", () => {
  test("accepts valid UUID projectId", () => {
    expect(uploadKBFileSchema.safeParse({
      projectId: "550e8400-e29b-41d4-a716-446655440000",
    }).success).toBe(true);
  });

  test("rejects non-UUID projectId", () => {
    expect(uploadKBFileSchema.safeParse({ projectId: "bad" }).success).toBe(false);
  });

  test("rejects missing projectId", () => {
    expect(uploadKBFileSchema.safeParse({}).success).toBe(false);
  });

  test("rejects null projectId", () => {
    expect(uploadKBFileSchema.safeParse({ projectId: null }).success).toBe(false);
  });

  test("accepts 'self' projectId; still rejects 'global'", () => {
    expect(uploadKBFileSchema.safeParse({ projectId: "self" }).success).toBe(true);
    expect(uploadKBFileSchema.safeParse({ projectId: "global" }).success).toBe(false);
  });
});

describe("searchMemoriesQuerySchema", () => {
  test("accepts empty object (all optional)", () => {
    expect(searchMemoriesQuerySchema.safeParse({}).success).toBe(true);
  });

  test("accepts 'self' projectId; still rejects 'global'", () => {
    expect(searchMemoriesQuerySchema.safeParse({ projectId: "self" }).success).toBe(true);
    expect(searchMemoriesQuerySchema.safeParse({ projectId: "global" }).success).toBe(false);
  });

  test("accepts full query", () => {
    expect(searchMemoriesQuerySchema.safeParse({
      projectId: "550e8400-e29b-41d4-a716-446655440000",
      search: "hello",
      status: "active",
      category: "general",
      limit: 50,
      offset: 10,
    }).success).toBe(true);
  });

  test("rejects search over 500 chars", () => {
    expect(searchMemoriesQuerySchema.safeParse({ search: "x".repeat(501) }).success).toBe(false);
  });

  test("rejects limit over 100", () => {
    expect(searchMemoriesQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });

  test("rejects negative offset", () => {
    expect(searchMemoriesQuerySchema.safeParse({ offset: -1 }).success).toBe(false);
  });

  test("coerces string limit to number", () => {
    const result = searchMemoriesQuerySchema.safeParse({ limit: "50" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.limit).toBe(50);
  });
});

describe("developer API key schemas", () => {
  test("createApiKeySchema accepts multiple scopes", () => {
    expect(createApiKeySchema.safeParse({
      name: "Dev Key", scopes: ["read", "chat", "extensions"],
    }).success).toBe(true);
  });

  test("deleteApiKeySchema rejects missing keyId", () => {
    expect(deleteApiKeySchema.safeParse({}).success).toBe(false);
  });
});
