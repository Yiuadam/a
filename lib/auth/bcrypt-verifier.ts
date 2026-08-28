/*
  Format validation shared by the D1 importer and the runtime verifier.

  bcrypt always serialises a 60-character verifier.  The bounded cost accepts
  the ordinary Supabase range while rejecting a crafted import artifact that
  would consume an unreasonable amount of Worker CPU during sign-in.
*/

const BCRYPT_VERIFIER = /^\$2[aby]\$(?:0[4-9]|1[0-4])\$[./A-Za-z0-9]{53}$/;

export function isAcceptedBcryptVerifier(value: unknown): value is string {
  return typeof value === "string" && BCRYPT_VERIFIER.test(value);
}
