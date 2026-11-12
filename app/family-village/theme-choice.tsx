"use client";

import { useState } from "react";
import { getSupabaseBrowserClient } from "../../lib/supabase";
import { applyTheme, currentChoice, THEME_CHOICES, type ThemeChoice } from "../../lib/theme";
import { saveThemeToAccount } from "../../lib/theme-account";

/**
 * Light / Dark / System. The choice applies at once and is kept on this device; if the person is signed in it is
 * also kept on their account, so another phone starts from it (lib/theme.ts). `compact` is the one-line version
 * for the Menu.
 */
export default function ThemeChoiceControl({ compact = false, onChange }: { compact?: boolean; onChange?: (choice: ThemeChoice) => void }) {
  const [choice, setChoice] = useState<ThemeChoice>(() => currentChoice());
  const [status, setStatus] = useState("");

  async function pick(next: ThemeChoice) {
    setChoice(next);
    applyTheme(next, { persist: true });
    onChange?.(next);
    const supabase = getSupabaseBrowserClient();
    if (!supabase) { setStatus(""); return; }
    const saved = await saveThemeToAccount(supabase, next);
    setStatus(saved ? "" : "Saved on this device. It could not be saved to your account.");
  }

  return <>
    <div className="theme-choice" role="radiogroup" aria-label="Appearance">
      {THEME_CHOICES.map((option) => <button
        key={option.value}
        type="button"
        role="radio"
        aria-checked={choice === option.value}
        onClick={() => void pick(option.value)}
      >{option.label}{!compact && <small>{option.hint}</small>}</button>)}
    </div>
    {status && <p className="admin-form-status" role="status">{status}</p>}
  </>;
}
