import type { SessionUser } from "@/lib/auth/session";
import { isAdminEmail } from "@/lib/auth/env";
import { rpc } from "@/lib/auth/supabase";
import { organizationDataMode } from "@/lib/cloudflare/bindings";
import { cloudflareOrganizationDiscovery } from "@/lib/cloudflare/organization-discovery";
import type { OrganizationDiscoveryResponse } from "./types";

export async function organizationDiscovery(
  user: SessionUser,
  kind: "user" | "organization",
  query: string,
  organizationId?: string | null,
): Promise<OrganizationDiscoveryResponse> {
  const platformAdmin = isAdminEmail(user.email);
  if (organizationDataMode() === "cloudflare") {
    return cloudflareOrganizationDiscovery(user, platformAdmin, kind, query, organizationId);
  }
  return rpc<OrganizationDiscoveryResponse>("organization_discovery", {
    p_actor: user.id,
    p_platform_admin: platformAdmin,
    p_kind: kind,
    p_query: query,
    p_organization: organizationId ?? null,
  });
}
