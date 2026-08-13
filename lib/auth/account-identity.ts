export const ACCOUNT_KINDS = ["individual", "student", "teacher"] as const;

export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export interface RequiredAccountIdentity {
  displayName: string | null;
  username: string | null;
  accountKind: AccountKind | null;
}

export function readAccountKind(value: unknown): AccountKind | null {
  return typeof value === "string" && (ACCOUNT_KINDS as readonly string[]).includes(value)
    ? (value as AccountKind)
    : null;
}

export function accountIdentityComplete(value: RequiredAccountIdentity | null | undefined): boolean {
  return Boolean(
    value?.displayName?.trim()
      && value.username?.trim(),
  );
}

/** Username is the only invariant required before leaving first-run setup. */
export function accountUsernameReady(value: RequiredAccountIdentity | null | undefined): boolean {
  return Boolean(value?.username?.trim());
}
