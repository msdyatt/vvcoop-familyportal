/**
 * Which IRS annual return probably applies, with the arithmetic written out.
 *
 * Guidance only: the IRS rules decide, and a tax professional should confirm. The thresholds
 * are the IRS's own (Form 990-series filing phase-in, and the 990-N "normally $50,000 or less"
 * test):
 *
 *   990-N (e-Postcard)  gross receipts NORMALLY $50,000 or less:
 *                         - in existence 1 year or less: $75,000 or less received (or pledged) in the first year;
 *                         - 1 to 3 years: averaged $60,000 or less over the first two tax years;
 *                         - 3 years or more: averaged $50,000 or less over the 3 tax years ending with this one.
 *   990-EZ              gross receipts under $200,000 AND total assets under $500,000 at year end.
 *   990                 otherwise.
 *
 * Pure functions, no browser or Deno APIs, so lib/tax-form-choice.test.ts can check them.
 */

export type YearReceipts = { year: number; cents: number | null };
export type FormChoiceInput = {
  taxYear: number;
  /** Gross receipts for this year and the years before it (any order). Null = not known. */
  receipts: YearReceipts[];
  /** Total assets at the end of this tax year, or null if not entered. */
  totalAssetsCents: number | null;
  /** The co-op's first tax year, or null if not known. */
  firstTaxYear: number | null;
};
export type FormName = "990-N" | "990-EZ" | "990";
export type FormChoice = {
  form: FormName;
  /** The arithmetic, one line per step, in plain words. */
  steps: string[];
  /** What is missing or uncertain. */
  cautions: string[];
};

export const LIMIT_990N_3YR = 5_000_000;   // $50,000 average over three years
export const LIMIT_990N_2YR = 6_000_000;   // $60,000 average over the first two years
export const LIMIT_990N_1YR = 7_500_000;   // $75,000 in the first year
export const LIMIT_990EZ_RECEIPTS = 20_000_000;  // under $200,000
export const LIMIT_990EZ_ASSETS = 50_000_000;    // under $500,000

export function dollars(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

export function chooseForm(input: FormChoiceInput): FormChoice {
  const steps: string[] = [];
  const cautions: string[] = [];
  const byYear = new Map(input.receipts.map((row) => [row.year, row.cents]));
  const current = byYear.get(input.taxYear) ?? null;
  const age = input.firstTaxYear === null ? null : input.taxYear - input.firstTaxYear + 1;

  if (current === null) {
    cautions.push(`Gross receipts for ${input.taxYear} are not known.`);
    return { form: "990", steps: ["Without this year's gross receipts there is nothing to compare, so the full Form 990 is shown to be safe."], cautions };
  }
  if (age === null) cautions.push("The co-op's first tax year is not entered. The three-year test is used; if the co-op is less than three years old, a different (higher) limit applies.");
  else if (age < 1) cautions.push("The first tax year entered is after this tax year.");

  // --- 990-N ---
  let normallySmall = false;
  if (age !== null && age === 1) {
    normallySmall = current <= LIMIT_990N_1YR;
    steps.push(`First tax year: gross receipts ${dollars(current)} ${normallySmall ? "is" : "is more than"} the $75,000 limit for a new organization${normallySmall ? " or less" : ""}.`);
  } else if (age !== null && age === 2) {
    const first = byYear.get(input.taxYear - 1) ?? null;
    if (first === null) {
      cautions.push(`Gross receipts for ${input.taxYear - 1} (the first tax year) are not known.`);
    } else {
      const avg = Math.round((first + current) / 2);
      normallySmall = avg <= LIMIT_990N_2YR;
      steps.push(`Second tax year: (${input.taxYear - 1} ${dollars(first)} + ${input.taxYear} ${dollars(current)}) ÷ 2 = ${dollars(avg)} average, ${normallySmall ? "within" : "over"} the $60,000 limit for the first two years.`);
    }
  } else {
    const years = [input.taxYear - 2, input.taxYear - 1, input.taxYear];
    const known = years.filter((year) => byYear.get(year) !== null && byYear.get(year) !== undefined);
    const missing = years.filter((year) => !known.includes(year));
    if (missing.length) cautions.push(`Gross receipts for ${missing.join(" and ")} are not known; the average uses ${known.length === 1 ? "one year" : `${known.length} years`} only. Enter the missing years from the bank statements.`);
    const total = known.reduce((sum, year) => sum + (byYear.get(year) ?? 0), 0);
    const avg = Math.round(total / known.length);
    normallySmall = avg <= LIMIT_990N_3YR;
    steps.push(`${known.map((year) => `${year} ${dollars(byYear.get(year) ?? 0)}`).join(" + ")} = ${dollars(total)}; ÷ ${known.length} = ${dollars(avg)} average gross receipts.`);
    steps.push(`${dollars(avg)} is ${normallySmall ? "$50,000 or less" : "more than $50,000"}, so gross receipts are ${normallySmall ? "" : "not "}"normally $50,000 or less".`);
  }
  if (normallySmall) {
    steps.push("So the co-op can probably file the Form 990-N (e-Postcard). It may file a 990-EZ or 990 instead if it prefers.");
    return { form: "990-N", steps, cautions };
  }

  // --- 990-EZ ---
  const receiptsOk = current < LIMIT_990EZ_RECEIPTS;
  steps.push(`This year's gross receipts ${dollars(current)} ${receiptsOk ? "are under" : "are not under"} $200,000.`);
  if (input.totalAssetsCents === null) {
    cautions.push("Total assets at year end are not entered, so the 990-EZ test cannot be finished.");
    if (receiptsOk) {
      steps.push("Total assets are not known. If they were under $500,000 at year end, the 990-EZ probably applies; otherwise the 990.");
      return { form: "990-EZ", steps, cautions };
    }
  } else {
    const assetsOk = input.totalAssetsCents < LIMIT_990EZ_ASSETS;
    steps.push(`Total assets at year end ${dollars(input.totalAssetsCents)} ${assetsOk ? "are under" : "are not under"} $500,000.`);
    if (receiptsOk && assetsOk) {
      steps.push("Both are under the limits, so the Form 990-EZ probably applies (or the full 990, if the co-op prefers).");
      return { form: "990-EZ", steps, cautions };
    }
  }
  steps.push("So the full Form 990 probably applies.");
  return { form: "990", steps, cautions };
}
