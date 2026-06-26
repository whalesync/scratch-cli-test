# design-sync notes — Scratch Design System

Synced to Claude Design project `7b1662a2-9756-4c83-9df8-54b7c7ed1dc8` (replaced the old manual HTML cards). Storybook shape. 23 components: 18 button-family + 5 form controls (inputs).

## How this repo feeds the converter (non-obvious)

- **No real component-library package.** The DS lives inside the Electron renderer, so:
  - Aggregator entry `scratch-desktop/.storybook/ds-entry.ts` re-exports the components + the `@mantine/core` primitives + `SCRATCH_MANTINE_THEME` the stories use.
  - Hand-written declaration surface `scratch-desktop/types/design-system.d.ts` (the app ships no `.d.ts`), pointed at by `scratch-desktop/package.json` `"types"` — `exportedNames` reads the package's declared `types` entry, not a dir scan.
- **Per-component stories** in `src/renderer/src/components/base/ds/*.stories.tsx`: `title` last segment == export name (`Buttons/ButtonPrimarySolid`). Category stories were removed.
- **CSS:** `cfg.cssEntry` = `.storybook/ds-styles.built.css`, a FLATTENED bundle (its content is raw-appended, @imports are NOT resolved). Regenerate when `globals.css` or Mantine changes:
  `<esbuild> scratch-desktop/.storybook/ds-styles.css --bundle --loader:.woff2=empty --loader:.woff=empty --loader:.ttf=empty --loader:.eot=empty --outfile=scratch-desktop/.storybook/ds-styles.built.css`
- **Provider:** `cfg.provider` = MantineProvider + `theme:{$ref:SCRATCH_MANTINE_THEME}`. NOT AppMantineProvider (it pulls @mantine/notifications → a 2nd CJS @mantine/core → broken context).
- **`cfg.storyImports.shim`** = `["renderer/src/components/base", "@mantine/core"]` — forces story imports to the global bundle. WITHOUT this, the story preview re-bundles a 2nd @mantine/core and every preview throws "MantineProvider not found".

## Re-sync risks (watch-list)

- **`ds-styles.built.css` is generated** — if not committed, regenerate it (command above) before a re-sync, or `cfg.cssEntry` errors `not found`.
- **`.storybook/ds-entry.ts` is the export contract** — adding a component requires: declare it in `types/design-system.d.ts`, re-export from `ds-entry.ts` (or rely on `export *`), and add a per-component story with matching title.
- **`[TOKENS_MISSING]` for `--mantine-color-*`** is expected (injected at runtime by MantineProvider) — do not chase.
- **Icon-button stories pass an icon element as `args.children`** (`<Plus />`), not a string.
- **Funnel Display** is loaded in the Storybook (`.storybook/preview.tsx`) but COMMENTED OUT in the app's `src/renderer/src/main.tsx` — the app's headings fall back to Inter. Separate app bug.
- Reference storybook (`.design-sync/sb-reference`) must be rebuilt when stories or DS source change: `cd scratch-desktop && npx storybook build -c .storybook -o <repo-root>/.design-sync/sb-reference`.
- Internal `guidelines/` docs (ipc-api, etc.) were scraped by the converter and deliberately NOT uploaded (set `cfg.docsDir` to exclude them if you want the build to stop emitting them).
