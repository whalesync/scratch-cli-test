# Change Visualization Rules

This note defines how the desktop app should visualize record field changes.

## Terms

- `W`: working value the user currently sees in the editable surface
- `D`: approved/reviewed local value from `dirty`
- `M`: published/current server value from `main`
- `TEMP`: the transient value currently being typed into an editor

## Intent

- Diffs should be used mainly for the approval moment.
- Once a value is already approved, or once the user is actively editing, the UI should stop showing heavy diff treatment and instead show a compact reference value.
- The reference value depends on the state:
  - unreviewed path references `D`
  - approved path references `M`

## Grid View

### Selected, unreviewed (`W != D`)

- Show a popover above the selected cell.
- The popover shows a diff of `W` versus `D`.
- The popover actions are:
  - `Approve`
  - `Undo`
- `Undo` means `W := D`.

### Selected, approved (`W = D != M`)

- Show a popover above the selected cell.
- Do not show a diff.
- Show only the reference value `M` in muted gray.
- Show only `Undo`.
- `Undo` means `W := M` and `D := M`.

### Editing, unreviewed (`TEMP` editing a cell where `W != D`)

- The input starts with `W`.
- The popover shows only `D` in muted gray.
- Show only `Undo`.
- `Undo` means `W := D`.
- `D` is not modified by the undo action.

Example:

- before undo: `W != D != M`
- after undo: `W = D != M`

### Editing, approved (`TEMP` editing a cell where `W = D != M`)

- The input starts with `D`.
- The popover shows only `M` in muted gray.
- Show only `Undo`.
- `Undo` means `W := M` and `D := M`.

## Record View

### View mode, unreviewed (`W != D`)

- Show the diff inline in the field row itself.
- No popover is needed for the resting state.
- Show:
  - diff content
  - `Approve`
  - `Undo`
- `Undo` means `W := D`.

### View mode, approved (`W = D != M`)

- Do not show a diff.
- Show the current approved value `D` with a light approved indicator.
- Do not show the old value in the resting state.

### View mode, unchanged (`W = D = M`)

- Show plain value only.

### Editing, unreviewed

- The input starts with `W`.
- Show a compact reference strip above the input with `D` in muted gray.
- Show only `Undo`.
- `Undo` means `W := D`.

### Editing, approved

- The input starts with `D`.
- Show a compact reference strip above the input with `M` in muted gray.
- Show only `Undo`.
- `Undo` means `W := M` and `D := M`.

## Presentation Rules

- Compact reference strips should shrink to roughly button height when they contain a single short line and only one action.
- Diff/reference surfaces may grow when text wraps, but should cap visible height to about five lines before scrolling.
- Edit mode reference text is muted gray, not diff-colored.
- The goal is to reduce visual noise while preserving the approval model.
