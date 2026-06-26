# Scratch Design System — how to build with it

These are real, compiled Scratch components (built on Mantine). Use them as-is; do not re-style
the controls themselves. Style your own layout glue with Mantine props + the design tokens below.

## Styling idiom — Mantine props, not utility classes

There is **no utility-class vocabulary**. Style via:

- **Mantine component props** on layout primitives — `Stack`/`Group` with `gap`, `Box`/`Text` with
  `p`/`m`/`c`/`bg`/`fz`/`fw`. Sizes use the spacing scale tokens (`gap="md"`, `p="sm"`).
- **CSS custom-property tokens** (available on every element) for color. Reference them with
  `var(--token)` in inline styles or your own CSS.

**Brand accent (use sparingly — one per view):** `--highlight-fill` (#FEFB8A), `--highlight-border`
(#D4C800), `--highlight-text` (#000), `--highlight-fill-hover` (#F5F542). This yellow is the only
saturated accent; reserve it for the primary action and "live edit" emphasis.

**Surfaces & text:** `--bg-base`, `--bg-panel`, `--bg-selected`; `--fg-primary`, `--fg-secondary`,
`--fg-muted`, `--fg-divider`.

**Review-state palette** (the product's published→approved→local system — kind × stage): pair a wash
with a stroke from `--{modified,create,delete}-{needs-review,approved}-{bg,stroke}` (e.g.
`--modified-needs-review-bg` + `--modified-needs-review-stroke`). Use a 4px left rail in the stroke
over the bg wash to mark an edited/created/deleted row.

**Spacing scale** (Mantine): `2xs`=4 `xs`=8 `sm`=12 `md`=16 `lg`=24 `xl`=32.
**Radius:** default is **0 (square)**; opt into `xs`=4 `sm`=6 `md`=8 `lg`=10 only for menus/popovers/avatars.
**Type:** Funnel Display (headings), Inter (body, weights 375/425/475), Geist Mono (code, table headers, keys, IDs).
**Signature detail:** outlined controls draw an L-bracket at each corner (the "corner-bracket" border).

## Picking a component

- **Actions:** `ButtonPrimarySolid` / `ButtonPrimaryLight` (yellow, one per view); `ButtonSecondarySolid`
  / `ButtonSecondaryOutline` / `ButtonSecondaryGhost` / `ButtonSecondaryInline`; `ButtonDangerLight`
  (discard/remove); `ButtonCompact{Primary,Secondary,Danger}` (22px, dense toolbars/sidebars);
  `DevToolButton` / `DevToolButtonGhost` (violet, developer-only); `IconButton{Outline,PrimaryOutline,Ghost,Inline,Toolbar}`
  (icon-only — pass an icon element as children); `ButtonWithDescription` (title + description).
- **Form controls:** `Checkbox`, `Switch` (yellow checked/on), `TextInput`, `Textarea`, `Select`.

## Where the truth lives

Read the bound `styles.css` (Mantine base styles + Scratch globals — every token above is defined there)
and each component's `<Name>.d.ts` (props) and `<Name>.prompt.md` (usage) before building.

## Example

```tsx
<Stack gap="md">
  <TextInput label="Workspace name" defaultValue="Marketing site" />
  <Checkbox label="Include schema files in publish" defaultChecked />
  <Group justify="flex-end" gap="sm">
    <ButtonSecondaryGhost>Cancel</ButtonSecondaryGhost>
    <ButtonPrimarySolid>Publish changes</ButtonPrimarySolid>
  </Group>
</Stack>
```
