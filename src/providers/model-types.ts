import type { Api, Model } from "@earendil-works/pi-ai";

/**
 * A pi-ai model whose wire API isn't known statically.
 *
 * pi-ai parameterises `Model<TApi extends Api>`, and this codebase cannot
 * supply a concrete `TApi`: a model's API is a runtime string arriving from
 * the operator's settings, from live `/v1/models` discovery, or from the
 * models.dev catalog, spanning every provider pi-ai supports.
 *
 * `Api` is the correct argument for that. 14 call sites across
 * registry/router/model-discovery wrote `Model<any>` instead, and it is worth
 * recording why that looked necessary and isn't: pi-ai keys the `compat` field
 * off a conditional on `TApi` (`TApi extends "openai-completions" ? … :
 * never`), so passing the `Api` UNION reads like it should fall through to
 * that `never`. It doesn't. `TApi` is a NAKED type parameter, which makes the
 * conditional DISTRIBUTIVE: it evaluates per union member and the `never`
 * results are absorbed by the union, leaving `compat` as the real union of the
 * three compat types.
 *
 * Checked, not assumed — under this repo's tsconfig,
 * `[NonNullable<Model<Api>["compat"]>] extends [never]` is false.
 *
 * So this alias is a strict tightening, not a rename: `Model<any>` switched
 * off checking for every field of every model object it touched, `Model<Api>`
 * checks all of them. It stays a named alias so the "why can't this be
 * concrete" answer lives in exactly one place.
 */
export type AnyModel = Model<Api>;
