# Writing theme-aware CSS

> The roles below exist as of the tokens PR. The dark values, the Paper rule, the
> contrast test and `lib/theme.ts` arrive in the dark-theme PR that follows. Write
> new CSS with roles now so it is already correct when they land.

The portal has a light and a dark theme. Components do not know which one is
showing. They use **role tokens** (custom properties on `:root` in
`app/globals.css`), and each theme gives every role a value. If you use the
roles, your CSS works in both themes without a second rule.

## The rule

Do not use the brand colours for a text, surface or line role:

| Instead of | Use |
| --- | --- |
| `color: var(--navy)` | `color: var(--text)` |
| `color: var(--sage-text)` | `color: var(--text-muted)` |
| `color: var(--terracotta-text)` | `color: var(--text-accent)` (small text) or `var(--accent-ink)` (large emphasis) |
| `color: var(--terracotta-deep)` on a warm tint | `color: var(--danger-text)` |
| `background: var(--cream)` | `background: var(--canvas)` |
| `background: var(--navy)` on a button, selected tab or chip | `background: var(--action)` |
| `background: var(--navy)` on a band (sidebar, hero panel, toast) | `background: var(--ink-surface)` |
| `background: var(--terracotta-deep)` for an alert | `background: var(--danger-fill)` |
| `background: white` | `background: var(--field-bg)` |
| `rgba(var(--navy-rgb), .18)` for a border, hover wash or track | `rgba(var(--fg-rgb), .18)` |
| `rgba(var(--navy-rgb), .15)` in a `box-shadow` | `rgba(var(--shadow-rgb), .15)` |
| `rgba(var(--navy-rgb), .5)` behind a dialog | `rgba(var(--scrim-rgb), .5)` |
| `border: 1px solid var(--navy)` (strong outline) | `border: 1px solid var(--line-strong)` |
| `outline: 2px solid var(--antique-gold)` | `outline: 2px solid var(--gold)` |

Surfaces that were already roles stay roles: `--surface` (raised card),
`--surface-sunken` (inputs), `--panel` (sage panel), `--warm-tint` (soft
callout).

Never write a hex colour or an `rgba(11,42,61,…)` literal in CSS or in a TSX
`style` prop. If a role is missing, add it to `:root` and to both dark blocks.

## What stays constant

These are the same in both themes, so use them freely **on a surface that is
dark in both themes** (`--ink-surface`, `--action`, `--danger-fill`):

- `var(--cream)`, `white`, `var(--cream-rgb)` as text or hairlines on those fills
- `var(--terracotta-on-navy)` and `var(--sage-on-navy)` as text on those fills

Do not put `--cream` text on `--canvas`, `--surface` or `--panel`: those turn
dark in the dark theme.

## Paper stays light

Documents are paper. A PDF page, the signing overlay, the invitation email
preview and the report sheet keep the light roles inside the dark UI. They do it
by re-declaring the roles on the container (the "Paper" rule in `globals.css`),
so children written with roles stay light with no extra work. A new document-like
surface should be added to that selector list. Print styles (`@media print`) are
always black on white.

User photos and avatars are never recoloured.

## Contrast

`tests/theme-contrast.test.mjs` reads the real token values out of
`globals.css` and checks every listed text/background pair in both themes:
4.5:1 for text, 3:1 for large text and for UI boundaries. If you add a role or a
new pair, add it to the list in that test.

## The dark blocks must match

The dark values appear twice, under `html[data-theme="dark"]` (the choice made
in Settings, applied before first paint by the script in `lib/theme.ts`) and
under `@media (prefers-color-scheme: dark)` (System, and browsers with
JavaScript off). The test asserts the two blocks are identical; edit both.
