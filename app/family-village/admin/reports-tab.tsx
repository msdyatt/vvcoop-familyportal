"use client";

import { ReactNode, useEffect, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { ClassSchedule, formatBlock, SCHEDULE_SELECT } from "../../../lib/schedule";
import { ComplianceStatus, activeAdults, isSettled } from "../../../lib/compliance";
import { printElement } from "../../../lib/dom";

type FamilyReport = {
  id: string; display_name: string; last_name: string | null;
  children: { id: string; active: boolean }[];
  family_members: { user_id: string; profiles: { status: string } | null }[];
};
type RequirementReport = { family_id: string; status: ComplianceStatus; requirements: { kind: string; active: boolean; school_years: { is_current: boolean } | null } | null };
type TeacherLink = { user_id: string; class_id: string };
type ClassReport = {
  id: string; title: string; grades: string[]; active: boolean;
  teacher_assignments: { user_id: string }[];
  enrollments: { child_id: string; status: string }[];
} & ClassSchedule;

export default function ReportsTab() {
  const [families, setFamilies] = useState<FamilyReport[]>([]);
  const [requirements, setRequirements] = useState<RequirementReport[]>([]);
  const [teacherLinks, setTeacherLinks] = useState<TeacherLink[]>([]);
  const [classes, setClasses] = useState<ClassReport[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const supabase = getSupabaseBrowserClient();
      if (!supabase) return;
      const [familyResult, requirementResult, teacherResult, classResult] = await Promise.all([
        supabase.from("families").select("id,display_name,last_name,children(id,active),family_members(user_id,profiles(status))").order("display_name"),
        supabase.from("family_requirements").select("family_id,status,requirements!inner(kind,active,school_years!inner(is_current))").eq("requirements.active", true).eq("requirements.school_years.is_current", true),
        supabase.from("teacher_assignments").select("user_id,class_id,classes!inner(school_years!inner(is_current))").eq("classes.school_years.is_current", true),
        supabase.from("classes").select(`id,title,grades,active,${SCHEDULE_SELECT},teacher_assignments(user_id),enrollments(child_id,status),school_years!inner(is_current)`).eq("active", true).eq("school_years.is_current", true).order("title"),
      ]);
      if (cancelled) return;
      setFamilies((familyResult.data ?? []) as unknown as FamilyReport[]);
      setRequirements((requirementResult.data ?? []) as unknown as RequirementReport[]);
      setTeacherLinks((teacherResult.data ?? []) as TeacherLink[]);
      setClasses((classResult.data ?? []) as unknown as ClassReport[]);
      setLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, []);

  if (loading) return <p>Preparing reports…</p>;

  return <section className="reports-tab">
    <div className="section-heading"><div><p className="card-kicker">Printable reports</p><h2>Take the Village with you.</h2></div><p>Each report is formatted for paper and reflects the portal’s current records.</p></div>
    <PrintableReport title="Family readiness">
      <table><thead><tr><th>Household</th><th>Adults</th><th>Children</th><th>Classes taught</th><th>Dues</th><th>Paperwork</th></tr></thead>
        <tbody>{families.map((family) => {
          const adultIds = new Set(activeAdults(family.family_members).map((member) => member.user_id));
          const familyRequirements = requirements.filter((row) => row.family_id === family.id && row.requirements);
          const unpaid = familyRequirements.filter((row) => row.requirements?.kind === "dues" && !isSettled(row.status)).length;
          const unsigned = familyRequirements.filter((row) => row.requirements?.kind === "document" && !isSettled(row.status)).length;
          const taught = new Set(teacherLinks.filter((link) => adultIds.has(link.user_id)).map((link) => link.class_id)).size;
          return <tr key={family.id}><td>{family.last_name || family.display_name}</td><td>{adultIds.size}</td><td>{family.children.filter((child) => child.active).length}</td><td>{taught}</td><td>{unpaid ? `${unpaid} unpaid` : "Current"}</td><td>{unsigned ? `${unsigned} unsigned` : "Current"}</td></tr>;
        })}</tbody>
      </table>
    </PrintableReport>

    <PrintableReport title="Class readiness">
      <table><thead><tr><th>Meeting time</th><th>Class</th><th>Room</th><th>Teachers</th><th>Students</th><th>Status</th></tr></thead>
        <tbody>{[...classes].sort((a, b) => `${a.class_blocks?.day_of_week ?? 9}${a.class_blocks?.starts_at ?? ""}${a.title}`.localeCompare(`${b.class_blocks?.day_of_week ?? 9}${b.class_blocks?.starts_at ?? ""}${b.title}`)).map((klass) => {
          const teachers = klass.teacher_assignments.length;
          const students = klass.enrollments.filter((entry) => entry.status === "active").length;
          const issues = [teachers < 2 ? "Needs teachers" : "", students === 0 ? "No students" : "", !klass.class_blocks ? "No time" : "", !klass.rooms ? "No room" : ""].filter(Boolean);
          return <tr key={klass.id}><td>{klass.class_blocks ? formatBlock(klass.class_blocks) : "Not scheduled"}</td><td>{klass.title}</td><td>{klass.rooms?.name ?? "—"}</td><td>{teachers}</td><td>{students}</td><td>{issues.join(" · ") || "Ready"}</td></tr>;
        })}</tbody>
      </table>
    </PrintableReport>
  </section>;
}

function PrintableReport({ title, children }: { title: string; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  return <article className="printable-report" ref={ref}>
    <header><div><p>VERITAS VILLAGE</p><h3>{title}</h3></div><button className="no-print" onClick={() => printElement(ref.current)}>Print report</button></header>
    {children}
  </article>;
}
