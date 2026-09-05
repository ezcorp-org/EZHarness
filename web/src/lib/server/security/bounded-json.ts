import { readBoundedBody } from "./payload";

export async function readBoundedJson(request: Request, maxBytes: number): Promise<unknown> {
  if (!request.body) throw new SyntaxError("Request body is required");
  const bytes = await readBoundedBody(request, maxBytes);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new SyntaxError("Request body must be UTF-8 JSON"); }
  return JSON.parse(text);
}
