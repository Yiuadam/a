import { isAdminEmail } from "@/lib/auth/env";
import type { SessionUser } from "@/lib/auth/session";
import { rpc } from "@/lib/auth/supabase";
import type { ModuleResult } from "@/lib/types";
import { organizationDataMode } from "@/lib/cloudflare/bindings";
import { cloudflareOrganizationCommand } from "@/lib/cloudflare/organization-commands";
import {
  cloudflareOrganizationHomeShortcut,
  cloudflareOrganizationPortal,
  cloudflareOrganizationStudentHistory,
  syncCloudflareOrganizationAttempts,
} from "@/lib/cloudflare/organizations";
import {
  homeOrganizationShortcutFromPortal,
  type HomeOrganizationShortcut,
} from "@/lib/dashboard-home";
import type { OrganizationAction } from "./actions";

const APPLICATION_PURPOSE = "Organization workspace request.";

export { organizationAttempts, organizationHistoryClearWatermark } from "./attempt-sync";

/**
 * Server-only bridge to the database-enforced organization permission model.
 * No table-level service-role query is exposed to a route: every operation
 * enters PostgreSQL through a named function that receives the actor and
 * rechecks their role, assignment and membership state in the same transaction
 * as the write.
 */

export async function organizationPortal(
  user: SessionUser,
  selectedOrganizationId?: string | null,
): Promise<unknown> {
  const platformAdmin = isAdminEmail(user.email);
  if (organizationDataMode() === "cloudflare") {
    return cloudflareOrganizationPortal(user, platformAdmin, selectedOrganizationId);
  }
  if (selectedOrganizationId) {
    return rpc("organization_portal_selected", {
      p_actor: user.id,
      p_platform_admin: platformAdmin,
      p_organization: selectedOrganizationId,
    });
  }
  return rpc("organization_portal_with_former_memberships", {
    p_actor: user.id,
    p_platform_admin: isAdminEmail(user.email),
  });
}

/** The one active-organisation link used by the homepage. */
export async function organizationHomeShortcut(
  user: SessionUser,
): Promise<HomeOrganizationShortcut | null> {
  if (organizationDataMode() === "cloudflare") {
    return cloudflareOrganizationHomeShortcut(user);
  }
  return homeOrganizationShortcutFromPortal(await organizationPortal(user));
}

export async function organizationCommand(
  user: SessionUser,
  action: OrganizationAction,
  payload: Record<string, unknown>,
  idempotencyKey: string,
): Promise<unknown> {
  const platformAdmin = isAdminEmail(user.email);
  if (organizationDataMode() === "cloudflare") {
    return cloudflareOrganizationCommand(
      user,
      platformAdmin,
      action,
      payload,
      idempotencyKey,
    );
  }
  if (action === "request_to_join" || action === "accept_invitation") {
    return rpc("organization_consent_command", {
      p_actor: user.id,
      p_platform_admin: isAdminEmail(user.email),
      p_action: action,
      p_payload: payload,
      p_idempotency_key: idempotencyKey,
    });
  }
  if (action === "set_prior_history_sharing") {
    return rpc("organization_history_sharing_command", {
      p_actor: user.id,
      p_platform_admin: isAdminEmail(user.email),
      p_payload: payload,
      p_idempotency_key: idempotencyKey,
    });
  }
  if (action === "invite_member" && typeof payload.userId === "string") {
    return rpc("organization_invite_account", {
      p_actor: user.id,
      p_platform_admin: platformAdmin,
      p_organization: payload.organizationId,
      p_target: payload.userId,
      p_role: payload.role ?? "student",
      p_token: payload.token,
      p_idempotency_key: idempotencyKey,
    });
  }
  if (action === "assign_teacher_batch") {
    const organizationId = payload.organizationId;
    const teacherUserId = payload.teacherUserId;
    const studentUserIds = payload.studentUserIds;
    if (
      typeof organizationId !== "string"
      || typeof teacherUserId !== "string"
      || !Array.isArray(studentUserIds)
    ) {
      throw new Error("Invalid teacher assignment.");
    }
    // Keep the bulk operation atomic without replacing the already-installed
    // 0017 command bus on staging databases. The dedicated RPC performs the
    // same role, active-membership, platform-admin and audit checks inside one
    // transaction.
    return rpc("organization_assign_teacher_batch", {
      p_actor: user.id,
      p_platform_admin: isAdminEmail(user.email),
      p_organization: organizationId,
      p_teacher: teacherUserId,
      p_students: studentUserIds,
      p_idempotency_key: idempotencyKey,
    });
  }
  return rpc("organization_command", {
    p_actor: user.id,
    p_platform_admin: isAdminEmail(user.email),
    p_action: action,
    // Older Supabase organization schemas keep a non-null `purpose` column.
    // The product no longer collects this field, so satisfy that private
    // storage detail without reintroducing it into the application form.
    p_payload: action === "submit_application"
      ? { ...payload, purpose: APPLICATION_PURPOSE }
      : payload,
    p_idempotency_key: idempotencyKey,
  });
}

export async function organizationStudentHistory(
  user: SessionUser,
  studentId: string,
  organizationId?: string | null,
  attemptId?: string | null,
): Promise<unknown> {
  if (organizationDataMode() === "cloudflare") {
    return cloudflareOrganizationStudentHistory(
      user,
      isAdminEmail(user.email),
      studentId,
      undefined,
      organizationId,
      attemptId,
    );
  }
  if (organizationId) {
    throw new Error("Selecting an organization for student history requires Cloudflare data mode.");
  }
  // The legacy RPC has no exact-sitting overload. Keep its established full
  // history response intact; the client still selects the requested attempt.
  return rpc("organization_student_history", {
    p_actor: user.id,
    p_platform_admin: isAdminEmail(user.email),
    p_student: studentId,
  });
}

export async function syncOrganizationAttempts(
  user: SessionUser,
  attempts: readonly ModuleResult[],
  idempotencyKey: string,
  historyClearedAt: string | null = null,
): Promise<boolean> {
  if (attempts.length === 0 && historyClearedAt === null) return true;
  const mode = organizationDataMode();
  if (mode === "cloudflare") {
    try {
      return await syncCloudflareOrganizationAttempts(
        user,
        attempts,
        idempotencyKey,
        undefined,
        historyClearedAt,
      );
    } catch {
      return false;
    }
  }
  try {
    if (attempts.length > 0) {
      await rpc("organization_sync_attempts", {
        p_actor: user.id,
        p_attempts: attempts,
        p_idempotency_key: idempotencyKey,
      });
    }
    if (mode === "dual") {
      await syncCloudflareOrganizationAttempts(
        user,
        attempts,
        idempotencyKey,
        undefined,
        historyClearedAt,
      ).catch(() => false);
    }
    return true;
  } catch {
    return false;
  }
}
