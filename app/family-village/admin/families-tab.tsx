"use client";

import { useEffect, useMemo, useState } from "react";
import { functionErrorMessage, getSupabaseBrowserClient } from "../../../lib/supabase";
import { getSignedFileUrls, uploadPrivateFile } from "../../../lib/storage";
import ChildDetail from "../child-detail";
import Avatar from "../avatar";
import { CollapsibleRecord, ConfirmDeleteModal, EditableSection, Field, GRADES } from "./admin-ui";
import FamilyDocuments from "./family-documents";
import { FamilyRequirement, Requirement, activeAdults, isSettled, statusLabel, statusTone } from "../../../lib/compliance";

type Child = {
  id: string; first_name: string; last_name: string | null; last_initial: string | null;
  age_band: string | null; birthdate: string | null; age_band_override: boolean;
  active: boolean; last_name_override: boolean; avatar_path: string | null;
  enrollments: { class_id: string; status: string }[];
};
type Member = { user_id: string; relationship: string | null; profiles: { email: string; display_name: string | null; status: string; phone: string | null } | null };
type Family = { id: string; display_name: string; last_name: string | null; children: Child[]; family_members: Member[] };
type ComplianceRow = FamilyRequirement & { requirements: Requirement | null };
type ScheduleClass = { id: string; block_id: string | null; grades: string[]; is_elective: boolean; active: boolean };
type TeacherLink = { user_id: string; class_id: string };

const ASSIGNABLE_ROLES = ["teacher", "admin"];

