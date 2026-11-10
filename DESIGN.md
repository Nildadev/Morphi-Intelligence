# Morphi Design System

Portable design rules for AI-assisted UI work in this repository.

This file is the single source of truth for **design rules and token intent**. Numeric
values live in [`client/src/index.css`](client/src/index.css); do not keep a second copy of
them here. When generating or editing UI, follow this file before inventing new visual
rules.

> **Provenance.** The structure of this document, the `text-ui-*` scale, and several
> constraints below are adapted from the ZCode design system
> (<https://github.com/zai-org/ZCode>, `DESIGN.md` and `packages/ui/src/styles.css`),
> licensed under the Apache License 2.0. See [`NOTICE.md`](NOTICE.md). Morphi's own token
> names, colour values, and contrast requirements are **not** taken from ZCode — they are
> measured in [`client/tests/tokens.test.ts`](client/tests/tokens.test.ts) and enforced by
> [`client/src/components/layout/tokens.test.ts`](client/src/components/layout/tokens.test.ts).

---

## Highest-priority UI constraint: the `text-ui-*` scale

Application interface typography uses the dedicated scale only:

| Utility | Computed size | Role |
| --- | --- | --- |
| `text-ui-xl` | `--ui-font-size + 4px` | Rare hero/empty-state heading |
| `text-ui-lg` | `--ui-font-size + 2px` | Section or modal title |
| `text-ui-base` | `--ui-font-size` | Body / primary UI text |
| `text-ui-caption` | `--ui-font-size - 1px` | Secondary metadata |
| `text-ui-sm` | `--ui-font-size - 2px` | Dense list rows, sidebar entries |
| `text-ui-xs` | `--ui-font-size - 4px` | Micro labels, counts, timestamps |
| `text-ui-2xs` | `--ui-font-size - 5px` | **Exception scale** — workflow-axis labels only, never content |
| `text-ui-settings-title` / `lg:text-ui-settings-title-lg` | `+10px` / `+16px` | Settings section headings only |

Rules:

- **Do not** introduce Tailwind's built-in `text-sm` / `text-base` / `text-xs` for application
  UI. (`text-sm` remains acceptable inside legacy button recipes until they are migrated;
  new code must not add it.)
- **Do not** introduce arbitrary sizes such as `text-[13px]` or inline `font-size` values.
- The only content-level exceptions are **code, diff, and terminal rendering**, which consume
  their own numeric font-size settings. Their surrounding controls, labels, headers, and
  metadata still use `text-ui-*`.
- Never implement interface font scaling by changing `html` or
  `document.documentElement.style.fontSize`. Update only `--ui-font-size`.
- Mobile web editable inputs that must prevent iOS focus zoom use the fixed
  `text-mobile-input-safe` (16px). It is a compatibility token, not a hierarchy level.

Treat violations of this section as **design-system defects**, not stylistic preferences.

### Migration status (honest, not aspirational)

The scale is **declared and enforced for new code**; the existing call sites are not yet
migrated. `client/src` currently contains ~176 arbitrary `text-[Npx]` literals and 16
built-in size utilities. They render exactly as before and are not broken — they are
**debt**, and each one is a candidate for a mechanical mapping:

```
text-[15px] → text-ui-base      text-[13px] → text-ui-sm
text-[14px] → text-ui-base      text-[12px] → text-ui-xs
text-[16px] → text-ui-lg        text-[11px] → text-ui-xs
```

Do not perform a blind repo-wide replacement: line-heights differ per site and several
sizes are content-level (markdown headings, code blocks) where the scale does not apply.

---

## Product character

Morphi is a desktop-first AI workspace for Roblox development. The interface should feel
**calm, dense, and operational** rather than decorative.

Design for:

- long agent sessions with tool output
- high information density without crowding
- readable chat, tool cards, and code
- keyboard-driven workflows
- desktop (Electron) and dev-browser parity
- Windows, macOS, and Linux
- Vietnamese and English text of variable length
- light and dark themes, following the user's OS on first run

Avoid:

- oversized marketing-style spacing
- playful gradients as the default UI language
- bright full-surface brand fills
- ambiguous hierarchy between background, card, and popover surfaces

---

## Colour rules (Morphi-specific, already enforced)

These are **stricter than ZCode's** and must not be relaxed by copying ZCode values:

1. Every text token must clear **≥ 4.5:1** against every surface it ships on, in **both**
   themes. Measured from the real hex in `index.css` by `client/tests/tokens.test.ts`.
2. `--accent` is a **background/icon** colour. Accent-coloured *text* must use
   `text-brand-text`. Raw accent on white is ~3.2:1 and fails.
3. No `opacity-*` on text, and no `text-<color>/<NN>` opacity modifiers — both drop glyphs
   below AA. Disabled CTAs use the tokenised `--btn-disabled-bg` / `--btn-disabled-fg` pair.
4. Status colours go through the `--color-*-text` / `--color-*-bg` pairs, never raw
   `green-600` / `red-500` scales.
5. No palette literals as text: `text-white`, `text-black`, `text-[#hex]` are banned.
6. Fenced code keeps **one dark surface in both themes** (`--code-surface`), because the
   shipped syntax palette is designed for it.

Full rule text and the class scanner: `client/src/components/layout/tokens.test.ts`.

---

## Theme modes

- The theme is a class on `<html>` (`.dark`), **not** the OS preference media query. Tailwind's
  `dark:` variant is re-registered against that class in `index.css`.
- `useTheme` owns the class; `useSystemAccent` supplies the Windows accent for the titlebar.
- Both themes must be verified for every surface: chat, tool cards, settings, modals,
  approval dialogs, and empty states.

---

## Motion

- Default transitions are short (`--motion-fast` 150ms, `--motion-base` 200ms).
- `prefers-reduced-motion: reduce` disables shimmer and clamps all transitions/animations to
  0.01ms via one universal rule in `index.css`. That rule is asserted, not just written.
- Never animate text colour to `transparent` or clip a gradient to `currentColor` — the
  text becomes invisible in one or both themes.

---

## Layout invariants

- `--rail-width` (52px) is the **only** place the rail width is written. Components read it
  back via `var(--rail-width)`.
- The chat content column is 730px; do not widen it per-component.
- Focus indication is a 2px accent ring (`:focus-visible`), non-text so 3:1 suffices.

---

## Transcript layout

A finished assistant turn reads top-to-bottom as **process → answer → outcome**:

1. **Worked block (process)** — the collapsed `Đã làm trong 12s` row that expands into thinking,
   the interleaved spoken narrative, and one compact tool card per call. It is pinned to the
   row that also carries the turn's conclusion text, so it always sits above the answer.
2. **Answer text** — the final assistant text, rendered from `message.steps`.
3. **Changed-files block (outcome)** — the collapsed `N tệp thay đổi +A −D` row rendered after
   the answer, before the copy/regenerate footer. Expanding it shows one diff card per file
   (path, churn, status, then hunk rows).

Rules:

- A diff is rendered in **exactly one place**: the expanded changed-files block. Edit tool calls
  inside the worked block are compact process rows (icon, tool label, path, churn, status) with
  no hunks and no args/source dump, so the same change is never painted twice.
- The changed-files block is collapsed by default, inert while the turn is live, and absent on
  intermediate rows (`hideActivity`) and on turns that wrote nothing.
- Diff rows use **one gutter**: a `del` row prints its old line number, an `add`/`eq` row prints
  its new one. Two gutters made unchanged rows show two different numbers side by side, which
  reads as duplicated data.
- `diffLines` drops exactly the one empty element a terminating newline produces before diffing;
  a genuine interior or trailing blank line is still a line. The renderer never filters rows.

---

## Working with the design system

When asked to build or restyle UI:

1. Read this file, then `client/src/index.css`.
2. Reuse an existing token or scale level. Inventing a new hex or px value is the last resort
   and requires a measured justification.
3. Add or update a test when the change is a **rule** (contrast pair, banned class, scale
   mapping) — not when it is a one-off layout tweak.
4. Verify both themes and the reduced-motion path in a real browser before claiming done.
