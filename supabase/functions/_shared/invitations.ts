import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.3";
import { json } from "./http.ts";
import type { AdminClient } from "./types.ts";
import { sendAndLog } from "./resend.ts";
import { buildInviteEmail, INVITE_SUBJECT } from "./invite-email.ts";

/** What manageInvitation needs to send mail; a test can pass a stub instead of Resend. */
export type SendInviteEmail = (admin: SupabaseClient, opts: { to: string; subject: string; html: string; kind: string; subjectType?: string; subjectId?: string }) => Promise<{ ok: boolean; error?: string }>;

/**
 * Resend or delete a pending invitation.
 *
 * Both only ever act on someone who has NOT signed in: an invited person is a
 * real auth account from the moment the invitation is created (that is how
 * the link works), so "pending" is judged from the account itself --
 * never confirmed, never signed in -- not from the invitations row alone.
 */
export async function manageInvitation(
  adminClient: AdminClient,
  actorId: string,
  action: "resend" | "delete",
  invitationId?: string,
  send: SendInviteEmail = sendAndLog,
): Promise<Response> {
  if (!invitationId) return json({ error: "Which invitation?" }, 400);
  const { data: invitation } = await adminClient.from("invitations").select("id,email,family_id,accepted_at").eq("id", invitationId).maybeSingle();
  if (!invitation) return json({ error: "That invitation no longer exists." }, 404);
  if (invitation.accepted_at) return json({ error: "This invitation was already accepted. Manage that person from the Families tab instead." }, 409);

  const { data: profile } = await adminClient.from("profiles").select("id,display_name").eq("email", invitation.email.toLowerCase()).maybeSingle();
  const account = profile ? (await adminClient.auth.admin.getUserById(profile.id)).data.user : null;
  if (account && (account.email_confirmed_at || account.last_sign_in_at)) {
    return json({ error: `${invitation.email} has already signed in. Manage them from the Families tab instead.` }, 409);
  }

  if (action === "resend") {
    if (!profile || !account) return json({ error: "That invitation's account no longer exists. Delete this invitation and send a new one." }, 404);

    const { data: family } = invitation.family_id
      ? await adminClient.from("families").select("display_name,last_name").eq("id", invitation.family_id).maybeSingle()
      : { data: null };
    const { count: memberCount } = invitation.family_id
      ? await adminClient.from("family_members").select("user_id", { count: "exact", head: true }).eq("family_id", invitation.family_id)
      : { count: 0 };
    const familyName = family?.last_name || family?.display_name || "your household";

    const { data: link, error: linkError } = await adminClient.auth.admin.generateLink({
      type: "invite", email: invitation.email,
      options: { redirectTo: "https://family.veritasvillage.org/family-village/accept-invite" },
    });
    const actionLink = link?.properties?.action_link;
    if (linkError || !actionLink) return json({ error: linkError?.message ?? "A fresh link could not be created. Nothing was emailed." }, 400);

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await adminClient.from("invitations").update({ expires_at: expiresAt }).eq("id", invitation.id);

    const note = typeof account.user_metadata?.note === "string" ? account.user_metadata.note : undefined;
    const html = buildInviteEmail({
      adminName: profile.display_name || invitation.email, familyName,
      // The original send used the "join this household" wording whenever the
      // household already had someone in it; this person is one of those members.
      existingHousehold: (memberCount ?? 0) > 1, note, actionLink,
    });
    const emailResult = await send(adminClient, {
      to: invitation.email, subject: INVITE_SUBJECT, html, kind: "invite",
      subjectType: "family", subjectId: invitation.family_id ?? undefined,
    });
    await adminClient.from("audit_log").insert({ actor_user_id: actorId, action: "invitation_resent", subject_type: "invitation", subject_id: invitation.id, detail: { email: invitation.email } });
    if (!emailResult.ok) return json({ ok: true, expiresAt, warning: `A fresh link was created, but the email could not be sent: ${emailResult.error}` });
    return json({ ok: true, email: invitation.email, expiresAt });
  }

  // --- delete ---
  // The pending account goes with the invitation, unless it is attached to
  // anything else (another household, or a role beyond the parent role the
  // invitation itself granted), in which case only the invitation is removed.
  let accountRemoved = false;
  let householdRemoved = false;
  if (profile && account) {
    const [{ data: otherFamilies }, { data: roles }] = await Promise.all([
      adminClient.from("family_members").select("family_id").eq("user_id", profile.id).neq("family_id", invitation.family_id ?? "00000000-0000-0000-0000-000000000000"),
      adminClient.from("user_roles").select("role").eq("user_id", profile.id),
    ]);
    const attachedElsewhere = (otherFamilies ?? []).length > 0 || (roles ?? []).some((row: { role: string }) => row.role !== "parent");
    if (!attachedElsewhere) {
      const { error } = await adminClient.auth.admin.deleteUser(profile.id);
      if (error) return json({ error: `The pending account could not be removed: ${error.message}` }, 500);
      accountRemoved = true;
    }
  }

  // A household that was created only for this invitation goes too -- but
  // never one that has anyone else in it or any children.
  if (invitation.family_id) {
    const [{ count: members }, { count: kids }] = await Promise.all([
      adminClient.from("family_members").select("user_id", { count: "exact", head: true }).eq("family_id", invitation.family_id),
      adminClient.from("children").select("id", { count: "exact", head: true }).eq("family_id", invitation.family_id),
    ]);
    if (!members && !kids) {
      const { error } = await adminClient.from("families").delete().eq("id", invitation.family_id);
      householdRemoved = !error;
    }
  }

  await adminClient.from("invitations").delete().eq("id", invitation.id);
  await adminClient.from("audit_log").insert({
    actor_user_id: actorId, action: "invitation_deleted", subject_type: "invitation", subject_id: invitation.id,
    detail: { email: invitation.email, account_removed: accountRemoved, household_removed: householdRemoved },
  });
  return json({ ok: true, accountRemoved, householdRemoved });
}