export default function FamiliesTab({ actorUserId }: { actorUserId: string }) {
  const [families, setFamilies] = useState<Family[]>([]);
  const [roleMap, setRoleMap] = useState<Record<string, string[]>>({});
  const [compliance, setCompliance] = useState<ComplianceRow[]>([]);
  const [avatarUrls, setAvatarUrls] = useState<Map<string, string>>(new Map());
  const [scheduleClasses, setScheduleClasses] = useState<ScheduleClass[]>([]);
  const [teacherLinks, setTeacherLinks] = useState<TeacherLink[]>([]);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");

  async function load() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const [{ data, error }, { data: classRows }, { data: teachingRows }] = await Promise.all([
      supabase.from("families")
        .select("id,display_name,last_name,children(id,first_name,last_name,last_initial,age_band,birthdate,age_band_override,active,last_name_override,avatar_path,enrollments(class_id,status)),family_members(user_id,relationship,profiles(email,display_name,status,phone))")
        .order("display_name"),
      supabase.from("classes").select("id,block_id,grades,is_elective,active,school_years!inner(is_current)").eq("active", true).eq("school_years.is_current", true),
      supabase.from("teacher_assignments").select("user_id,class_id,classes!inner(school_years!inner(is_current))").eq("classes.school_years.is_current", true),
    ]);
    if (!error) setFamilies((data ?? []) as unknown as Family[]);
    setScheduleClasses((classRows ?? []) as unknown as ScheduleClass[]);
    setTeacherLinks((teachingRows ?? []) as TeacherLink[]);

    const userIds = [...new Set(((data ?? []) as unknown as Family[]).flatMap((family) => family.family_members?.map((member) => member.user_id) ?? []))];
    if (userIds.length) {
      const { data: roleRows } = await supabase.from("user_roles").select("user_id,role").in("user_id", userIds);
      const map: Record<string, string[]> = {};
      (roleRows ?? []).forEach((row) => { map[row.user_id] = [...(map[row.user_id] ?? []), row.role]; });
      setRoleMap(map);
    }
    // Standing against this year's requirements, shown as chips on each card so
    // an administrator can see who is behind without opening the Compliance tab.
    const { data: complianceRows } = await supabase
      .from("family_requirements")
      .select("id,requirement_id,family_id,status,signed_at,paid_at,amount_due,amount_paid,requirements!inner(id,kind,title,active,sort_order,school_years!inner(is_current))")
      .eq("requirements.active", true)
      .eq("requirements.school_years.is_current", true);
    setCompliance((complianceRows ?? []) as unknown as ComplianceRow[]);

    const avatarPaths = ((data ?? []) as unknown as Family[])
      .flatMap((family) => family.children.map((child) => child.avatar_path))
      .filter((path): path is string => !!path);
    if (avatarPaths.length) setAvatarUrls(await getSignedFileUrls(supabase, avatarPaths));

    setLoading(false);
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
  useEffect(() => { load(); }, []);

  function metrics(family: Family) {
    const rows = compliance.filter((row) => row.family_id === family.id && row.requirements);
    const unpaid = rows.filter((row) => row.requirements?.kind === "dues" && !isSettled(row.status)).length;
    const unsigned = rows.filter((row) => row.requirements?.kind === "document" && !isSettled(row.status)).length;
    const adultIds = new Set(activeAdults(family.family_members).map((member) => member.user_id));
    const taughtClasses = new Set(teacherLinks.filter((link) => adultIds.has(link.user_id)).map((link) => link.class_id)).size;
    const activeChildren = family.children.filter((child) => child.active);
    const missingEnrollment = activeChildren.some((child) => {
      const eligibleBlocks = new Set(scheduleClasses.filter((klass) => klass.block_id && !klass.is_elective && (!klass.grades.length || !child.age_band || klass.grades.includes(child.age_band))).map((klass) => klass.block_id!));
      const enrolledBlocks = new Set(child.enrollments.filter((entry) => entry.status === "active").map((entry) => scheduleClasses.find((klass) => klass.id === entry.class_id)?.block_id).filter((id): id is string => !!id));
      return [...eligibleBlocks].some((blockId) => !enrolledBlocks.has(blockId));
    });
    return { unpaid, unsigned, taughtClasses, missingEnrollment, noChildren: activeChildren.length === 0 };
  }

  // Computed once per families/compliance/teacherLinks/scheduleClasses change
  // and looked up everywhere else -- metrics() re-scans the family's
  // compliance rows and enrollments, so calling it again per filter and per
  // rendered card multiplied that scan several times over on every render.
  const metricsByFamily = useMemo(() => {
    const map = new Map<string, ReturnType<typeof metrics>>();
    families.forEach((family) => map.set(family.id, metrics(family)));
    return map;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- metrics is a pure projection over these state collections
  }, [families, compliance, teacherLinks, scheduleClasses]);

  const summary = useMemo(() => ({
    unpaid: families.filter((family) => metricsByFamily.get(family.id)!.unpaid > 0).length,
    unsigned: families.filter((family) => metricsByFamily.get(family.id)!.unsigned > 0).length,
    missing: families.filter((family) => metricsByFamily.get(family.id)!.missingEnrollment).length,
  }), [families, metricsByFamily]);

  const visibleFamilies = useMemo(() => {
    const query = search.trim().toLowerCase();
    return families.filter((family) => {
      const info = metricsByFamily.get(family.id)!;
      if (query && !`${family.last_name ?? ""} ${family.display_name} ${family.family_members.map((member) => `${member.profiles?.display_name ?? ""} ${member.profiles?.email ?? ""}`).join(" ")}`.toLowerCase().includes(query)) return false;
      if (filter === "unpaid" && info.unpaid === 0) return false;
      if (filter === "unsigned" && info.unsigned === 0) return false;
      if (filter === "teaching" && info.taughtClasses === 0) return false;
      if (filter === "non-teaching" && info.taughtClasses > 0) return false;
      if (filter === "missing" && !info.missingEnrollment) return false;
      if (filter === "no-kids" && !info.noChildren) return false;
      return true;
    });
  }, [families, metricsByFamily, filter, search]);

  async function log(action: string, subjectType: string, subjectId: string, detail: Record<string, unknown>) {
    const supabase = getSupabaseBrowserClient();
    await supabase?.from("audit_log").insert({ actor_user_id: actorUserId, action, subject_type: subjectType, subject_id: subjectId, detail });
  }

  async function saveFamily(family: Family) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { error } = await supabase.from("families").update({ display_name: family.display_name, last_name: family.last_name }).eq("id", family.id);
    if (error) { setStatus(error.message); return; }
    await log("family_updated", "family", family.id, { display_name: family.display_name, last_name: family.last_name });
    setStatus(`Saved ${family.last_name || family.display_name}. Children without a custom last name were updated to match.`);
    await load();
  }

  async function saveChild(child: Child) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { error } = await supabase.from("children").update({
      first_name: child.first_name, last_name: child.last_name, active: child.active, last_name_override: child.last_name_override,
      birthdate: child.birthdate, age_band_override: child.age_band_override,
      // The trigger derives age_band from birthdate unless overridden; sending
      // it here too only matters for the override case, where it's the value
      // the admin just typed.
      ...(child.age_band_override ? { age_band: child.age_band } : {}),
    }).eq("id", child.id);
    if (error) { setStatus(error.message); return; }
    await log(child.active ? "child_updated" : "child_deactivated", "child", child.id, { first_name: child.first_name, active: child.active });
    setStatus(`Saved ${child.first_name}.`);
    await load();
  }

  async function uploadChildAvatar(childId: string, file: File) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const uploaded = await uploadPrivateFile(supabase, "avatars", file);
    if ("error" in uploaded) { setStatus(uploaded.error); return; }
    const { error } = await supabase.from("children").update({ avatar_path: uploaded.path }).eq("id", childId);
    if (error) { setStatus(error.message); return; }
    setStatus("Photo updated.");
    await load();
  }

  async function addChild(familyId: string, firstName: string) {
    if (!firstName.trim()) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data, error } = await supabase.from("children").insert({ family_id: familyId, first_name: firstName.trim() }).select("id").single();
    if (error) { setStatus(error.message); return; }
    await log("child_added", "child", data.id, { family_id: familyId, first_name: firstName.trim() });
    setStatus(`Added ${firstName.trim()}.`);
    await load();
  }

  /**
   * The "Active" checkbox in the edit view is the everyday off switch --
   * this is the other one: a genuine, permanent removal for a child that
   * was added by mistake or duplicated, not a graduate or a withdrawal
   * (those stay recorded as inactive). Every table with a child_id cascades
   * on delete (enrollments, teacher_notes, documents, media_consents,
   * event_completions, enrollment_requests), so this takes their whole
   * history with it -- that's exactly why ConfirmDeleteModal, not a plain
   * confirm(), gates it.
   */
  async function deleteChild(childId: string, childName: string, familyId: string) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { error } = await supabase.from("children").delete().eq("id", childId);
    if (error) { setStatus(error.message); return; }
    await log("child_deleted", "child", childId, { family_id: familyId, first_name: childName });
    setStatus(`Deleted ${childName}.`);
    await load();
  }

  /**
   * A child's enrollments and records move with them -- family_id is the
   * only column that changes, everything else (enrollments, notes,
   * compliance history) is keyed to the child, not the household.
   */
  async function moveChild(childId: string, childName: string, fromFamilyId: string, toFamilyId: string) {
    const fromName = families.find((f) => f.id === fromFamilyId);
    const toName = families.find((f) => f.id === toFamilyId);
    if (!confirm(`Move ${childName} from ${fromName?.last_name || fromName?.display_name} to ${toName?.last_name || toName?.display_name}?`)) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { error } = await supabase.from("children").update({ family_id: toFamilyId }).eq("id", childId);
    if (error) { setStatus(error.message); return; }
    await log("child_moved", "child", childId, {
      first_name: childName,
      from: fromName?.last_name || fromName?.display_name,
      to: toName?.last_name || toName?.display_name,
    });
    setStatus(`Moved ${childName} to ${toName?.last_name || toName?.display_name}.`);
    await load();
  }

  /**
   * Adds a second (or third) adult to a household that already exists --
   * the original invite flow only ever created a brand-new household with
   * one administrator, so a spouse or co-parent had no way in afterward.
   * Reuses invite-family-admin with a familyId, which skips creating a new
   * household and links the invited person to this one instead.
   */
  async function inviteAdult(familyId: string, adultName: string, email: string, note: string) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return "The portal is not connected to Supabase.";
    const { data, error } = await supabase.functions.invoke("invite-family-admin", { body: { familyId, adminName: adultName, email, note } });
    if (error || data?.error) return await functionErrorMessage(error, data, "The invitation could not be sent.");
    setStatus(data?.warning ?? `Invitation sent to ${email}.`);
    await load();
    return null;
  }

  /**
   * Removing a member is confirmed once. Removing the *last* member of a
   * household is a different act -- it takes the children, their enrollments
   * and the household record with it -- so that path asks the administrator to
   * type the word, and says exactly what goes.
   */
  async function removeUser(familyId: string, userId: string, displayName: string) {
    // This flow assumes the acting admin keeps admin access all the way
    // through -- three parallel writes, then (for the last-adult case) a
    // follow-up household delete. Targeting your own account breaks that
    // assumption at the first write: the moment your own status flips to
    // 'removed', you lose admin access for the rest of this same flow, and
    // the database now refuses those later writes outright rather than
    // silently no-opping them (28 Aug 2026 -- an admin locked themselves out
    // and left a household half-deleted this exact way). Self-removal has
    // its own correct, single-step path: Account Settings.
    if (userId === actorUserId) {
      setStatus("You can't remove your own access from here — use Account Settings to leave a household, or have another admin remove you.");
      return;
    }
    const family = families.find((row) => row.id === familyId);
    const remaining = activeAdults(family?.family_members ?? []).filter((member) => member.user_id !== userId);
    const who = displayName || "this person";

    if (remaining.length > 0) {
      if (!confirm(`Remove ${who}'s access to Family Village?\n\nTheir past notes and posts are kept. ${remaining.length} other adult${remaining.length === 1 ? "" : "s"} still have access to this household.`)) return;
    } else {
      const childCount = family?.children?.length ?? 0;
      const typed = prompt(
        `${who} is the last adult with access to the ${family?.last_name || family?.display_name || "this"} household.\n\n` +
        `Removing them DELETES THE WHOLE HOUSEHOLD:\n` +
        `  • ${childCount} child record${childCount === 1 ? "" : "s"}\n` +
        `  • every class enrollment for those children\n` +
        `  • the household's documents and compliance record\n\n` +
        `This cannot be undone. Type remove to confirm.`,
      );
      if (typed === null) return;
      if (typed.trim().toLowerCase() !== "remove") { setStatus("Not removed — the confirmation did not match."); return; }
    }

    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;

    const results = await Promise.all([
      supabase.from("profiles").update({ status: "removed" }).eq("id", userId),
      supabase.from("user_roles").delete().eq("user_id", userId),
      supabase.from("family_members").delete().eq("user_id", userId).eq("family_id", familyId),
    ]);
    const failed = results.find((result) => result.error);
    if (failed?.error) { setStatus(failed.error.message); return; }

    if (remaining.length === 0) {
      // children, enrollments, documents and compliance rows all cascade.
      const { error } = await supabase.from("families").delete().eq("id", familyId);
      if (error) { setStatus(`${who} lost access, but the household could not be deleted: ${error.message}`); await load(); return; }
      await log("household_deleted", "family", familyId, { last_adult: who, children: family?.children?.length ?? 0 });
      setStatus(`Removed ${who} and deleted the household.`);
      await load();
      return;
    }

    await log("user_removed", "profile", userId, { family_id: familyId, display_name: who });
    setStatus(`${who} no longer has access.`);
    await load();
  }

  /**
   * removeUser()'s household-delete path only fires when the *last* adult is
   * removed -- a household with zero adults to begin with (orphaned by an
   * earlier bug, or just never had one added) has no way through that door
   * at all. This is the direct path: available on every household, not
   * gated behind an adult-removal step.
   */
  async function deleteHousehold(familyId: string, familyName: string, childCount: number, adultCount: number) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { error } = await supabase.from("families").delete().eq("id", familyId);
    if (error) { setStatus(`Could not delete ${familyName}: ${error.message}`); return; }
    await log("household_deleted", "family", familyId, { display_name: familyName, children: childCount, adults: adultCount });
    setStatus(`Deleted ${familyName} and everything in it.`);
    await load();
  }

  async function grantRole(userId: string, role: string) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { error } = await supabase.from("user_roles").insert({ user_id: userId, role });
    if (error) { setStatus(error.message); return; }
    await log("role_granted", "profile", userId, { role });
    await load();
  }

  async function revokeRole(userId: string, role: string) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { error } = await supabase.from("user_roles").delete().eq("user_id", userId).eq("role", role);
    if (error) { setStatus(error.message); return; }
    await log("role_revoked", "profile", userId, { role });
    await load();
  }

  if (loading) return <p>Loading households…</p>;

  return <section className="family-manage">
    <p className="admin-form-status" role="status">{status || `${families.length} household${families.length === 1 ? "" : "s"}. Open one to see its details; nothing is editable until you choose to edit it.`}</p>
    <div className="summary-filter-cards" aria-label="Household summaries">
      <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}><b>{families.length}</b><span>All families</span></button>
      <button className={filter === "unpaid" ? "active" : ""} onClick={() => setFilter("unpaid")}><b>{summary.unpaid}</b><span>Unpaid dues</span></button>
      <button className={filter === "unsigned" ? "active" : ""} onClick={() => setFilter("unsigned")}><b>{summary.unsigned}</b><span>Unsigned forms</span></button>
      <button className={filter === "missing" ? "active" : ""} onClick={() => setFilter("missing")}><b>{summary.missing}</b><span>Need enrollment</span></button>
    </div>
    <div className="list-filters">
      <label><span className="field-caption">Find a family</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name or email" /></label>
      <label><span className="field-caption">Show</span><select value={filter} onChange={(event) => setFilter(event.target.value)}>
        <option value="all">All families</option><option value="unpaid">Unpaid dues</option><option value="unsigned">Unsigned paperwork</option><option value="teaching">Teaching families</option><option value="non-teaching">Non-teaching families</option><option value="missing">Children missing a time slot</option><option value="no-kids">No children assigned</option>
      </select></label>
      <p className="compliance-summary">{visibleFamilies.length} shown</p>
    </div>
    <div className="family-manage-list">
      {visibleFamilies.map((family) => <FamilyCard key={family.id} family={family} allFamilies={families} roleMap={roleMap} compliance={compliance.filter((row) => row.family_id === family.id)} metrics={metricsByFamily.get(family.id)!} avatarUrls={avatarUrls} onSaveFamily={saveFamily} onSaveChild={saveChild} onAddChild={addChild} onDeleteChild={deleteChild} onMoveChild={moveChild} onUploadAvatar={uploadChildAvatar} onRemoveUser={removeUser} onDeleteHousehold={deleteHousehold} onGrantRole={grantRole} onRevokeRole={revokeRole} onInviteAdult={inviteAdult} />)}
      {!visibleFamilies.length && <p className="portal-empty">No households match those filters.</p>}
    </div>
  </section>;
}

