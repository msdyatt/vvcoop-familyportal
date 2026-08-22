"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import ChildDetail from "../child-detail";

type Child = { id: string; first_name: string; last_name: string | null; last_initial: string | null; age_band: string | null; active: boolean; last_name_override: boolean };
type Member = { user_id: string; relationship: string | null; profiles: { email: string; display_name: string | null; status: string; phone: string | null } | null };
type Family = { id: string; display_name: string; last_name: string | null; children: Child[]; family_members: Member[] };

const ASSIGNABLE_ROLES = ["teacher", "admin"];

export default function FamiliesTab({ actorUserId }: { actorUserId: string }) {
  const [families, setFamilies] = useState<Family[]>([]);
  const [roleMap, setRoleMap] = useState<Record<string, string[]>>({});
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
    setStatus(`Saved ${family.display_name}. Children without a custom last name were updated to match.`);
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

  async function removeUser(familyId: string, userId: string, displayName: string) {
    if (!confirm(`Remove ${displayName || "this person"}'s access? Their past posts and notes are kept, but they will no longer be able to sign in to Family Village.`)) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const results = await Promise.all([
      supabase.from("profiles").update({ status: "removed" }).eq("id", userId),
      supabase.from("user_roles").delete().eq("user_id", userId),
      supabase.from("family_members").delete().eq("user_id", userId).eq("family_id", familyId),
    ]);
    const failed = results.find((result) => result.error);
    if (failed?.error) { setStatus(failed.error.message); return; }
    await log("user_removed", "profile", userId, { family_id: familyId });
    setStatus(`${displayName || "That person"} no longer has access.`);
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
      {families.map((family) => <FamilyCard key={family.id} family={family} roleMap={roleMap} onSaveFamily={saveFamily} onSaveChild={saveChild} onAddChild={addChild} onRemoveUser={removeUser} onGrantRole={grantRole} onRevokeRole={revokeRole} />)}
    </div>
  </section>;
}

function FamilyCard({ family, roleMap, onSaveFamily, onSaveChild, onAddChild, onRemoveUser, onGrantRole, onRevokeRole }: {
  family: Family;
  roleMap: Record<string, string[]>;
  onSaveFamily: (f: Family) => void;
  onSaveChild: (c: Child) => void;
  onAddChild: (familyId: string, firstName: string) => void;
  onRemoveUser: (familyId: string, userId: string, displayName: string) => void;
  onGrantRole: (userId: string, role: string) => void;
  onRevokeRole: (userId: string, role: string) => void;
}) {
  const [displayName, setDisplayName] = useState(family.display_name);
  const [lastName, setLastName] = useState(family.last_name ?? "");
  const [newChildName, setNewChildName] = useState("");
  const [children, setChildren] = useState(family.children ?? []);
  const [viewingChildId, setViewingChildId] = useState<string | null>(null);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- resync local edit buffer when parent data reloads
  useEffect(() => { setDisplayName(family.display_name); setLastName(family.last_name ?? ""); setChildren(family.children ?? []); }, [family]);

  function updateChild(id: string, patch: Partial<Child>) {
    setChildren((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  return <article className="family-card">
    <div className="family-card-head">
      <div className="field-row">
        <label>Household name<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
        <label>Family last name<input value={lastName} onChange={(event) => setLastName(event.target.value)} /></label>
      </div>
      <button onClick={() => onSaveFamily({ ...family, display_name: displayName, last_name: lastName })}>Save household</button>
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

    <div className="add-child-row">
      <label>Add a child<input value={newChildName} onChange={(event) => setNewChildName(event.target.value)} placeholder="First name" /></label>
      <div className="row-actions"><button onClick={() => { onAddChild(family.id, newChildName); setNewChildName(""); }}>Add child</button></div>
    </div>
  </article>;
}
