# Writing theme-aware CSS

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
| accent text, a highlight or a chip inside a bubble or button filled with `--action` | `--accent-on-action`, `--wash-on-action`, `--chip-on-action` |

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

## Checking a screen

Switch with Account & security > Appearance (or set `localStorage["vv-theme"]` to
`light`, `dark` or `system` and reload). Look at the screen in both themes at phone
and desktop width. The things that go wrong are: themed text on a fill that does
not change (use a constant like `var(--navy)` there, or a role that is defined for
that fill), a hex colour or `rgba(11,42,61,…)` that slipped in, and text on a
translucent surface. `tests/theme-contrast.test.mjs` catches wrong token values,
not wrong placement, so a quick look is still needed.

## Co-op theme (issue #140)

Each co-op can dress the portal in its own name, logos, accent and heading font. Admin, Appearance edits it;
everything is a draft until Save, with the light and the dark theme previewed side by side.

**Where it lives.** One row, `public.coop_settings` (migration `20261120090000_coop_settings.sql`). Anyone can
read it, signed in or not, because the sign-in page shows the name and logo. It is written only through
`admin_save_coop_settings`, `admin_set_coop_logo` and `admin_reset_coop_appearance`, which require an
administrator who is not a reviewer account and has used their second factor. Logos go to the public bucket
`coop-brand` (PNG, JPEG or WebP, up to 1 MB, in the four slot folders); only those administrators can write there.

**What a co-op can change.** Only the accent family: ten colours, set as brand-level custom properties
(`lib/coop-theme.ts`, `ACCENT_VARS`): `--terracotta`, `--terracotta-text`, `--terracotta-on-navy`, `--accent-deep`,
`--accent-tint`, `--accent-tint-ink`, `--accent-night`, `--accent-night-fill`, `--accent-night-tint`,
`--accent-night-tint-ink`. The roles in both themes read these, so a palette never deals with light and dark
itself, and the dark blocks never redefine them. Ink (navy), cream, the surfaces, the focus gold and every alert
or error colour (`--danger-*`, `--terracotta-deep`, `--warm-tint`) are not part of it. Alert and destructive
outlines use `--danger-line`, a fixed terracotta, not `--terracotta`. If you write a new alert style, use the
`--danger-*` roles; the contrast test fails if an alert role starts following the palette.

**Palettes.** A short ready-made list (Veritas terracotta first), or any colour the admin types. For a typed colour,
the colour itself is used for rules and large headings and the other nine are generated from its hue
(`generateAccent`, in OKLCH), each the nearest shade that clears its checks. Every palette is checked against the
backgrounds it is drawn on (`ACCENT_CHECKS`: 4.5:1 for text, 3:1 for lines, marks and large text). A palette that
fails is refused with the reason in plain words, in the screen and again in the database
(`private.coop_accent_problems`, the same list). Only the typed colour itself can fail (too pale for the light page,
too dark for the dark one); the screen offers the nearest shade that works.

**Heading font.** Playfair Display (hosted), Georgia, a book serif (Palatino/Iowan) or the plain sans. Nothing is
downloaded from a third party. It sets `--serif`.

**Logos.** `app/coop-logo.tsx` draws the lockup or the compact mark as a background from `--coop-lockup-light`,
`--coop-lockup-dark`, `--coop-mark-light`, `--coop-mark-dark` (defaults: the files in `public/brand`), with the
lockup's shape in `--coop-lockup-ratio`. `BrandLockup` is a thin wrapper. Use `CoopLogo` for any new logo; do not
put an `<img src="/brand/lockup...">` in a page.

**Before first paint.** The device keeps the last theme in `localStorage["vv-coop"]`. `COOP_SCRIPT` (in the head,
after the light/dark script) sets the custom properties from it before anything paints; an accent is applied whole
or not at all, logos only from the brand bucket. `CoopThemeSync` (root layout) fetches the row once per page load,
refreshes the copy and tells the iPhone frame (`coopTheme` bridge message). With nothing cached (a first visit) the
stylesheet's defaults show until the fetch returns. Components read the name and contact with `useCoopTheme()` /
`useCoopName()`.

**Elsewhere.** Emails take the name, light logo, accent rule and button from the row (`supabase/functions/_shared/
coop-brand.ts`). The installed app's manifest is served at `/app.webmanifest` by the Worker with the co-op's name
(`worker/manifest.ts`; `public/manifest.webmanifest` is the template, icons unchanged). The iPhone frame recolours
its header rule, selection, dark buttons and Messages accents, and keeps the palette for the next launch; a change
fully shows on the next launch (the header redraws at once). Its logo artwork is still the bundled one.

