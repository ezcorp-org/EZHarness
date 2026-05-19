export type AuthUser = {
  id: string;
  email: string;
  name: string;
  role: "admin" | "member";
};

export type JWTPayload = AuthUser & {
  iat: number;
  exp: number;
  // Random per-token claim. Two JWTs signed in the same second with the
  // same user payload produced identical tokens before this claim existed,
  // which collided on the `sessions.token_hash` UNIQUE constraint at insert
  // time. Optional for verify backward compat with tokens issued before
  // this change.
  jti?: string;
};
