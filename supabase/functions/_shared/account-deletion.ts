import { json } from "./http.ts";
import type { AdminClient } from "./types.ts";

export const PRIVATE_BUCKET = "family-village-private";

export type DeletionOutcome = {
  email: string | null;
  householdsDeleted: string[];
  householdsWithoutAdults: string[];
};

/**
 * Permanently deletes one person's account: erase their data in the database
 * (one transaction, returns the storage files to remove), delete those files,
 * then delete the sign-in, which cascades their profile.
 *
 * Order matters. The database step comes first because it refuses the one case
 * that must never go through (the last administrator) before anything is
 * touched. Files are removed best-effort: a file that is already gone, or a
 * storage hiccup, must not strand a person who asked to be deleted. The
 * sign-in goes last, so a failure there leaves an account that can simply try
 * again, with the earlier steps harmless to repeat.
 */
export async function deleteAccount(
  admin: AdminClient,
  userId: string,
  deleteHousehold: boolean,
): Promise<{ ok: true; outcome: DeletionOutcome } | { ok: false; response: Response }> {
  const { data, error } = await admin.rpc("erase_account_data", { p_user: userId, p_delete_household: deleteHousehold });
  if (error) {
    if (error.message.includes("last_admin")) {
      return { ok: false, response: json({ error: "You are the only administrator. Make someone else an administrator first, then delete this account." }, 409) };
    }
    return { ok: false, response: json({ error: "The account's data could not be erased. Nothing was deleted." }, 500) };
  }

  const result = data as { email: string | null; storage_paths: string[]; households_deleted: string[]; households_without_adults: string[] };
  const paths = [...new Set((result.storage_paths ?? []).filter(Boolean))];
  for (let i = 0; i < paths.length; i += 100) {
    await admin.storage.from(PRIVATE_BUCKET).remove(paths.slice(i, i + 100)).catch(() => undefined);
  }

  const { error: deleteError } = await admin.auth.admin.deleteUser(userId);
  if (deleteError) {
    return { ok: false, response: json({ error: "Most of the account was erased, but the sign-in could not be deleted. Please try again." }, 500) };
  }

  return {
    ok: true,
    outcome: {
      email: result.email, householdsDeleted: result.households_deleted ?? [],
      householdsWithoutAdults: result.households_without_adults ?? [],
    },
  };
}
