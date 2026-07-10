/**
 * JSON shape of `scratchmd record-tree --folder <connection>/<folder>` — the
 * parent/child tree derived from the parent pointer each record file carries,
 * following the dot-paths the folder's schema declares under `recordTree`
 * (generic contract; no connector knowledge on either side).
 */
export interface RecordTreeNode {
  /** Filename stem of the record file, or the folder name for `kind: 'folder'` nodes. */
  name: string;
  /** Record file name with extension; for folder nodes, the workspace-relative folder path. */
  file: string;
  /** A record file of the folder, or a sibling data folder embedded inside one of its records. */
  kind: 'record' | 'folder';
  id?: string;
  /** Why a root is a root (e.g. Notion `workspace` / `block_id`), when the schema declares a kind path. */
  parentKind?: string;
  /** The declared parent id — present even when that parent is not in the folder. */
  parentId?: string;
  /** The node's own URL in the external service, when the schema declares one. */
  url?: string;
  children: RecordTreeNode[];
}

export interface RecordTreeResult {
  folder: string;
  totalRecords: number;
  /** Files that could not be read/parsed, as "<file>: <error>" strings. */
  parseErrors: string[];
  roots: RecordTreeNode[];
}
