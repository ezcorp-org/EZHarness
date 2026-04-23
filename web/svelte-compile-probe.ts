import { compile } from "svelte/compiler";
import { readFileSync } from "node:fs";

const src = readFileSync("./src/lib/components/AttachmentCard.svelte", "utf-8");
const out = compile(src, { generate: "client", name: "AttachmentCard" });
console.log("Has js:", !!out.js, "bytes:", out.js?.code?.length ?? 0);
console.log("First warnings:", out.warnings?.slice(0, 2));
