import { templateManifest, templateEntrypoint, templateTest, templateReadme } from "./tool";

export function multiManifest(name: string, description: string): string { return templateManifest("multi", name, description); }
export function multiEntrypoint(name: string, _description: string): string { return templateEntrypoint("multi", name); }
export function multiTest(name: string, _description: string): string { return templateTest("multi", name); }
export function multiReadme(name: string, description: string): string { return templateReadme("multi", name, description); }
