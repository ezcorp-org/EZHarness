import { extensionV4Required } from "../loader";

export interface VerifyStep {
  name: string;
  ok: boolean;
  detail: string;
}
export interface VerifyResult {
  pass: boolean;
  steps: VerifyStep[];
}
export interface VerifyExtensionOptions {
  extDir: string;
}
export async function verifyExtension(_opts: VerifyExtensionOptions): Promise<VerifyResult> {
  return { pass: false, steps: [{ name: "load-manifest", ok: false, detail: extensionV4Required().message }] };
}