function FamilyCard({ family, allFamilies, roleMap, compliance, metrics, avatarUrls, onSaveFamily, onSaveChild, onAddChild, onDeleteChild, onMoveChild, onUploadAvatar, onRemoveUser, onDeleteHousehold, onGrantRole, onRevokeRole, onInviteAdult }: {
  family: Family;
  allFamilies: Family[];
  roleMap: Record<string, string[]>;
  compliance: ComplianceRow[];
  metrics: { unpaid: number; unsigned: number; taughtClasses: number; missingEnrollment: boolean; noChildren: boolean };
  avatarUrls: Map<string, string>;
  onSaveFamily: (f: Family) => void;
  onSaveChild: (c: Child) => void;
  onAddChild: (familyId: string, firstName: string) => void;
  onDeleteChild: (childId: string, childName: string, familyId: string) => Promise<void>;
  onMoveChild: (childId: string, childName: string, fromFamilyId: string, toFamilyId: string) => void;
  onUploadAvatar: (childId: string, file: File) => void;
  onRemoveUser: (familyId: string, userId: string, displayName: string) => void;
  onDeleteHousehold: (familyId: string, familyName: string, childCount: number, adultCount: number) => Promise<void>;
  onGrantRole: (userId: string, role: string) => void;
  onRevokeRole: (userId: string, role: string) => void;
  onInviteAdult: (familyId: string, adultName: string, email: string, note: string) => Promise<string | null>;
}) {
  const [lastName, setLastName] = useState(family.last_name ?? family.display_name ?? "");
  const [children, setChildren] = useState(family.children ?? []);
  const [viewingChildId, setViewingChildId] = useState<string | null>(null);
  const [deletingChild, setDeletingChild] = useState<Child | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deletingHousehold, setDeletingHousehold] = useState(false);
  const [deleteHouseholdBusy, setDeleteHouseholdBusy] = useState(false);
  const [addingChild, setAddingChild] = useState(false);
  const [newChildName, setNewChildName] = useState("");

  // eslint-disable-next-line react-hooks/set-state-in-effect -- resync local edit buffer when parent data reloads
  useEffect(() => { setLastName(family.last_name ?? family.display_name ?? ""); setChildren(family.children ?? []); }, [family]);

  function updateChild(id: string, patch: Partial<Child>) {
    setChildren((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  const adults = activeAdults(family.family_members ?? []);
  const activeChildren = children.filter((child) => child.active);
  const outstanding = compliance.filter((row) => row.requirements && !isSettled(row.status)).length;
  const name = family.last_name || family.display_name;

  return <CollapsibleRecord
    summary={<b>{name}</b>}
    meta={`${adults.length} adult${adults.length === 1 ? "" : "s"} · ${activeChildren.length} child${activeChildren.length === 1 ? "" : "ren"} · teaches ${metrics.taughtClasses} class${metrics.taughtClasses === 1 ? "" : "es"}`}
    chips={compliance.length > 0
      ? <span className={`status-pill ${outstanding ? "outstanding" : "complete"}`}>
          {outstanding ? `${outstanding} outstanding` : "Up to date"}
        </span>
      : null}
  >
    {(metrics.unpaid > 0 || metrics.unsigned > 0) && adults[0]?.profiles?.email && <ReminderBar familyId={family.id} unpaid={metrics.unpaid} unsigned={metrics.unsigned} />}
    <EditableSection
      label="Household"
      onSave={() => onSaveFamily({ ...family, display_name: lastName, last_name: lastName })}
      onCancel={() => setLastName(family.last_name ?? family.display_name ?? "")}
    >
      {(editing) => <div className="field-grid">
        <Field label="Family name" value={name} editing={editing}>
          <input value={lastName} onChange={(event) => setLastName(event.target.value)} placeholder="Lewis" />
        </Field>
        {editing && <p className="field-note">Children without a custom surname follow this name.</p>}
      </div>}
    </EditableSection>

    {/* Removing the last adult already deletes the household along with them
        -- this is the other door in, for a household with no adult to
        remove in the first place (orphaned, or never had one added). */}
    <div className="row-actions">
      <button type="button" className="danger" onClick={() => setDeletingHousehold(true)}>Delete household</button>
    </div>

    <div className="record-section">
      <p className="card-kicker">Adults</p>
      {adults.map((member) => {
        const roles = roleMap[member.user_id] ?? [];
        return <div className="member-row" key={member.user_id}>
          <div className="member-identity">
            <b>{member.profiles?.display_name || "Unnamed"} {family.last_name}</b>
            <span>{member.profiles?.email}</span>
            <span>{member.profiles?.phone || "No phone on file"}</span>
            <span className="member-meta">{member.relationship} · {member.profiles?.status}</span>
          </div>
          <div className="role-chips">
            {ASSIGNABLE_ROLES.map((role) => <button key={role} className={`role-chip${roles.includes(role) ? " active" : ""}`}
              onClick={() => (roles.includes(role) ? onRevokeRole(member.user_id, role) : onGrantRole(member.user_id, role))}>{role}</button>)}
          </div>
          <div className="row-actions">
            <button className="danger" onClick={() => onRemoveUser(family.id, member.user_id, member.profiles?.display_name || member.profiles?.email || "")}>Remove access</button>
          </div>
        </div>;
      })}
      {!adults.length && <p className="portal-empty">No adults have access to this household.</p>}
      <InviteAdult familyId={family.id} onInvite={onInviteAdult} />
    </div>

    <EditableSection label="Children" onSave={async () => { for (const child of children) onSaveChild(child); }} onCancel={() => setChildren(family.children ?? [])}>
      {(editing) => <>
        {children.map((child) => editing
          ? <div className="child-row" key={child.id}>
              <label>First name<input value={child.first_name} onChange={(event) => updateChild(child.id, { first_name: event.target.value })} /></label>
              <label>Last name<input value={child.last_name ?? ""} onChange={(event) => updateChild(child.id, { last_name: event.target.value, last_name_override: true })} /></label>
              <label className="checkbox-field"><input type="checkbox" checked={child.last_name_override} onChange={(event) => updateChild(child.id, { last_name_override: event.target.checked })} /> Custom name</label>
              <label className="checkbox-field"><input type="checkbox" checked={child.active} onChange={(event) => updateChild(child.id, { active: event.target.checked })} /> Active</label>
              <label>Birthdate<input type="date" value={child.birthdate ?? ""} onChange={(event) => updateChild(child.id, { birthdate: event.target.value || null })} /></label>
              <label className="checkbox-field">
                <input type="checkbox" checked={child.age_band_override} onChange={(event) => updateChild(child.id, { age_band_override: event.target.checked })} /> Set grade manually
              </label>
              {child.age_band_override
                ? <label>Grade<select value={child.age_band ?? ""} onChange={(event) => updateChild(child.id, { age_band: event.target.value || null })}>
                    <option value="">Not set</option>
                    {GRADES.map((grade) => <option key={grade} value={grade}>{grade}</option>)}
                  </select></label>
                : <p className="field-note">
                    {child.birthdate ? `Grade ${child.age_band ?? "not yet set"}, calculated from birthdate.` : "Add a birthdate to calculate grade automatically."}
                  </p>}
              <label className="file-drop"><span className="field-caption">Photo</span>
                <input type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) onUploadAvatar(child.id, file); }} />
              </label>
            </div>
          : <div className="child-line" key={child.id}>
              <Avatar url={child.avatar_path ? avatarUrls.get(child.avatar_path) ?? null : null} label={child.first_name} size="sm" />
              <b>{child.first_name} {child.last_name}</b>
              <span>{child.age_band ? `Grade ${child.age_band}` : "Grade not set"}{child.age_band_override ? " · manual" : ""}{child.active ? "" : " · inactive"}</span>
              <button onClick={() => setViewingChildId(child.id)}>View</button>
              {allFamilies.length > 1 && <MoveChildControl
                child={child} currentFamilyId={family.id} allFamilies={allFamilies}
                onMove={(toFamilyId) => onMoveChild(child.id, child.first_name, family.id, toFamilyId)}
              />}
              <button className="danger" onClick={() => setDeletingChild(child)}>Delete</button>
            </div>)}
        {!children.length && <p className="portal-empty">No children on this household yet.</p>}

        {/* A button, not a stray input sitting open on the page. */}
        {!addingChild
          ? <button className="add-child-button" onClick={() => setAddingChild(true)}>Add a child</button>
          : <div className="add-child-row">
              {/* eslint-disable-next-line jsx-a11y/no-autofocus -- the field only exists after the user pressed Add, so focusing it follows their intent rather than hijacking it */}
              <label>First name<input autoFocus value={newChildName} onChange={(event) => setNewChildName(event.target.value)} placeholder="First name" /></label>
              <div className="row-actions">
                <button onClick={() => { onAddChild(family.id, newChildName); setNewChildName(""); setAddingChild(false); }}>Add</button>
                <button className="ghost" onClick={() => { setNewChildName(""); setAddingChild(false); }}>Cancel</button>
              </div>
            </div>}
      </>}
    </EditableSection>

    {compliance.length > 0 && <div className="record-section">
      <p className="card-kicker">This year</p>
      <div className="family-compliance-chips">
        {compliance
          .filter((row) => row.requirements)
          .sort((a, b) => Number(isSettled(a.status)) - Number(isSettled(b.status)))
          .map((row) => <span key={row.id} className={`status-pill ${statusTone(row.status)}`}>
            {row.requirements!.title}: {statusLabel(row.requirements!.kind, row)}
          </span>)}
      </div>
    </div>}

    <FamilyDocuments familyId={family.id} familyName={name} />

    {viewingChildId && <ChildDetail childId={viewingChildId} onClose={() => setViewingChildId(null)} />}
    {deletingChild && <ConfirmDeleteModal
      title={`Delete ${deletingChild.first_name}?`}
      description={<>This permanently removes {deletingChild.first_name}&rsquo;s record, including their class enrollments, teacher notes, documents, and photo consents. This is different from the Active checkbox — a withdrawn or graduated child should stay Active: false instead, so their history is kept. This cannot be undone.</>}
      busy={deleteBusy}
      onConfirm={async () => {
        setDeleteBusy(true);
        await onDeleteChild(deletingChild.id, deletingChild.first_name, family.id);
        setDeleteBusy(false);
        setDeletingChild(null);
      }}
      onCancel={() => setDeletingChild(null)}
    />}
    {deletingHousehold && <ConfirmDeleteModal
      title={`Delete ${name}?`}
      description={<>
        This permanently deletes the {name} household{adults.length > 0 ? `, removing access for ${adults.length} adult${adults.length === 1 ? "" : "s"}` : ""}, along with {children.length} child record{children.length === 1 ? "" : "s"},
        every class enrollment, and the household&rsquo;s documents and compliance record. This cannot be undone.
      </>}
      busy={deleteHouseholdBusy}
      onConfirm={async () => {
        setDeleteHouseholdBusy(true);
        await onDeleteHousehold(family.id, name, children.length, adults.length);
        setDeleteHouseholdBusy(false);
        setDeletingHousehold(false);
      }}
      onCancel={() => setDeletingHousehold(false)}
    />}
  </CollapsibleRecord>;
}

