import type { Model } from "@earendil-works/pi-ai";

/**
 * A pi-ai model whose wire API isn't known statically.
 *
 * pi-ai parameterises `Model<TApi extends Api>` and then keys its `compat`
 * field off `TApi` with a conditional type — `TApi extends "openai-completions"
 * ? OpenAICompletionsCompat : TApi extends "openai-responses" ? … : never`.
 * That is a genuine higher-kinded shape, and it is exactly what this codebase
 * cannot supply: the registry loads models from the operator's settings, from
 * live `/v1/models` discovery, and from the models.dev catalog, so a model's
 * API is a runtime string spanning every provider pi-ai supports.
 *
 * `Model<Api>` is not the answer and this is the trap worth writing down:
 * `Api` includes `(string & {})`, so the conditional falls all the way to the
 * `never` branch and `compat` becomes unusable for EVERY model — the union
 * type silently narrows a field to nothing. `any` distributes across all the
 * branches instead, which is the behaviour these call sites need.
 *
 * So this alias exists to make the concession explicit and to have it in ONE
 * place: 14 call sites across registry/router/model-discovery each wrote
 * `Model<any>` inline. If pi-ai ever exposes a `compat`-erased base model
 * type, changing this line changes all of them.
 */
// biome-ignore lint/suspicious/noExplicitAny: pi-ai keys Model on the wire-API type parameter, which this codebase only knows at runtime; `Model<Api>` collapses the `compat` conditional to `never`, so `any` is the only parameter that leaves the type usable (full reasoning in the doc comment above).
export type AnyModel = Model<any>;
