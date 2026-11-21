/**
 * The year-end tax summary as data: the shape admin_tax_summary() returns, the 990-N checklist,
 * and the report (lib/report-doc.ts) the screen, the CSV and the PDF all come from.
 */
import type { ReportDoc } from "./report-doc";
import { chooseForm, dollars, type FormChoice } from "./tax-form-choice";

export type Fact = { label: string; value: string | null; has_value: boolean; sensitive: boolean };
export type TaxSummary = {
  tax_year: number; first_day: string; last_day: string; fiscal_year_end_month: number; billing_test_mode: boolean;
  dues_online_cents: number; dues_offline_cents: number; refunds_cents: number;
  other_income: { id: string; received_on: string; amount_cents: number; kind: string; description: string; note: string | null }[];
  other_income_cents: number; gross_receipts_cents: number;
  expenses: { category: string; cents: number; count: number }[]; expenses_cents: number; net_cents: number;
  years: { year: number; first_day: string; last_day: string; portal_cents: number; override_cents: number | null; used_cents: number; has_portal_records: boolean }[];
  total_assets_cents: number | null; inputs_note: string | null;
  nec_threshold_cents: number; nec_threshold_certain: boolean;
  payees: { payee: string; cents: number; count: number; categories: string[] }[];
  facts: Record<string, Fact>;
};
export type CheckItem = { label: string; value: string; ok: boolean; optional?: boolean; note?: string };

export const NOT_ADVICE = "This summary is guidance from the co-op's own records, not tax advice. The IRS rules decide which return applies, and a tax professional should confirm it before anything is filed.";
export const THREE_YEARS = "An organization that does not file its required annual return (990-N, 990-EZ or 990) for three consecutive years automatically loses its tax-exempt status.";
export const E_POSTCARD_SOURCE = "https://www.irs.gov/charities-non-profits/information-needed-to-file-e-postcard";
export const FORM_CHOICE_SOURCE = "https://www.irs.gov/charities-non-profits/form-990-series-which-forms-do-exempt-organizations-file-filing-phase-in";

const KIND: Record<string, string> = { donation: "Donation", fundraiser: "Fundraiser", grant: "Grant", other: "Other" };

