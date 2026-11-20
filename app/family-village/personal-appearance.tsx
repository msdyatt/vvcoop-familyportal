"use client";

import { useState } from "react";
import { getSupabaseBrowserClient } from "../../lib/supabase";
import { paletteById } from "../../lib/coop-theme";
import { useCoopTheme } from "../../lib/coop-settings";
import {
  COOP_ACCENT, applyPersonalAccent, applyTextSize, readStoredAccent, readStoredTextSize, savePersonalToAccount,
  type AccentChoice,
} from "../../lib/personal-appearance";
import type { TextSize } from "../../lib/coop-theme";

const NOT_SAVED = "Saved on this device. It could not be saved to your account.";

async function saveToAccount(changes: { accent?: AccentChoice; textSize?: TextSize }): Promise<string> {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return "";
  return (await savePersonalToAccount(supabase, changes)) ? "" : NOT_SAVED;
}

/**
 * The person's accent: the co-op's own colours, or one of the palettes the co-op allows (Admin, Appearance).
 * Applies at once on this device and is kept on the account. Hidden when the co-op offers no choice.
 */
export function PersonalAccentControl() {
  const theme = useCoopTheme();
  const [choice, setChoice] = useState<AccentChoice>(() => readStoredAccent() ?? COOP_ACCENT);
  const [status, setStatus] = useState("");
  const options = theme.personalPalettes.filter((id) => id !== theme.paletteId).map((id) => paletteById(id)).filter((p) => p !== undefined);
  if (!options.length) return null;
  // A palette the co-op no longer offers shows as the co-op's own, which is what the page wears.
  const current = options.some((p) => p.id === choice) ? choice : COOP_ACCENT;

  async function pick(next: AccentChoice) {
    setChoice(next);
    applyPersonalAccent(next, { persist: true });
    setStatus(await saveToAccount({ accent: next }));
  }

  return <>
    <p className="personal-label" id="personal-accent-label">Accent colour</p>
    <div className="personal-accents" role="radiogroup" aria-labelledby="personal-accent-label">
      <button type="button" role="radio" aria-checked={current === COOP_ACCENT} onClick={() => void pick(COOP_ACCENT)}>
        <span className="personal-swatch" style={{ background: theme.accent.accent }} aria-hidden="true" />
        {theme.name}
      </button>
      {options.map((p) => <button key={p.id} type="button" role="radio" aria-checked={current === p.id} onClick={() => void pick(p.id)}>
        <span className="personal-swatch" style={{ background: p.tokens.accent }} aria-hidden="true" />
        {p.label}
      </button>)}
    </div>
    {status && <p className="admin-form-status" role="status">{status}</p>}
  </>;
}

/** Larger text: every font size and line height one step up, on this device and the account. */
export function TextSizeControl() {
  const [size, setSize] = useState<TextSize>(() => readStoredTextSize() ?? "normal");
  const [status, setStatus] = useState("");

  async function pick(next: TextSize) {
    setSize(next);
    applyTextSize(next, { persist: true });
    setStatus(await saveToAccount({ textSize: next }));
  }

  return <>
    <p className="personal-label" id="personal-text-label">Text size</p>
    <div className="theme-choice personal-text" role="radiogroup" aria-labelledby="personal-text-label">
      <button type="button" role="radio" aria-checked={size === "normal"} onClick={() => void pick("normal")}>Standard<small>As designed</small></button>
      <button type="button" role="radio" aria-checked={size === "large"} onClick={() => void pick("large")}>Larger<small>About 15% bigger</small></button>
    </div>
    {status && <p className="admin-form-status" role="status">{status}</p>}
  </>;
}
