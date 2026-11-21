/// <reference lib="deno.ns" />
import { assertEquals, assertMatch } from "jsr:@std/assert@1";
import { chooseForm } from "./tax-form-choice.ts";

const $ = (dollars: number) => dollars * 100;

Deno.test("a three-year-old co-op averaging $50,000 or less files the 990-N", () => {
  const r = chooseForm({ taxYear: 2026, firstTaxYear: 2020, totalAssetsCents: $(20000),
    receipts: [{ year: 2024, cents: $(40000) }, { year: 2025, cents: $(50000) }, { year: 2026, cents: $(60000) }] });
  assertEquals(r.form, "990-N");
  assertMatch(r.steps[0], /2024 \$40,000 \+ 2025 \$50,000 \+ 2026 \$60,000 = \$150,000; ÷ 3 = \$50,000 average/);
  assertEquals(r.cautions, []);
});

Deno.test("one dollar over the average moves it to the 990-EZ test", () => {
  const r = chooseForm({ taxYear: 2026, firstTaxYear: 2020, totalAssetsCents: $(20000),
    receipts: [{ year: 2024, cents: $(40000) }, { year: 2025, cents: $(50000) }, { year: 2026, cents: $(60000) + 300 }] });
  assertEquals(r.form, "990-EZ");
  assertMatch(r.steps.join(" "), /more than \$50,000/);
});

Deno.test("the 990-EZ needs receipts under $200,000 and assets under $500,000", () => {
  const base = { taxYear: 2026, firstTaxYear: 2018, receipts: [{ year: 2024, cents: $(150000) }, { year: 2025, cents: $(150000) }] };
  assertEquals(chooseForm({ ...base, totalAssetsCents: $(499999), receipts: [...base.receipts, { year: 2026, cents: $(199999) }] }).form, "990-EZ");
  assertEquals(chooseForm({ ...base, totalAssetsCents: $(499999), receipts: [...base.receipts, { year: 2026, cents: $(200000) }] }).form, "990");
  assertEquals(chooseForm({ ...base, totalAssetsCents: $(500000), receipts: [...base.receipts, { year: 2026, cents: $(100000) }] }).form, "990");
});

Deno.test("a new co-op uses the first-year and first-two-years limits", () => {
  assertEquals(chooseForm({ taxYear: 2026, firstTaxYear: 2026, totalAssetsCents: null, receipts: [{ year: 2026, cents: $(75000) }] }).form, "990-N");
  assertEquals(chooseForm({ taxYear: 2026, firstTaxYear: 2026, totalAssetsCents: null, receipts: [{ year: 2026, cents: $(75001) }] }).form, "990-EZ");
  const second = chooseForm({ taxYear: 2026, firstTaxYear: 2025, totalAssetsCents: null, receipts: [{ year: 2025, cents: $(50000) }, { year: 2026, cents: $(70000) }] });
  assertEquals(second.form, "990-N");
  assertMatch(second.steps[0], /\(2025 \$50,000 \+ 2026 \$70,000\) ÷ 2 = \$60,000 average, within the \$60,000 limit/);
});

Deno.test("missing figures are flagged, never guessed", () => {
  const r = chooseForm({ taxYear: 2026, firstTaxYear: null, totalAssetsCents: null, receipts: [{ year: 2026, cents: $(30000) }, { year: 2025, cents: null }] });
  assertEquals(r.form, "990-N");
  assertEquals(r.cautions.length, 2); // age unknown, two years missing
  assertMatch(r.cautions[1], /2024 and 2025 are not known/);
  const unknown = chooseForm({ taxYear: 2026, firstTaxYear: 2020, totalAssetsCents: null, receipts: [] });
  assertEquals(unknown.form, "990");
  const noAssets = chooseForm({ taxYear: 2026, firstTaxYear: 2020, totalAssetsCents: null,
    receipts: [{ year: 2024, cents: $(90000) }, { year: 2025, cents: $(90000) }, { year: 2026, cents: $(90000) }] });
  assertEquals(noAssets.form, "990-EZ");
  assertMatch(noAssets.cautions.join(" "), /Total assets at year end are not entered/);
});
