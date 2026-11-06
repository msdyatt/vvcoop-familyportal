import type { AdminClient } from "./types.ts";
import { deleteAccount, PRIVATE_BUCKET } from "./account-deletion.ts";

/**
 * The two reviewer accounts for the App Store and Google Play reviews. Their
 * addresses are never emailed (nothing sends to a demo account), so the domain
 * only needs to be one the co-op controls.
 */
export const DEMO_ACCOUNTS = [
  { role: "parent", email: "reviewer.parent@demo.veritasvillage.org", name: "Demo Parent" },
  { role: "teacher", email: "reviewer.teacher@demo.veritasvillage.org", name: "Demo Teacher" },
] as const;

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

/** 20 characters in four dash-separated groups, without look-alike characters. */
export function generatePassword(random: (n: number) => Uint32Array = (n) => crypto.getRandomValues(new Uint32Array(n))): string {
  const values = random(20);
  const chars = Array.from(values, (v) => ALPHABET[v % ALPHABET.length]);
  return [0, 5, 10, 15].map((i) => chars.slice(i, i + 5).join("")).join("-");
}

export type DemoCredential = { role: string; email: string; password: string };

async function findUserId(admin: AdminClient, email: string): Promise<string | null> {
  const { data } = await admin.from("profiles").select("id").eq("email", email).maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

/**
 * Creates the demo accounts (or, if they already exist, gives them fresh
 * passwords) and rebuilds their sample world. Passwords are returned to the
 * caller once and stored nowhere.
 */
export async function createOrResetDemoAccounts(admin: AdminClient): Promise<{ ok: true; accounts: DemoCredential[] } | { ok: false; error: string }> {
  const accounts: DemoCredential[] = [];
  const ids: Record<string, string> = {};

  for (const account of DEMO_ACCOUNTS) {
    const password = generatePassword();
    const existing = await findUserId(admin, account.email);
    if (existing) {
      const { error } = await admin.auth.admin.updateUserById(existing, { password, email_confirm: true });
      if (error) return { ok: false, error: `Could not reset the ${account.role} account: ${error.message}` };
      ids[account.role] = existing;
    } else {
      const { data, error } = await admin.auth.admin.createUser({
        email: account.email, password, email_confirm: true, user_metadata: { display_name: account.name },
      });
      if (error || !data.user) return { ok: false, error: `Could not create the ${account.role} account: ${error?.message ?? "no user returned"}` };
      ids[account.role] = data.user.id;
    }
    accounts.push({ role: account.role, email: account.email, password });
  }

  const { error } = await admin.rpc("seed_demo_data", { p_parent: ids.parent, p_teacher: ids.teacher });
  if (error) return { ok: false, error: `The accounts exist, but the sample data could not be created: ${error.message}` };
  return { ok: true, accounts };
}

/** Removes the demo accounts and everything in their sample world. */
export async function removeDemoAccounts(admin: AdminClient): Promise<{ ok: true; removed: number } | { ok: false; error: string }> {
  const { data: paths, error } = await admin.rpc("remove_demo_data");
  if (error) return { ok: false, error: `The sample data could not be removed: ${error.message}` };
  const files = [...new Set(((paths ?? []) as string[]).filter(Boolean))];
  for (let i = 0; i < files.length; i += 100) {
    await admin.storage.from(PRIVATE_BUCKET).remove(files.slice(i, i + 100)).catch(() => undefined);
  }

  let removed = 0;
  for (const account of DEMO_ACCOUNTS) {
    const id = await findUserId(admin, account.email);
    if (!id) continue;
    const result = await deleteAccount(admin, id, true);
    if (!result.ok) return { ok: false, error: `Could not delete the ${account.role} account.` };
    removed += 1;
  }
  return { ok: true, removed };
}
