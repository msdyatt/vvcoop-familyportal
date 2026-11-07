import type { ReportDoc } from "./report-doc";
import { ComplianceStatus, activeAdults, isSettled } from "./compliance";

export type FamilyRow = {
  id: string; display_name: string; last_name: string | null;
  children: { id: string; first_name: string; last_initial: string | null; active: boolean; age_band: string | null }[];
  family_members: { user_id: string; profiles: { display_name: string | null; email: string; phone: string | null; status: string } | null }[];
};

export type RequirementRow = {
  family_id: string; status: ComplianceStatus;
  requirements: { kind: string; title: string } | null;
};

export type TeacherLink = { user_id: string; class_id: string };

const householdName = (family: FamilyRow) => family.last_name || family.display_name;

/** Who has paid and signed, household by household. */
export function buildFamilyReadiness(families: FamilyRow[], requirements: RequirementRow[], teacherLinks: TeacherLink[], yearLabel: string): ReportDoc {
  return {
    title: `${yearLabel} Family Readiness`, landscape: false,
    sections: [{
      columns: [{ label: "Household", weight: 1.6 }, { label: "Adults", weight: 0.7 }, { label: "Children", weight: 0.8 }, { label: "Classes taught", weight: 1 }, { label: "Dues", weight: 1 }, { label: "Paperwork", weight: 1.2 }],
      rows: families.map((family) => {
        const adultIds = new Set(activeAdults(family.family_members).map((member) => member.user_id));
        const own = requirements.filter((row) => row.family_id === family.id && row.requirements);
        const unpaid = own.filter((row) => row.requirements?.kind === "dues" && !isSettled(row.status)).length;
        const unsigned = own.filter((row) => row.requirements?.kind === "document" && !isSettled(row.status)).length;
        const taught = new Set(teacherLinks.filter((link) => adultIds.has(link.user_id)).map((link) => link.class_id)).size;
        return [householdName(family), String(adultIds.size), String(family.children.filter((child) => child.active).length), String(taught), unpaid ? `${unpaid} unpaid` : "Current", unsigned ? `${unsigned} unsigned` : "Complete"];
      }),
    }],
  };
}

/** A contact sheet: adults with their email and phone, and the children in each household. */
export function buildFamilyDirectory(families: FamilyRow[], yearLabel: string): ReportDoc {
  return {
    title: `${yearLabel} Family Directory`, landscape: true,
    sections: [{
      columns: [{ label: "Household", weight: 1.3 }, { label: "Adults", weight: 1.6 }, { label: "Email", weight: 2 }, { label: "Phone", weight: 1.2 }, { label: "Children", weight: 2 }],
      rows: families.map((family) => {
        const adults = activeAdults(family.family_members);
        return [
          householdName(family),
          adults.map((adult) => adult.profiles?.display_name || "").filter(Boolean).join("; "),
          adults.map((adult) => adult.profiles?.email || "").filter(Boolean).join("; "),
          adults.map((adult) => adult.profiles?.phone || "").filter(Boolean).join("; "),
          family.children.filter((child) => child.active).map((child) => `${child.first_name} ${child.last_initial ?? ""}${child.age_band ? ` (${child.age_band})` : ""}`.trim()).join("; "),
        ];
      }),
    }],
  };
}
