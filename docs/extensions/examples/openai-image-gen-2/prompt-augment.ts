// Port of the Python imagegen skill's `_augment_prompt_fields` — turns a
// bare prompt + scaffolding hints into a structured labeled spec that
// materially improves output quality for generic prompts. Pure and sync
// so tests stay fast and don't need the openai host.

export interface AugmentFields {
  use_case?: string;
  scene?: string;
  subject?: string;
  style?: string;
  composition?: string;
  lighting?: string;
  palette?: string;
  materials?: string;
  text?: string;
  constraints?: string;
  negative?: string;
}

const FIELD_LABELS: Array<[keyof AugmentFields, string]> = [
  ["use_case", "Use case"],
  ["scene", "Scene/background"],
  ["subject", "Subject"],
  ["style", "Style/medium"],
  ["composition", "Composition/framing"],
  ["lighting", "Lighting/mood"],
  ["palette", "Color palette"],
  ["materials", "Materials/textures"],
];

export function augmentPrompt(prompt: string, augment: boolean, fields: AugmentFields = {}): string {
  const base = (prompt ?? "").trim();
  if (!augment) return base;

  const out: string[] = [];
  if (fields.use_case) out.push(`Use case: ${fields.use_case}`);
  out.push(`Primary request: ${base}`);
  for (const [key, label] of FIELD_LABELS) {
    if (key === "use_case") continue;
    const v = fields[key];
    if (v) out.push(`${label}: ${v}`);
  }
  if (fields.text) out.push(`Text (verbatim): "${fields.text}"`);
  if (fields.constraints) out.push(`Constraints: ${fields.constraints}`);
  if (fields.negative) out.push(`Avoid: ${fields.negative}`);
  return out.join("\n");
}

export function fieldsFromInput(input: Record<string, unknown>): AugmentFields {
  const str = (k: string): string | undefined => {
    const v = input[k];
    return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
  };
  return {
    use_case: str("use_case"),
    scene: str("scene"),
    subject: str("subject"),
    style: str("style"),
    composition: str("composition"),
    lighting: str("lighting"),
    palette: str("palette"),
    materials: str("materials"),
    text: str("text"),
    constraints: str("constraints"),
    negative: str("negative"),
  };
}
