"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "./supabase";

/**
 * Board-only admin permissions, as the signed-in person holds them
 * (public.my_admin_access, migration 20261121150000_admin_permissions.sql).
 *
 * This only decides what the admin screens show. The database checks the same
 * permission on every call, so a hidden button is a courtesy, not the lock.
 */
export type AdminPermission = "integrations" | "year_setup" | "dues_settings" | "tax_compliance" | "manage_permissions";
export type AdminTier = "board" | "admin";

export const ADMIN_PERMISSIONS: AdminPermission[] = ["integrations", "year_setup", "dues_settings", "tax_compliance", "manage_permissions"];

export const PERMISSION_LABELS: Record<AdminPermission, string> = {
  integrations: "Integrations",
  year_setup: "School year setup",
  dues_settings: "Dues and fees",
  tax_compliance: "Tax and compliance records",
  manage_permissions: "Admin permissions",
};

export type AdminAccess = {
  loading: boolean;
  isAdmin: boolean;
  tier: AdminTier | null;
  permissions: Record<AdminPermission, boolean>;
  can: (permission: AdminPermission) => boolean;
};

type Snapshot = Omit<AdminAccess, "loading" | "can">;

const NONE: Snapshot = {
  isAdmin: false,
  tier: null,
  permissions: { integrations: false, year_setup: false, dues_settings: false, tax_compliance: false, manage_permissions: false },
};

export const ADMIN_ACCESS_EVENT = "vv-admin-access";

/** Turns the RPC's answer into a snapshot; anything unexpected counts as no access. */
export function parseAdminAccess(raw: unknown): Snapshot {
  if (!raw || typeof raw !== "object") return NONE;
  const value = raw as { is_admin?: unknown; tier?: unknown; permissions?: Record<string, unknown> };
  const tier = value.tier === "board" || value.tier === "admin" ? value.tier : null;
  const permissions = { ...NONE.permissions };
  for (const key of ADMIN_PERMISSIONS) permissions[key] = value.permissions?.[key] === true;
  return { isAdmin: value.is_admin === true && tier !== null, tier, permissions };
}

// One request per page load, shared by every screen that asks.
let pending: Promise<Snapshot> | null = null;

function fetchAccess(): Promise<Snapshot> {
  if (!pending) {
    const supabase = getSupabaseBrowserClient();
    pending = supabase
      ? Promise.resolve(supabase.rpc("my_admin_access")).then(({ data, error }) => (error ? NONE : parseAdminAccess(data)), () => NONE)
      : Promise.resolve(NONE);
  }
  return pending;
}

/** Call after changing someone's permissions so open screens ask again. */
export function refreshAdminAccess() {
  pending = null;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(ADMIN_ACCESS_EVENT));
}

export function useAdminAccess(): AdminAccess {
  const [state, setState] = useState<{ loading: boolean; snapshot: Snapshot }>({ loading: true, snapshot: NONE });

  useEffect(() => {
    let live = true;
    const load = () => { fetchAccess().then((snapshot) => { if (live) setState({ loading: false, snapshot }); }); };
    load();
    window.addEventListener(ADMIN_ACCESS_EVENT, load);
    return () => { live = false; window.removeEventListener(ADMIN_ACCESS_EVENT, load); };
  }, []);

  const { snapshot } = state;
  return { loading: state.loading, ...snapshot, can: (permission) => snapshot.permissions[permission] };
}