/** A household picker + confirm, tucked behind a "Move" toggle so it doesn't clutter the common case of never moving anyone. */
function MoveChildControl({ child, currentFamilyId, allFamilies, onMove }: {
  child: Child; currentFamilyId: string; allFamilies: Family[]; onMove: (toFamilyId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState("");
  const options = allFamilies.filter((f) => f.id !== currentFamilyId).sort((a, b) => (a.last_name || a.display_name).localeCompare(b.last_name || b.display_name));

  if (!open) return <button type="button" className="ghost" onClick={() => { setTarget(options[0]?.id ?? ""); setOpen(true); }}>Move</button>;

  return <span className="inline-edit">
    <select aria-label={`Move ${child.first_name} to`} value={target} onChange={(event) => setTarget(event.target.value)}>
      {options.map((f) => <option key={f.id} value={f.id}>{f.last_name || f.display_name}</option>)}
    </select>
    <button type="button" disabled={!target} onClick={() => { onMove(target); setOpen(false); }}>Move</button>
    <button type="button" className="ghost" onClick={() => setOpen(false)}>Cancel</button>
  </span>;
}

/**
 * Invites a second adult onto a household that already exists. Kept as its
 * own small stateful component (not lifted into FamilyCard's state) since
 * every household's card would otherwise carry email/name/note fields it
 * almost never uses.
 */
function InviteAdult({ familyId, onInvite }: { familyId: string; onInvite: (familyId: string, adultName: string, email: string, note: string) => Promise<string | null> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function send() {
    setBusy(true);
    setError("");
    const failure = await onInvite(familyId, name.trim(), email.trim(), note.trim());
    setBusy(false);
    if (failure) { setError(failure); return; }
    setName(""); setEmail(""); setNote(""); setOpen(false);
  }

  if (!open) return <button type="button" className="ghost" onClick={() => setOpen(true)}>Invite another adult</button>;

  return <div className="add-child-row">
    {/* eslint-disable-next-line jsx-a11y/no-autofocus -- the fields only exist after the admin pressed the button, so focusing follows their intent */}
    <label>Their name<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Jordan Lewis" disabled={busy} /></label>
    <label>Email address<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="jordan@example.com" disabled={busy} /></label>
    <label>Personal note <span>optional</span><input value={note} onChange={(event) => setNote(event.target.value)} placeholder="A short welcome from the Village…" disabled={busy} /></label>
    <div className="row-actions">
      <button type="button" disabled={busy || !name.trim() || !email.trim()} onClick={send}>{busy ? "Sending…" : "Send invitation"}</button>
      <button type="button" className="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
    </div>
    {error && <p className="admin-form-status" role="status">{error}</p>}
  </div>;
}

/**
 * Sends a real reminder email through Resend, rather than opening the
 * admin's own mail client with a drafted message they still had to send by
 * hand -- that manual step was the whole thing the co-op wanted automated.
 */
function ReminderBar({ familyId, unpaid, unsigned }: { familyId: string; unpaid: number; unsigned: number }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  async function send() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true);
    setStatus("");
    const { data, error } = await supabase.functions.invoke("send-family-reminder", { body: { familyId } });
    setBusy(false);
    if (error) { setStatus(await functionErrorMessage(error, data, "The reminder could not be sent.")); return; }
    setStatus(data?.ok ? `Sent to ${data.sent} of ${data.recipients} adult${data.recipients === 1 ? "" : "s"}.` : (data?.error ?? "The reminder could not be sent."));
  }

  return <div className="family-reminder-bar">
    <span>{unpaid ? `${unpaid} unpaid` : ""}{unpaid && unsigned ? " · " : ""}{unsigned ? `${unsigned} unsigned` : ""}</span>
    <span className="family-reminder-action">
      {status && <small>{status}</small>}
      <button type="button" onClick={send} disabled={busy}>{busy ? "Sending…" : "Send reminder"}</button>
    </span>
  </div>;
}
