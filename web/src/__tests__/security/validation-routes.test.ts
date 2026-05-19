import { test, expect, describe } from "bun:test";
import { z, } from "zod";
import { validationError } from "../../lib/server/security/validation";
import { loginSchema } from "../../routes/api/auth/login/schema";
import { createMessageSchema } from "../../routes/api/conversations/[id]/messages/schema";
import { createAgentConfigSchema } from "../../routes/api/agent-configs/schema";
import { installExtensionSchema } from "../../routes/api/extensions/schema";
import { publishListingSchema } from "../../routes/api/marketplace/schema";

describe("validationError helper", () => {
  test("produces {error, fields} shape from ZodError", async () => {
    const schema = z.object({ email: z.string().email(), age: z.number().min(0) });
    const result = schema.safeParse({ email: "bad", age: -1 });
    expect(result.success).toBe(false);
    if (result.success) return;

    const response = validationError(result.error);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe("Validation failed");
    expect(body.fields).toBeDefined();
    expect(typeof body.fields.email).toBe("string");
    expect(typeof body.fields.age).toBe("string");
  });
});

describe("loginSchema", () => {
  test("accepts valid input", () => {
    const result = loginSchema.safeParse({ email: "user@test.com", password: "secret" });
    expect(result.success).toBe(true);
  });

  test("rejects missing email", () => {
    const result = loginSchema.safeParse({ password: "secret" });
    expect(result.success).toBe(false);
  });

  test("rejects invalid email", () => {
    const result = loginSchema.safeParse({ email: "not-an-email", password: "secret" });
    expect(result.success).toBe(false);
  });

  test("rejects empty password", () => {
    const result = loginSchema.safeParse({ email: "user@test.com", password: "" });
    expect(result.success).toBe(false);
  });
});

describe("createMessageSchema", () => {
  test("accepts valid input", () => {
    const result = createMessageSchema.safeParse({ content: "Hello" });
    expect(result.success).toBe(true);
  });

  test("accepts full input with optional fields", () => {
    const result = createMessageSchema.safeParse({
      content: "Hello",
      provider: "openai",
      model: "gpt-4",
      parentMessageId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(result.success).toBe(true);
  });

  test("rejects empty content", () => {
    const result = createMessageSchema.safeParse({ content: "" });
    expect(result.success).toBe(false);
  });

  test("rejects missing content", () => {
    const result = createMessageSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test("rejects non-uuid parentMessageId", () => {
    const result = createMessageSchema.safeParse({ content: "Hi", parentMessageId: "not-a-uuid" });
    expect(result.success).toBe(false);
  });
});

describe("createAgentConfigSchema", () => {
  test("accepts valid minimal input", () => {
    const result = createAgentConfigSchema.safeParse({ name: "test-agent", prompt: "You are helpful" });
    expect(result.success).toBe(true);
  });

  test("rejects missing name", () => {
    const result = createAgentConfigSchema.safeParse({ prompt: "You are helpful" });
    expect(result.success).toBe(false);
  });

  test("rejects missing prompt", () => {
    const result = createAgentConfigSchema.safeParse({ name: "test-agent" });
    expect(result.success).toBe(false);
  });

  test("validates temperature range", () => {
    expect(createAgentConfigSchema.safeParse({ name: "a", prompt: "b", temperature: 3 }).success).toBe(false);
    expect(createAgentConfigSchema.safeParse({ name: "a", prompt: "b", temperature: 0.7 }).success).toBe(true);
  });
});

describe("installExtensionSchema", () => {
  test("accepts local source with path", () => {
    const result = installExtensionSchema.safeParse({ source: "local", path: "/some/path" });
    expect(result.success).toBe(true);
  });

  test("accepts github source with repo", () => {
    const result = installExtensionSchema.safeParse({ source: "github", repo: "user/repo" });
    expect(result.success).toBe(true);
  });

  test("accepts git source with https url", () => {
    const result = installExtensionSchema.safeParse({
      source: "git",
      url: "https://github.com/user/repo.git",
    });
    expect(result.success).toBe(true);
  });

  test("accepts git source with ssh url and ref", () => {
    const result = installExtensionSchema.safeParse({
      source: "git",
      url: "git@github.com:user/repo.git",
      ref: "main",
    });
    expect(result.success).toBe(true);
  });

  test("rejects git source without url", () => {
    const result = installExtensionSchema.safeParse({ source: "git" });
    expect(result.success).toBe(false);
  });

  test("rejects git source with file:// url", () => {
    const result = installExtensionSchema.safeParse({
      source: "git",
      url: "file:///tmp/repo.git",
    });
    expect(result.success).toBe(false);
  });

  test("rejects git source with hyphen-leading url (flag injection)", () => {
    const result = installExtensionSchema.safeParse({
      source: "git",
      url: "--upload-pack=evil",
    });
    expect(result.success).toBe(false);
  });

  test("rejects git source with ref containing shell metachars", () => {
    const result = installExtensionSchema.safeParse({
      source: "git",
      url: "https://github.com/user/repo.git",
      ref: "main; rm -rf /",
    });
    expect(result.success).toBe(false);
  });

  test("rejects local source without path", () => {
    const result = installExtensionSchema.safeParse({ source: "local" });
    expect(result.success).toBe(false);
  });

  test("rejects invalid source", () => {
    const result = installExtensionSchema.safeParse({ source: "npm" });
    expect(result.success).toBe(false);
  });
});

describe("publishListingSchema", () => {
  test("accepts valid input", () => {
    const result = publishListingSchema.safeParse({
      agentConfigId: "550e8400-e29b-41d4-a716-446655440000",
      version: "1.0.0",
    });
    expect(result.success).toBe(true);
  });

  test("rejects non-uuid agentConfigId", () => {
    const result = publishListingSchema.safeParse({ agentConfigId: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  test("rejects invalid semver version", () => {
    const result = publishListingSchema.safeParse({
      agentConfigId: "550e8400-e29b-41d4-a716-446655440000",
      version: "bad",
    });
    expect(result.success).toBe(false);
  });
});

describe("safeParse error structure", () => {
  test("returns success:false with issues array on bad input", () => {
    const result = loginSchema.safeParse({ email: 123, password: null });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(Array.isArray(result.error.issues)).toBe(true);
      expect(result.error.issues.length).toBeGreaterThan(0);
      expect(result.error.issues[0]).toHaveProperty("path");
      expect(result.error.issues[0]).toHaveProperty("message");
    }
  });
});
