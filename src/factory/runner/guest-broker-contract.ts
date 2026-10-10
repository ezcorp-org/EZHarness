/**
 * The guest-broker route's wire contract, shared by both ends.
 *
 * The host supervisor's client and the product's route handler must agree on
 * the path, the body cap, and the host scope. The client runs in the
 * supervisor process, which C01 holds to host identity and no tenant
 * credential, so these values live in this leaf and not in the route module:
 * the route verifies attempt tokens and reaches the settings store, and an
 * import of it would pull the database into the supervisor.
 */

export const FACTORY_GUEST_BROKER_PATH = "/v1/guest/broker";

/** One staging frame plus its own base64 chunk, with room for the JSON envelope. */
export const FACTORY_GUEST_BROKER_MAX_BODY_BYTES = 128 * 1024;

/** The scope a host's bearer token must carry to forward a guest frame. */
export const FACTORY_GUEST_BROKER_SCOPE = "factory:guest-broker";

/**
 * The audience a host's bearer token must name on this route, and no other.
 *
 * A fleet host signs its pool tokens and its guest-broker token with one key
 * and one issuer, so the audience is what keeps a pool token from being
 * accepted here. The route enforces this value whatever its startup document
 * says, and the startup parser refuses any other.
 */
export const FACTORY_GUEST_BROKER_AUDIENCE = "factory-guest-broker";
