# Scratch Design System (Claude Design bundle)

A codified snapshot of the Scratch UI as standalone HTML **preview cards**, used to sync our
design language into a [Claude Design](https://support.claude.com/en/articles/14604416-get-started-with-claude-design)
project via the `/design-sync` skill. When designing in Claude Design, these cards let Claude
build with our actual components instead of generic defaults.

## Source of truth

These cards are **derived from**, not a replacement for, the live code. The canonical design
system lives in the desktop renderer:

- `scratch-desktop/src/renderer/src/theme/` — `theme.ts`, `custom-colors.ts`, `globals.css`, `theme.module.css`
- `scratch-desktop/src/renderer/src/components/base/` — `buttons.tsx`, `text.tsx`
- `scratch-desktop/src/renderer/src/components/theme/custom-borders.module.css` — the signature corner-bracket border

The web client carries a parallel written spec at `client/src/app/components/UI_SYSTEM.md`.

When the theme or a base component changes, update the matching card here and re-sync.

## Layout

```
design-system/
├── foundations/   colors · typography · spacing-and-radius
└── components/    buttons · inputs · menus · overlays · data-display · review-states
                   tabs-and-segmented · progress-and-loading · folder-tree
                   field-diff · connector-icons · empty-states
```

Each `.html` is fully self-contained (inline CSS, web fonts from Google Fonts) and its **first
line** is a card marker the Design System pane indexes on:

```html
<!-- @dsCard group="Components" name="Buttons" subtitle="..." -->
```

## Re-syncing to Claude Design

Run `/design-sync` from Claude Code (the skill is user-invoked). It diffs this directory against
the **"Scratch Design System"** project and pushes changes incrementally — one card at a time,
never a wholesale replace. Add a component by dropping a new `@dsCard` HTML file in
`components/` and re-running the sync.
