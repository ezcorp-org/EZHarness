import type { InputField, InputSchema } from "../types";
import { createInterface } from "node:readline/promises";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export const EOF = Symbol("EOF");

async function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string | null> {
  try {
    const answer = await rl.question(question);
    return answer.trim();
  } catch {
    return null;
  }
}

export async function promptForInput(schema: InputSchema): Promise<Record<string, unknown>> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const result: Record<string, unknown> = {};

  try {
    for (const [key, field] of Object.entries(schema)) {
      const marker = field.required ? " (required)" : "";
      if (field.description) {
        process.stdout.write(`${DIM}${field.description}${RESET}\n`);
      }

      const value = await promptField(rl, key, field, marker);
      if (value === EOF) break;
      if (value !== undefined) {
        result[key] = value;
      }
    }
  } finally {
    rl.close();
  }

  return result;
}

async function promptField(
  rl: ReturnType<typeof createInterface>,
  _key: string,
  field: InputField,
  marker: string,
): Promise<typeof EOF | unknown> {
  const defaultStr = field.default !== undefined ? ` [${field.default}]` : "";

  switch (field.type) {
    case "text": {
      while (true) {
        process.stdout.write(`${field.label}${marker} (end with empty line):\n`);
        const lines: string[] = [];
        while (true) {
          const line = await ask(rl, "");
          if (line === null) return EOF;
          if (line === "") break;
          lines.push(line);
        }
        const text = lines.join("\n");
        if (text) return text;
        if (field.default !== undefined) return field.default as string;
        if (field.required) {
          process.stdout.write("This field is required. Please enter a value.\n");
          continue;
        }
        return undefined;
      }
    }

    case "number": {
      while (true) {
        const raw = await ask(rl, `${field.label}${marker}${defaultStr}: `);
        if (raw === null) return EOF;
        if (raw === "" && field.default !== undefined) return field.default;
        if (raw === "" && !field.required) return undefined;
        const n = parseFloat(raw);
        if (!isNaN(n)) return n;
        process.stdout.write("Please enter a valid number.\n");
      }
    }

    case "boolean": {
      while (true) {
        const def = field.default === true ? "Y/n" : field.default === false ? "y/N" : "y/n";
        const raw = await ask(rl, `${field.label}${marker} (${def}): `);
        if (raw === null) return EOF;
        if (raw === "" && field.default !== undefined) return field.default;
        if (raw === "" && !field.required) return undefined;
        if (raw === "" && field.required) {
          process.stdout.write("This field is required. Please enter y or n.\n");
          continue;
        }
        return raw.toLowerCase().startsWith("y");
      }
    }

    case "select": {
      const opts = field.options ?? [];
      while (true) {
        const optList = opts.map((o, i) => `${i + 1}: ${o}`).join(", ");
        const raw = await ask(rl, `${field.label}${marker} [${optList}]${defaultStr}: `);
        if (raw === null) return EOF;
        if (raw === "" && field.default !== undefined) return field.default;
        if (raw === "" && !field.required) return undefined;
        const idx = parseInt(raw, 10);
        if (idx >= 1 && idx <= opts.length) return opts[idx - 1];
        if (opts.includes(raw)) return raw;
        if (field.required) {
          process.stdout.write("Please select a valid option.\n");
          continue;
        }
        return raw;
      }
    }

    default: {
      // string, file-path, custom fallback
      while (true) {
        const raw = await ask(rl, `${field.label}${marker}${defaultStr}: `);
        if (raw === null) return EOF;
        if (raw === "" && field.default !== undefined) return field.default;
        if (raw === "" && !field.required) return undefined;
        if (raw === "" && field.required) {
          process.stdout.write("This field is required. Please enter a value.\n");
          continue;
        }
        return raw || undefined;
      }
    }
  }
}
