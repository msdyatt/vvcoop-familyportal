/**
 * Board-only admin permissions (migration 20261121160000_admin_permissions.sql).
 * The database is the source of truth; Edge Functions ask it about the person they
 * have already identified, with the service-role client.
 */
export type AdminPermission = "integrations" | "year_setup" | "dues_settings" | "tax_compliance" | "manage_permissions";

export const PERMISSION_LABELS: Record<AdminPermission, string> = {
  integrations: "Integrations",
  year_setup: "School year setup",
  dues_settings: "Dues and fees",
  tax_compliance: "Tax and compliance records",
  manage_permissions: "Admin permissions",
};

/** The one call this needs; the service-role client fits it, and so does a test fake. */
export type RpcClient = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> };

/** True only when the database says this admin holds the permission. Any error counts as no. */
export async function hasAdminPermission(admin: RpcClient, userId: string, permission: AdminPermission): Promise<boolean> {
  const { data, error } = await admin.rpc("admin_has_permission", { p_user: userId, p_permission: permission });
  return !error && data === true;
}

/** The refusal every gated function sends, matching the database's wording. */
export function permissionRefusal(permission: AdminPermission): string {
  return `Ask a board admin. This needs the "${PERMISSION_LABELS[permission]}" permission.`;
}