function day(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function periodLabel(s: Pick<TaxSummary, "first_day" | "last_day">): string {
  return `${day(s.first_day)} to ${day(s.last_day)}`;
}

/**
 * The IRS names a return by the year the tax year BEGINS, so a July-to-June year ending in 2027
 * goes on the 2026 form.
 */
export function formYear(s: Pick<TaxSummary, "first_day">): number {
  return Number(s.first_day.slice(0, 4));
}

export function formChoiceFor(s: TaxSummary): FormChoice {
  const firstYear = Number(s.facts.year_formed?.value ?? "");
  return chooseForm({
    taxYear: s.tax_year,
    receipts: s.years.map((row) => ({ year: row.year, cents: row.override_cents ?? (row.has_portal_records ? row.portal_cents : null) })),
    totalAssetsCents: s.total_assets_cents,
    firstTaxYear: Number.isInteger(firstYear) && firstYear > 1900 ? firstYear : null,
  });
}

/** What the 990-N (e-Postcard) asks for, filled from the settings and the records vault. */
export function ePostcardChecklist(s: TaxSummary, choice: FormChoice): CheckItem[] {
  const fact = (key: string) => s.facts[key];
  const value = (key: string, missing = "Missing: add it in the records vault key facts") => fact(key)?.has_value ? String(fact(key)?.value ?? "") : missing;
  return [
    { label: "Legal name (exactly as on the IRS letter)", value: value("legal_name"), ok: !!fact("legal_name")?.has_value },
    { label: "EIN", value: fact("ein")?.has_value ? `${fact("ein")?.value} (reveal to see it in full; that is logged)` : "Missing: add it in the records vault key facts", ok: !!fact("ein")?.has_value },
    { label: "Mailing address", value: value("address"), ok: !!fact("address")?.has_value },
    { label: "Other names the co-op uses", value: "Any name used besides the legal name (for example, \"Veritas Village\")", ok: true, optional: true, note: "Check" },
    { label: "Website", value: fact("website")?.has_value ? String(fact("website")?.value) : "None entered (leave blank on the form if there is none)", ok: true, optional: true },
    { label: "Principal officer's name", value: value("principal_officer_name"), ok: !!fact("principal_officer_name")?.has_value },
    { label: "Principal officer's address", value: value("principal_officer_address"), ok: !!fact("principal_officer_address")?.has_value },
    { label: "Tax year", value: `${periodLabel(s)} (the ${formYear(s)} form)`, ok: true },
    { label: "Gross receipts normally $50,000 or less", value: choice.form === "990-N" ? "Yes, by the arithmetic above" : "No: the 990-N probably does not apply", ok: choice.form === "990-N" },
    { label: "Has the co-op ended (terminated)?", value: "Normally no", ok: true, optional: true },
  ];
}

export function buildTaxSummaryDoc(s: TaxSummary, coopName: string): ReportDoc {
  const choice = formChoiceFor(s);
  const checklist = ePostcardChecklist(s, choice);
  return {
    title: `${coopName}: year-end tax summary`,
    subtitle: `${periodLabel(s)}. ${NOT_ADVICE}`,
    landscape: false,
    sections: [
      {
        heading: "Summary",
        columns: [{ label: "Item", weight: 3 }, { label: "Amount", weight: 1 }],
        rows: [
          ["Dues collected online (Stripe)", dollars(s.dues_online_cents)],
          ["Dues collected offline (cash, check, Crowded, other)", dollars(s.dues_offline_cents)],
          ["Other income (donations, fundraisers, grants)", dollars(s.other_income_cents)],
          ["Gross receipts", dollars(s.gross_receipts_cents)],
          ["Refunds", dollars(-s.refunds_cents)],
          ["Expenses", dollars(-s.expenses_cents)],
          ["Net", dollars(s.net_cents)],
          ["Total assets at year end (entered by hand)", s.total_assets_cents === null ? "Not entered" : dollars(s.total_assets_cents)],
          ...(s.billing_test_mode ? [["Note", "Billing is in test mode: these figures include test payments."]] : []),
        ],
      },
      {
        heading: "Other income",
        columns: [{ label: "Date", weight: 1 }, { label: "Kind", weight: 1 }, { label: "Description", weight: 3 }, { label: "Amount", weight: 1 }],
        rows: s.other_income.length ? s.other_income.map((row) => [row.received_on, KIND[row.kind] ?? row.kind, row.description, dollars(row.amount_cents)]) : [["", "", "None entered", ""]],
      },
      {
        heading: "Expenses by category",
        columns: [{ label: "Category", weight: 3 }, { label: "Entries", weight: 1 }, { label: "Amount", weight: 1 }],
        rows: s.expenses.length ? s.expenses.map((row) => [row.category, String(row.count), dollars(row.cents)]) : [["None recorded", "", ""]],
      },
      {
        heading: "Gross receipts, three years",
        columns: [{ label: "Year", weight: 1 }, { label: "Period", weight: 3 }, { label: "From the portal", weight: 1 }, { label: "Entered by hand", weight: 1 }, { label: "Used", weight: 1 }],
        rows: [...s.years].sort((a, b) => a.year - b.year).map((row) => [String(row.year), periodLabel(row), dollars(row.portal_cents),
          row.override_cents === null ? "" : dollars(row.override_cents), row.override_cents === null && !row.has_portal_records ? "Not known" : dollars(row.used_cents)]),
      },
      {
        heading: `Which return probably applies: Form ${choice.form}`,
        columns: [{ label: "Working", weight: 1 }],
        rows: [...choice.steps.map((step) => [step]), ...choice.cautions.map((caution) => [`Check: ${caution}`]), [NOT_ADVICE], [`Source: ${FORM_CHOICE_SOURCE}`]],
      },
      {
        heading: "Form 990-N (e-Postcard) checklist",
        columns: [{ label: "Asked for", weight: 2 }, { label: "From the portal", weight: 3 }, { label: "Ready", weight: 1 }],
        rows: [...checklist.map((item) => [item.label, item.value, item.ok ? "Yes" : "Missing"]), ["Source", E_POSTCARD_SOURCE, ""]],
      },
      {
        heading: `Payees who may need a Form 1099-NEC (${s.tax_year} calendar year, ${dollars(s.nec_threshold_cents)} or more)`,
        columns: [{ label: "Payee (as entered on expenses)", weight: 2 }, { label: "Categories", weight: 2 }, { label: "Payments", weight: 1 }, { label: "Total", weight: 1 }],
        rows: [
          ...(s.payees.length ? s.payees.map((row) => [row.payee, row.categories.join(", "), String(row.count), dollars(row.cents)]) : [["None reached the threshold", "", "", ""]]),
          ["Only payments for services to a person or unincorporated business count, not employees, corporations (usually), or payments made by card or a payment app. Check each one and collect a W-9.", "", "", ""],
          ...(s.nec_threshold_certain ? [] : [["The threshold after 2026 is adjusted for inflation: check the current IRS instructions.", "", "", ""]]),
        ],
      },
      {
        heading: "Why it matters",
        columns: [{ label: "", weight: 1 }],
        rows: [[THREE_YEARS]],
      },
    ],
  };
}
