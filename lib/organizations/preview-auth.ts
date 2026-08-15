import type { SessionUser } from "@/lib/auth/session";
import { assertServerOnly } from "@/lib/auth/server-only";
import {
  ORGANIZATION_PREVIEW_HEADER,
  parseOrganizationLivePreviewRole,
  type OrganizationLivePreviewRole,
} from "./preview-client";

/**
 * Synthetic identities for the isolated Cloudflare organization preview.
 *
 * The header is deliberately ignored unless the Worker was built with the
 * private preview flag. Production never has that flag, so sending this header
 * to bandup.life grants nothing and normal Supabase authentication remains the
 * only identity authority.
 */
const USERS: Record<OrganizationLivePreviewRole, SessionUser> = {
  manager: {
    id: "22222222-2222-4222-8222-222222222222",
    email: "manager@preview.bandup.invalid",
  },
  teacher: {
    id: "50000000-0000-4000-8000-000000000001",
    email: "teacher@preview.bandup.invalid",
  },
  student: {
    id: "50000000-0000-4000-8000-000000000002",
    email: "student@preview.bandup.invalid",
  },
  admin: {
    id: "90000000-0000-4000-8000-000000000001",
    email: "admin@preview.bandup.invalid",
  },
  individual: {
    id: "90000000-0000-4000-8000-000000000002",
    email: "individual@preview.bandup.invalid",
  },
};

export function organizationPreviewRole(value: unknown): OrganizationLivePreviewRole | null {
  return parseOrganizationLivePreviewRole(value);
}

/**
 * True only for the deliberately public, synthetic organization workspace.
 *
 * Keep this separate from identity parsing. An invalid role header must not
 * turn a preview request into an ordinary Supabase-authenticated request and
 * thereby bypass the preview's read-only boundary.
 */
export function isOrganizationPreviewRequest(req: Request): boolean {
  assertServerOnly("lib/organizations/preview-auth.ts");
  if (process.env.ORGANIZATION_UI_PREVIEW !== "1") return false;
  // `keep_vars` protects normal production configuration, but it also means a
  // stale dashboard flag could survive a deploy. Synthetic identities are
  // therefore accepted only on the dedicated preview host as well as behind
  // the build-time flag. A copied flag on bandup.life grants nothing.
  try {
    return new URL(req.url).hostname.toLowerCase() === "organization-preview.bandup.life";
  } catch {
    return false;
  }
}

export function organizationPreviewUser(req: Request): SessionUser | null {
  assertServerOnly("lib/organizations/preview-auth.ts");
  if (!isOrganizationPreviewRequest(req)) return null;
  const raw = req.headers.get(ORGANIZATION_PREVIEW_HEADER);
  const role = raw === null ? "manager" : organizationPreviewRole(raw);
  return role ? USERS[role] : null;
}

/**
 * The public role preview is a shared synthetic workspace. Refuse addresses
 * outside its reserved invalid domain so it cannot become a public form that
 * stores or redisplays a real person's email address.
 */
export function organizationPreviewPayloadAllowed(
  action: string,
  payload: Record<string, unknown>,
): boolean {
  const email = action === "invite_member" ? payload.email : undefined;
  return email === undefined
    || (typeof email === "string" && email.trim().toLowerCase().endsWith("@preview.bandup.invalid"));
}