**Tests.** `tests/theme-contrast.test.mjs` runs the full token pair list over every ready-made palette and over 100+
generated ones, checks the Veritas palette matches the stylesheet and the database default, and that no alert, ink
or background role follows the palette. `tests/coop-theme.test.mjs` runs the head script and the manifest route.
`supabase/tests/database/032_coop_settings.test.sql` covers who may read and write, the refusals and the bucket.

## Personal appearance (issue #140, part 2)

Account settings, Appearance has three choices, each person's own:

- **Light, Dark or System** (as before, `lib/theme.ts`).
- **Accent colour**: the co-op's own, or one of the ready-made palettes the co-op offers (Admin, Appearance,
  "Colours members may choose"; `coop_settings.personal_palettes`, set by `admin_set_personal_palettes`). Only
  ready-made palettes can be offered, because each has passed every contrast check. The section is hidden when the
  co-op offers none. A palette the co-op stops offering falls back to the co-op's own, on every device, at once.
- **Text size**: Standard or Larger. Larger multiplies every font size and line height by 1.15 (`--text-scale` in
  `app/appearance.css`). The stylesheets write sizes in pixels, so a build step (`scripts/postcss-text-scale.mjs`,
  in `postcss.config.mjs`) rewrites each pixel value in `font`, `font-size` and `line-height` to
  `calc(<px> * var(--text-scale, 1))`. Spacing, borders and icons do not change. Inline `fontSize` in TSX is not
  scaled; prefer CSS. In the iPhone app the web pages scale the same way and the native Messages screens take at least
  one step larger Dynamic Type (`appearance` bridge message).

Storage follows the Light/Dark rule: the device keeps the choice (`localStorage` `vv-accent`, `vv-text-size`) and the
account keeps it too (`user_nav_prefs.prefs.accent`, `.textSize`). A choice made on this device wins; a device never
set adopts the account's when the tab bar loads the person's record. `COOP_SCRIPT` applies both before the first
paint (larger text even before the co-op settings are cached).

Tests: `tests/coop-theme.test.mjs` (the head script with personal choices, the database's palette list),
`tests/text-scale.test.mjs` (the build step, and no fixed pixel font size left in the built CSS),
`supabase/tests/database/033_personal_palettes.test.sql`.

## Seasonal logos (issue #140 part 3, issue #110)

Plumbing only: no artwork is made here. Admin, Appearance, "Seasonal logos" lists variants of the logo and adds,
edits or removes them. Each has a name, a start and end day, "every year" (the year is ignored and the range may run
over New Year), "when it shows" (between the dates, now whatever the date, or not at all) and any of the four logo
files (lockup and compact mark, for light and dark grounds), stored in `coop-brand` under `seasonal/`.
Table `public.coop_logo_variants`, written only through `admin_save_logo_variant` and `admin_delete_logo_variant`
(same admin checks as the settings), readable by everyone. At most 24.

**Which one shows.** `activeVariant` (lib/coop-theme.ts): a variant turned on wins (the most recently changed of
them); otherwise the dated variant whose range holds today, the shortest range first, then the most recently
changed. "Today" is the co-op's date (`coopToday`, America/Chicago for now; it belongs in the settings when the
portal serves other co-ops, #139). The variant's files replace the matching slots; empty slots, and every slot when
no variant is in force, show the co-op's own logo (and, without that, the bundled Veritas Village files). The head
script carries `activeVariant`'s own source, so the page before and after first paint pick the same one; the change
at midnight shows on the next page load.

**Where it shows.** Everywhere `CoopLogo` draws the logo: the header (light, dark and the Admin band), the sign-in
page, the public pages' header, the Office inbox empty state. The browser tab's icon becomes the variant's light
compact mark while it is in force. Emails keep the co-op's own logo.

**What does not change, and why.**
- Installed web app (home-screen icon, splash): the manifest's icons are read when the app is installed and are not
  re-read on a schedule, so a season cannot reach them.
- Android app: the launcher icon comes from the app's resources. Activity aliases could switch between bundled icons,
  but that needs the art in the build.
- iPhone app: iOS can switch to an alternate app icon (`UIApplication.setAlternateIconName`), but only to icons
  bundled in the app (declared under `CFBundleIcons` > `CFBundleAlternateIcons` in Info.plist, with the image sets in
  the asset catalog), and the system shows the person an alert each time it changes. So each seasonal icon has to be
  designed, added to the asset catalog, shipped in an App Store update, and switched by the frame from a bridge message
  (the page knows which variant is in force). Not built here. The native header's logo and the splash also still use
  the bundled art; downloading the uploaded file in the frame is the step that would bring seasonal lockups there.
