// ── Scaffold re-export ───────────────────────────────────────────────
//
// The pure scaffolder lives in the `@ezcorp/sdk` package
// (`packages/@ezcorp/sdk/src/scaffold/`). Host code keeps importing from
// `./scaffold` to avoid churn — re-exporting here keeps the SDK as the
// single source of truth while preserving the existing import sites.
//
// External LLMs / authors using the SDK directly should
// `import { scaffoldExtension } from "@ezcorp/sdk"`. CLI / host code
// should use this re-export.
export {
  scaffoldExtension,
  EXT_TYPES,
  type ExtType,
  type ScaffoldOptions,
  type ScaffoldResult,
} from "@ezcorp/sdk";
