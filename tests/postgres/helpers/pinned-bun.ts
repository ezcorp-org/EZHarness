import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The pinned Bun binary, derived from .bun-version so a pin change edits one file (see scripts/lib/pinned-bun.sh). */
export const pinnedBun = `${process.env.FACTORY_TOOLS_DIR ?? "/tmp/factory-tools"}/bun-${readFileSync(join(import.meta.dir, "../../../.bun-version"), "utf8").trim()}/bun-linux-x64/bun`;
