import { defineExtension } from "../../../../src/extensions/sdk/define";

export default defineExtension({
  schemaVersion: 2,
  name: "openai-image-gen-2",
  version: "1.0.0",
  description:
    "Generate or edit raster images with OpenAI's gpt-image-* models. " +
    "Returns the bitmap inline as a data:image/ URL so it renders directly " +
    "in chat. Uses your subscription OAuth token via the Codex Responses API " +
    "when available, or a classic sk-… API key against the Images API.",
  author: { name: "EZCorp" },
  entrypoint: "./index.ts",
  tools: [
    {
      name: "generate",
      description:
        "Create a new image from a text prompt. Returns a markdown image " +
        "reference with a data:image/ URI that renders inline in chat.",
      inputSchema: {
        type: "object",
        required: ["prompt"],
        properties: {
          prompt: { type: "string", description: "The image description." },
          model: {
            type: "string",
            default: "gpt-image-1.5",
            description:
              "On the BYOK API-key path: a gpt-image-* model (default gpt-image-1.5, matching the Codex imagegen skill). " +
              "On the OAuth path: a gpt-5.x Codex model (default gpt-5.4). Non-matching ids are silently remapped to the default.",
          },
          size: { type: "string", enum: ["1024x1024", "1536x1024", "1024x1536", "auto"], default: "1024x1024" },
          quality: { type: "string", enum: ["low", "medium", "high", "auto"], default: "auto" },
          background: { type: "string", enum: ["transparent", "opaque", "auto"] },
          output_format: { type: "string", enum: ["png", "jpeg", "webp"], default: "png" },
          output_compression: { type: "integer", minimum: 0, maximum: 100 },
          augment: { type: "boolean", default: true },
          use_case: { type: "string" },
          scene: { type: "string" },
          subject: { type: "string" },
          style: { type: "string" },
          composition: { type: "string" },
          lighting: { type: "string" },
          palette: { type: "string" },
          materials: { type: "string" },
          text: { type: "string" },
          constraints: { type: "string" },
          negative: { type: "string" },
        },
      },
    },
    {
      name: "edit",
      description:
        "Edit input images with a prompt. Accepts data:image/ URIs or https:// URLs. " +
        "Returns a markdown image reference with a data:image/ URI.",
      inputSchema: {
        type: "object",
        required: ["prompt", "images"],
        properties: {
          prompt: { type: "string" },
          images: {
            type: "array",
            minItems: 1,
            maxItems: 4,
            items: { type: "string" },
          },
          mask: { type: "string" },
          model: {
            type: "string",
            default: "gpt-image-1.5",
            description: "BYOK path: default gpt-image-1.5. OAuth path: default gpt-5.4.",
          },
          size: { type: "string", enum: ["1024x1024", "1536x1024", "1024x1536", "auto"] },
          quality: { type: "string", enum: ["low", "medium", "high", "auto"] },
          background: { type: "string", enum: ["transparent", "opaque", "auto"] },
          output_format: { type: "string", enum: ["png", "jpeg", "webp"] },
          output_compression: { type: "integer", minimum: 0, maximum: 100 },
          input_fidelity: { type: "string", enum: ["low", "high"] },
          augment: { type: "boolean", default: true },
          use_case: { type: "string" },
          scene: { type: "string" },
          subject: { type: "string" },
          style: { type: "string" },
          composition: { type: "string" },
          lighting: { type: "string" },
          palette: { type: "string" },
          materials: { type: "string" },
          text: { type: "string" },
          constraints: { type: "string" },
          negative: { type: "string" },
        },
      },
    },
  ],
  skills: [
    {
      name: "image-generation-guide",
      description: "When and how to use the generate/edit tools, prompt shaping, and use-case taxonomy.",
      files: ["SKILL.md"],
    },
  ],
  permissions: {
    // Two endpoints:
    //   - api.openai.com → classic Images API (BYOK sk-… key path)
    //   - chatgpt.com    → Codex Responses + image_generation (subscription OAuth path)
    network: ["api.openai.com", "chatgpt.com"],
    env: ["OPENAI_API_KEY", "OPENAI_ACCESS_TOKEN"],
    // Write generated images to `<projectRoot>/.ezcorp/extension-data/openai-image-gen-2/`.
    // Serving them via a short URL instead of embedding base64 in the
    // tool result keeps image bytes out of the model's context window
    // (base64 of a 1024×1024 PNG is ~2 MB — easily overruns it).
    filesystem: ["$CWD"],
  },
  resources: {
    memory: "512MB",
    // Image generation regularly takes 30-120s end-to-end. The default
    // 30s tool-call timeout cuts the subprocess off mid-flight.
    callTimeoutMs: 180_000,
  },
  tags: ["image", "generation", "openai", "gpt-image"],
  category: "Media",
});
