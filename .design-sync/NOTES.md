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

- **WIDE/TALL SCREEN CARDS need a declared `cfg.overrides.<Name>.viewport` AND must not set `maxWidth: '100%'`.** Claude Design frames every card at a default ~330px wide. A fixed-layout screen with `maxWidth: '100%'` self-shrinks to that frame, collapsing any `flex: 1` pane (the WorkspaceShell grid, the RecordDetailView field table, etc.) to ~0 → blank. Fix BOTH: (1) drop `maxWidth: '100%'` from the screen's outer frame (a screen snapshot is fixed-layout, not responsive — `panel-shell.tsx` + the two wide screens); (2) declare the card's render size in `cfg.overrides`, e.g. `"WorkspaceShell": { "viewport": "1240x720" }` (emit.mjs writes it onto the `@dsCard` marker, which sizes the Design System pane's frame). Current screen viewports: WorkspaceShell/RecordDetailView 1240×720/640, the 4 panels 980×600. Every NEW composed screen needs its own viewport entry.
- **REQUIRED FLAG: pass `--storybook-config scratch-desktop/.storybook` to `package-build.mjs`.** This config lives at `.design-sync/config.json` (not the skill's default repo-root `design-sync.config.json`), and the converter resolves `cfg.storybookConfigDir` relative to the config FILE's dir (`package-build.mjs`: `resolve(dirname(CONFIG_PATH), cfg.storybookConfigDir)`), so `scratch-desktop/.storybook` → `.design-sync/scratch-desktop/.storybook` (missing) → "story sources: 0/0 paired" → every component renders the floor card. The `--storybook-config` flag is cwd-relative and takes precedence. Full invocation: `node .ds-sync/package-build.mjs --config .design-sync/config.json --node-modules ./node_modules --storybook-config scratch-desktop/.storybook --entry scratch-desktop/.storybook/ds-entry.ts --out ./ds-bundle`. (node-modules = ROOT/hoisted; entry = the ds-entry.ts source — no DS dist.) Alternative durable fix: relocate config to repo-root `design-sync.config.json`.
- **`MantineProvider` MUST be declared in `types/design-system.d.ts`** (`export declare const MantineProvider`). The converter applies `cfg.provider` only if the provider name is in the exported set it derives from the `.d.ts` (`emit.mjs` / `preview-rebuild.mjs`). It's a runtime re-export in `ds-entry.ts`, but without the `.d.ts` declaration the converter emits `[PROVIDER_UNEXPORTED]` and drops the wrap → every preview renders empty with "MantineProvider was not found". It has no story so it is NOT a card.
- **`ds-styles.built.css` is generated** — if not committed, regenerate it (command above) before a re-sync, or `cfg.cssEntry` errors `not found`.
- **`.storybook/ds-entry.ts` is the export contract** — adding a component requires: declare it in `types/design-system.d.ts`, re-export from `ds-entry.ts` (or rely on `export *`), and add a per-component story with matching title.
- **`[TOKENS_MISSING]` for `--mantine-color-*`** is expected (injected at runtime by MantineProvider) — do not chase.
- **Icon-button stories pass an icon element as `args.children`** (`<Plus />`), not a string.
- **Funnel Display** is loaded in the Storybook (`.storybook/preview.tsx`) but COMMENTED OUT in the app's `src/renderer/src/main.tsx` — the app's headings fall back to Inter. Separate app bug.
- Reference storybook (`.design-sync/sb-reference`) must be rebuilt when stories or DS source change: `cd scratch-desktop && npx storybook build -c .storybook -o <repo-root>/.design-sync/sb-reference`.
- Internal `guidelines/` docs (ipc-api, etc.) were scraped by the converter and deliberately NOT uploaded (set `cfg.docsDir` to exclude them if you want the build to stop emitting them).
