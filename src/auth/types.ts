export type AuthUser = {
  id: string;
  email: string;
  name: string;
  role: "admin" | "member";
};

export type JWTPayload = AuthUser & {
  iat: number;
  exp: number;
};
