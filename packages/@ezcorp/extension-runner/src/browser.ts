import { workspaceText, type WorkspaceFiles } from "@ezcorp/extension-contract";
import { relativePath, RunnerError } from "./core";

export interface BrowserBuild {
  schemaVersion: 1;
  entrypoint: string;
  html: string;
  styles: string[];
  tools: string[];
}

export function browserBuild(files: WorkspaceFiles): BrowserBuild | undefined {
  if (!("ezcorp.browser.json" in files)) return undefined;
  const text = workspaceText(files["ezcorp.browser.json"], "ezcorp.browser.json");
  if (text.length > 8192) throw new RunnerError("browser_config_invalid", "Browser configuration exceeds its limit");
  const value = JSON.parse(text) as BrowserBuild;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "entrypoint,html,schemaVersion,styles,tools" || value.schemaVersion !== 1 || !Array.isArray(value.styles) || value.styles.length > 16 || !Array.isArray(value.tools) || value.tools.length > 32 || value.tools.some(tool => typeof tool !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(tool)) || new Set(value.tools).size !== value.tools.length) throw new RunnerError("browser_config_invalid", "Use a bounded declarative browser configuration");
  for (const path of [value.entrypoint, value.html, ...value.styles]) {
    relativePath(path);
    if (!(path in files)) throw new RunnerError("browser_config_invalid", "Browser input is absent from the frozen source");
    workspaceText(files[path], path);
  }
  if (!/\.[cm]?[jt]sx?$/.test(value.entrypoint) || !/\.html?$/.test(value.html) || value.styles.some(path => !path.endsWith(".css"))) throw new RunnerError("browser_config_invalid", "Browser inputs must be script, HTML, and CSS files");
  return value;
}

export const browserBuilderProgram = String.raw`import {builtinModules} from 'node:module';const spec=JSON.parse(process.argv[1]);
const native=new Set(builtinModules);
const result=await Bun.build({entrypoints:['./'+spec.entrypoint],target:'browser',format:'iife',packages:'bundle',minify:false,sourcemap:'none',write:false,plugins:[{name:'sealed-browser-imports',setup(build){build.onResolve({filter:/.*/},args=>{if(native.has(args.path)||args.path==='bun'||/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(args.path))throw new Error('Browser imports must be local browser modules');});}}]});
if(!result.success){console.error(JSON.stringify(result.logs));process.exit(1);}
const script=result.outputs.find(output=>output.kind==='entry-point');
if(!script||result.outputs.some(output=>output!==script&&!output.path.endsWith('.css')))throw new Error('Browser bundle must embed all assets');
let html=await Bun.file('./'+spec.html).text();
const styles=await Promise.all([...spec.styles.map(path=>Bun.file('./'+path).text()),...result.outputs.filter(output=>output.path.endsWith('.css')).map(output=>output.text())]);
const code=await script.text();
if(html.length>2097152||code.length>8388608||styles.join('').length>2097152)throw new Error('Browser bundle exceeds limit');
html=html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,'').replace(/<link\b[^>]*>/gi,'');
const embedded='<style>'+styles.join('\n').replace(/<\/style/gi,'<\\/style')+'</style><script>'+code.replace(/<\/script/gi,'<\\/script')+'</script>';
html+=embedded;
console.log(JSON.stringify({html}));`;
