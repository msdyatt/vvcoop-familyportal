"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import ChildDetail from "../child-detail";
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
    <p className="admin-form-status" role="status">{status || "Editing a family's name updates every child who hasn't been given a custom last name."}</p>
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
  // One name. families.last_name is the real one -- a trigger pushes it onto
  // every child who has not overridden their surname -- and display_name is
  // only a label, so it is kept in step rather than asked for twice.
  const [lastName, setLastName] = useState(family.last_name ?? family.display_name ?? "");
  const [newChildName, setNewChildName] = useState("");
  const [children, setChildren] = useState(family.children ?? []);
  const [viewingChildId, setViewingChildId] = useState<string | null>(null);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- resync local edit buffer when parent data reloads
  useEffect(() => { setLastName(family.last_name ?? family.display_name ?? ""); setChildren(family.children ?? []); }, [family]);

  function updateChild(id: string, patch: Partial<Child>) {
    setChildren((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  return <article className="family-card">
    <div className="family-card-head">
      <div className="field-row">
        <label>Family name<input value={lastName} onChange={(event) => setLastName(event.target.value)} placeholder="Lewis" /></label>
      </div>
      <button onClick={() => onSaveFamily({ ...family, display_name: lastName, last_name: lastName })}>Save household</button>
    </div>

    {family.family_members?.map((member) => {
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
          {member.profiles?.status !== "removed"
            ? <button className="danger" onClick={() => onRemoveUser(family.id, member.user_id, member.profiles?.display_name || member.profiles?.email || "")}>Remove access</button>
            : <span className="status-pill cancelled">Removed</span>}
        </div>
      </div>;
    })}

    <div className="family-section-divider"><span>Children</span></div>

    {children.map((child) => <div className="child-row" key={child.id}>
      <label>First name<input value={child.first_name} onChange={(event) => updateChild(child.id, { first_name: event.target.value })} /></label>
      <label>Last name<input value={child.last_name ?? ""} onChange={(event) => updateChild(child.id, { last_name: event.target.value, last_name_override: true })} /></label>
      <label className="checkbox-field"><input type="checkbox" checked={child.last_name_override} onChange={(event) => updateChild(child.id, { last_name_override: event.target.checked })} /> Custom name</label>
      <label className="checkbox-field"><input type="checkbox" checked={child.active} onChange={(event) => updateChild(child.id, { active: event.target.checked })} /> Active</label>
      <div className="row-actions"><button onClick={() => setViewingChildId(child.id)}>View</button><button onClick={() => onSaveChild(children.find((row) => row.id === child.id)!)}>Save</button></div>
    </div>)}
    {viewingChildId && <ChildDetail childId={viewingChildId} onClose={() => setViewingChildId(null)} />}

    {compliance.length > 0 && <div className="family-compliance-chips">
      {compliance
        .filter((row) => row.requirements)
        .sort((a, b) => Number(isSettled(a.status)) - Number(isSettled(b.status)))
        .map((row) => <span key={row.id} className={`status-pill ${statusTone(row.status)}`}>
          {row.requirements!.title}: {statusLabel(row.requirements!.kind, row)}
        </span>)}
    </div>}

    <div className="add-child-row">
      <label>Add a child<input value={newChildName} onChange={(event) => setNewChildName(event.target.value)} placeholder="First name" /></label>
      <div className="row-actions"><button onClick={() => { onAddChild(family.id, newChildName); setNewChildName(""); }}>Add child</button></div>
    </div>
  </article>;
}
