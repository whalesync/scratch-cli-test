// Hand-authored declaration surface for /design-sync's converter. Our design-system components
// are `Button.withProps(...)` wrappers with no built .d.ts, so this file declares each public
// component with a clean props type the converter can read (export list + prop contracts for the
// generated <Name>.d.ts / <Name>.prompt.md). Names MUST match the runtime exports in
// .storybook/ds-entry.ts and the story titles' last segment.
import type {
  ButtonProps,
  CheckboxProps,
  SelectProps,
  SwitchProps,
  TextareaProps,
  TextInputProps,
} from '@mantine/core';
import type { ComponentPropsWithoutRef, FC, ReactNode } from 'react';

/** Props shared by every button-family component: Mantine ButtonProps plus native button attrs. */
type DSButtonProps = ButtonProps & Omit<ComponentPropsWithoutRef<'button'>, keyof ButtonProps>;

// Declared only so /design-sync's converter recognizes `cfg.provider`'s MantineProvider as a bundle
// export (it derives the export set from this .d.ts). Has no story, so it is NOT a Design System card —
// it just lets the converter wrap every preview in the Mantine theme provider.
export declare const MantineProvider: FC<{ children?: ReactNode; defaultColorScheme?: string; theme?: unknown }>;

// ── Composed screens (faithful reproductions of whole app surfaces) ──────────────
/**
 * The main workspace screen — the desktop app's hero surface: the top toolbar, the connector folder
 * tree, and the data grid for the selected folder, with rows mid-review showing the review-state
 * coloring (needs-review / approved) and word-diffed changed cells. Self-contained; takes no props.
 */
export declare const WorkspaceShell: FC;
/** The Connections right-rail panel: connected services and their synced folders. No props. */
export declare const ConnectionsPanel: FC;
/** The Validation right-rail panel: per-folder enforce_schema problems, Problems/Rules tabs. No props. */
export declare const ValidationPanel: FC;
/** The Publish History right-rail panel: the log of publish plans/runs (empty state). No props. */
export declare const PublishHistoryPanel: FC;
/** The Workspace Settings right-rail panel: auto-update toggle + workspace permissions. No props. */
export declare const SettingsPanel: FC;
/** The single-record inspector overlay: record navigator + FIELD/CURRENT/NEW field table. No props. */
export declare const RecordDetailView: FC;
/** Publish modal — review/approval stage: validation + unreviewed notices, accept/discard. No props. */
export declare const PublishReviewModal: FC;
/** Publish modal — publishing stage: per-connection progress bar + operation table. No props. */
export declare const PublishProgressModal: FC;
/** Pull-progress modal: overall progress + per-connection pull-job status table. No props. */
export declare const PullProgressModal: FC;
/** "Create Connection" modal: the connector picker grid + name + API-key field. No props. */
export declare const CreateConnectionModal: FC;
/** "Choose tables" modal: the connector table picker (step 1, checkbox list). No props. */
export declare const ChooseTablesModal: FC;
/** Login screen: centered logo + title + log-in / create-account actions. No props. */
export declare const LoginPage: FC;
/** First-run Welcome screen: "Download a workspace" with the cloud workspaces. No props. */
export declare const WelcomePage: FC;
/** Home screen: the workspace picker (downloaded + cloud workspaces) + footer. No props. */
export declare const HomePage: FC;
/** User settings page: account info + sign out, inside the settings shell. No props. */
export declare const SettingsUserPage: FC;
/** Billing settings page: usage, subscription, and upgrade plan cards. No props. */
export declare const SettingsBillingPage: FC;

// ── Icon buttons (square, icon-only; pass an icon element as children) ───────────
/** Icon-only primary action. Square, yellow fill + highlight border. */
export declare const IconButtonPrimaryOutline: FC<DSButtonProps>;
/** Icon-only neutral action. Square, outlined with the corner-bracket border. */
export declare const IconButtonOutline: FC<DSButtonProps>;
/** Icon-only low-emphasis action. Square, subtle/ghost. */
export declare const IconButtonGhost: FC<DSButtonProps>;
/** Icon-only inline action. Borderless, transparent; for dense rows. */
export declare const IconButtonInline: FC<DSButtonProps>;
/** Icon-only toolbar action (24px). Hairline border on a base surface. */
export declare const IconButtonToolbar: FC<DSButtonProps>;

// ── Form controls (themed Mantine components) ────────────────────────────────────
/** Checkbox. Square; checked state uses the yellow highlight fill + border. */
export declare const Checkbox: FC<CheckboxProps>;
/** Switch. On state uses the yellow highlight fill + border. */
export declare const Switch: FC<SwitchProps>;
/** Single-line text input. Square corners, neutral border, yellow focus ring. */
export declare const TextInput: FC<TextInputProps>;
/** Multi-line text input. Same styling as TextInput; auto-sizing optional. */
export declare const Textarea: FC<TextareaProps>;
/** Select dropdown. Square corners, neutral border, yellow focus ring. */
export declare const Select: FC<SelectProps>;

// ── Primary ───────────────────────────────────────────────────────────────────
/** Primary action. Solid yellow-highlight fill with a 1.5px highlight border; near-black label. */
export declare const ButtonPrimarySolid: FC<DSButtonProps>;
/** Primary action, lighter weight. Yellow fill with the corner-bracket border. */
export declare const ButtonPrimaryLight: FC<DSButtonProps>;

// ── Secondary ─────────────────────────────────────────────────────────────────
/** Secondary action, high emphasis. Dark (gray-9) fill with a light label. */
export declare const ButtonSecondarySolid: FC<DSButtonProps>;
/** Secondary action. Neutral, outlined with the signature corner-bracket border on a base surface. */
export declare const ButtonSecondaryOutline: FC<DSButtonProps>;
/** Secondary action, low emphasis. Subtle/ghost — no fill or border until hover. */
export declare const ButtonSecondaryGhost: FC<DSButtonProps>;
/** Secondary action, inline. Compact, borderless; for use within text or dense rows. */
export declare const ButtonSecondaryInline: FC<DSButtonProps>;

// ── Danger ────────────────────────────────────────────────────────────────────
/** Destructive action. Light red fill with red label; use for discard/remove/delete. */
export declare const ButtonDangerLight: FC<DSButtonProps>;

// ── Compact (toolbars & sidebars, 22px) ─────────────────────────────────────────
/** Compact primary action (22px, 11px label). Yellow fill + highlight border, for dense chrome. */
export declare const ButtonCompactPrimary: FC<DSButtonProps>;
/** Compact secondary action (22px). Neutral selected-surface fill. */
export declare const ButtonCompactSecondary: FC<DSButtonProps>;
/** Compact destructive action (22px). Light red fill. */
export declare const ButtonCompactDanger: FC<DSButtonProps>;

// ── Developer tools (always violet) ─────────────────────────────────────────────
/** Developer-tool action. Always violet and carries the CPU glyph; fenced off from user actions. */
export declare const DevToolButton: FC<DSButtonProps>;
/** Developer-tool action, low emphasis. Violet subtle/ghost with the CPU glyph. */
export declare const DevToolButtonGhost: FC<DSButtonProps>;

// ── Composite ───────────────────────────────────────────────────────────────────
/** A larger secondary-outline button stacking a bold title over a muted description, optional leading icon. */
export declare const ButtonWithDescription: FC<{
  /** Bold title line. */
  title: string;
  /** Muted description line beneath the title. */
  description: string;
  /** Optional leading icon element. */
  icon?: ReactNode;
}>;
