import { Request, Router } from "express";
import { store } from "../store";

const router = Router();

const PAGE_SIZE = 100;

/**
 * Shared v2 cursor-based pagination — identical to `paginate` in `v2-lists.ts`.
 * Duplicated here to keep the route files self-contained; the fake server is
 * small enough that a shared helper isn't worth the coupling.
 */
function paginate<T>(
  req: Request,
  items: T[],
): {
  data: T[];
  pagination: { prevUrl: string | null; nextUrl: string | null };
} {
  let startIndex = 0;
  const cursorParam = req.query.cursor;
  if (typeof cursorParam === "string") {
    try {
      startIndex = parseInt(
        Buffer.from(cursorParam, "base64").toString("utf-8"),
        10,
      );
      if (isNaN(startIndex) || startIndex < 0) startIndex = 0;
    } catch {
      startIndex = 0;
    }
  }

  const requestedLimit = parseInt(String(req.query.limit ?? PAGE_SIZE), 10);
  const limit = Math.min(
    isNaN(requestedLimit) ? PAGE_SIZE : requestedLimit,
    PAGE_SIZE,
  );

  const page = items.slice(startIndex, startIndex + limit);

  const nextStart = startIndex + limit;
  const hasNext = nextStart < items.length;
  const prevStart = Math.max(0, startIndex - limit);
  const hasPrev = startIndex > 0;

  const buildUrl = (offset: number): string => {
    const protocol = req.protocol;
    const host = req.get("host");
    const path = req.path;

    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(req.query)) {
      if (key === "cursor") continue;
      if (Array.isArray(value)) {
        for (const v of value) params.append(key, String(v));
      } else if (value !== undefined) {
        params.append(key, String(value));
      }
    }
    params.append("cursor", Buffer.from(String(offset)).toString("base64"));
    return `${protocol}://${host}${path}?${params.toString()}`;
  };

  return {
    data: page,
    pagination: {
      prevUrl: hasPrev ? buildUrl(prevStart) : null,
      nextUrl: hasNext ? buildUrl(nextStart) : null,
    },
  };
}

// ---- GET /v2/notes ----
//
// Supports the `includes` query parameter to populate optional preview fields.
// The connector always passes `includes=companiesPreview,personsPreview,
// opportunitiesPreview,repliesCount`, so the fake always has these fields on
// the stored records — but we strip them if `includes` doesn't request them,
// matching real Affinity's behavior.

router.get("/v2/notes", (req, res) => {
  const includes = parseIncludes(req);
  const notes = store.listTenantNotes().map((n) => filterNoteIncludes(n, includes));
  res.json(paginate(req, notes));
});

// ---- GET /v2/notes/{noteId} ----

router.get("/v2/notes/:noteId", (req, res) => {
  const noteId = parseInt(req.params.noteId, 10);
  const note = store.getTenantNote(noteId);
  if (!note) {
    res.status(404).json({
      errors: [{ code: "not_found", message: `Note ${noteId} not found` }],
    });
    return;
  }
  const includes = parseIncludes(req);
  res.json(filterNoteIncludes(note, includes));
});

// ---- Helpers ----

type NoteInclude = "companiesPreview" | "personsPreview" | "opportunitiesPreview" | "repliesCount";

const VALID_NOTE_INCLUDES: ReadonlySet<string> = new Set([
  "companiesPreview",
  "personsPreview",
  "opportunitiesPreview",
  "repliesCount",
]);

function parseIncludes(req: Request): Set<NoteInclude> {
  const raw = req.query.includes;
  if (raw === undefined) return new Set();
  const values = Array.isArray(raw) ? raw : [raw];
  const result = new Set<NoteInclude>();
  for (const v of values) {
    const str = String(v);
    if (VALID_NOTE_INCLUDES.has(str)) {
      result.add(str as NoteInclude);
    }
  }
  return result;
}

function filterNoteIncludes<T extends object>(
  note: T,
  includes: Set<NoteInclude>,
): Partial<T> {
  const filtered = { ...note } as Record<string, unknown>;
  if (!includes.has("companiesPreview")) delete filtered.companiesPreview;
  if (!includes.has("personsPreview")) delete filtered.personsPreview;
  if (!includes.has("opportunitiesPreview")) delete filtered.opportunitiesPreview;
  if (!includes.has("repliesCount")) delete filtered.repliesCount;
  return filtered as Partial<T>;
}

export default router;
