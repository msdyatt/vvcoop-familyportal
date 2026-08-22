"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import ChildDetail from "../child-detail";
import { CollapsibleRecord, EditableSection, Field } from "./admin-ui";
import FamilyDocuments from "./family-documents";
import { FamilyRequirement, Requirement, isSettled, statusLabel, statusTone } from "../../../lib/compliance";

type Child = { id: string; first_name: string; last_name: string | null; last_initial: string | null; age_band: string | null; active: boolean; last_name_override: boolean };
type Member = { user_id: string; relationship: string | null; profiles: { email: string; display_name: string | null; status: string; phone: string | null } | null };
type Family = { id: string; display_name: string; last_name: string | null; children: Child[]; family_members: Member[] };
type ComplianceRow = FamilyRequirement & { requirements: Requirement | null };

const ASSIGNABLE_ROLES = ["teacher", "admin"];

export default function FamiliesTab({ actorUserId }: { actorUserId: string }) {
  const [families, setFamilies] = useState<Family[]>([]);
  const [roleMap, setRoleMap] = useState<Record<string, string[]>>({});
  const [compliance, setCompliance] = useState<ComplianceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");

  async function load() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data, error } = await supabase
      .from("families")
      .select("id,display_name,last_name,children(id,first_name,last_name,last_initial,age_band,active,last_name_override),family_members(user_id,relationship,profiles(email,display_name,status,phone))")
      .order("display_name");
    if (!error) setFamilies((data ?? []) as unknown as Family[]);

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

    setLoading(false);
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
  useEffect(() => { load(); }, []);

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
    }).eq("id", child.id);
    if (error) { setStatus(error.message); return; }
    await log(child.active ? "child_updated" : "child_deactivated", "child", child.id, { first_name: child.first_name, active: child.active });
    setStatus(`Saved ${child.first_name}.`);
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
   * Removing a member is confirmed once. Removing the *last* member of a
   * household is a different act -- it takes the children, their enrollments
   * and the household record with it -- so that path asks the administrator to
   * type the word, and says exactly what goes.
   */
  async function removeUser(familyId: string, userId: string, displayName: string) {
    const family = families.find((row) => row.id === familyId);
    const remaining = (family?.family_members ?? []).filter(
      (member) => member.user_id !== userId && member.profiles?.status !== "removed",
    );
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
    <div className="family-manage-list">
      {families.map((family) => <FamilyCard key={family.id} family={family} roleMap={roleMap} compliance={compliance.filter((row) => row.family_id === family.id)} onSaveFamily={saveFamily} onSaveChild={saveChild} onAddChild={addChild} onRemoveUser={removeUser} onGrantRole={grantRole} onRevokeRole={revokeRole} />)}
    </div>
  </section>;
}

function FamilyCard({ family, roleMap, compliance, onSaveFamily, onSaveChild, onAddChild, onRemoveUser, onGrantRole, onRevokeRole }: {
  family: Family;
  roleMap: Record<string, string[]>;
  compliance: ComplianceRow[];
  onSaveFamily: (f: Family) => void;
  onSaveChild: (c: Child) => void;
  onAddChild: (familyId: string, firstName: string) => void;
  onRemoveUser: (familyId: string, userId: string, displayName: string) => void;
  onGrantRole: (userId: string, role: string) => void;
  onRevokeRole: (userId: string, role: string) => void;
}) {
  const [lastName, setLastName] = useState(family.last_name ?? family.display_name ?? "");
  const [children, setChildren] = useState(family.children ?? []);
  const [viewingChildId, setViewingChildId] = useState<string | null>(null);
  const [addingChild, setAddingChild] = useState(false);
  const [newChildName, setNewChildName] = useState("");

  // eslint-disable-next-line react-hooks/set-state-in-effect -- resync local edit buffer when parent data reloads
  useEffect(() => { setLastName(family.last_name ?? family.display_name ?? ""); setChildren(family.children ?? []); }, [family]);

  function updateChild(id: string, patch: Partial<Child>) {
    setChildren((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  const adults = (family.family_members ?? []).filter((member) => member.profiles?.status !== "removed");
  const activeChildren = children.filter((child) => child.active);
  const outstanding = compliance.filter((row) => row.requirements && !isSettled(row.status)).length;
  const name = family.last_name || family.display_name;

  return <CollapsibleRecord
    summary={<b>{name}</b>}
    meta={`${adults.length} adult${adults.length === 1 ? "" : "s"} · ${activeChildren.length} child${activeChildren.length === 1 ? "" : "ren"}`}
    chips={compliance.length > 0
      ? <span className={`status-pill ${outstanding ? "outstanding" : "complete"}`}>
          {outstanding ? `${outstanding} outstanding` : "Up to date"}
        </span>
      : null}
  >
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
    </div>

    <EditableSection label="Children" onSave={async () => { for (const child of children) onSaveChild(child); }} onCancel={() => setChildren(family.children ?? [])}>
      {(editing) => <>
        {children.map((child) => editing
          ? <div className="child-row" key={child.id}>
              <label>First name<input value={child.first_name} onChange={(event) => updateChild(child.id, { first_name: event.target.value })} /></label>
              <label>Last name<input value={child.last_name ?? ""} onChange={(event) => updateChild(child.id, { last_name: event.target.value, last_name_override: true })} /></label>
              <label className="checkbox-field"><input type="checkbox" checked={child.last_name_override} onChange={(event) => updateChild(child.id, { last_name_override: event.target.checked })} /> Custom name</label>
              <label className="checkbox-field"><input type="checkbox" checked={child.active} onChange={(event) => updateChild(child.id, { active: event.target.checked })} /> Active</label>
            </div>
          : <div className="child-line" key={child.id}>
              <b>{child.first_name} {child.last_name}</b>
              <span>{child.age_band ? `Grade ${child.age_band}` : "Grade not set"}{child.active ? "" : " · inactive"}</span>
              <button onClick={() => setViewingChildId(child.id)}>View</button>
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
  </CollapsibleRecord>;
}
