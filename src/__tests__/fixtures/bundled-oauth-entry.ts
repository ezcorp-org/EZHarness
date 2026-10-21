/**
 * The entry a bundle test builds: the product's credential store (for its side effects) and the pi-ai model set it
 * resolves OAuth auth through, bundled into one file the way the web server's build bundles them.
 */
import "../../providers/credential-store";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

export { builtinModels };
