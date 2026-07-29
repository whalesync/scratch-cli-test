import { Kind, TSchema } from '@sinclair/typebox';
import {
  TablePropertyType,
  TableView,
  TableViewCol,
  TableViewSubfield,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';
import { type EntityType } from './graphql';

// ── Priority ordering per entity type ──

const ISSUES_PRIORITY: string[] = [
  'identifier',
  'title',
  'description',
  'priority',
  'priorityLabel',
  'state',
  'assignee',
  'team',
  'project',
  'labelIds',
  'estimate',
  'dueDate',
  'cycle',
  'creator',
  'url',
  'createdAt',
  'updatedAt',
];

const PROJECTS_PRIORITY: string[] = [
  'name',
  'id',
  'slugId',
  'description',
  'status',
  'state',
  'health',
  'priority',
  'priorityLabel',
  'lead',
  'creator',
  'startDate',
  'targetDate',
  'progress',
  'scope',
  'url',
  'createdAt',
  'updatedAt',
];

const TEAMS_PRIORITY: string[] = [
  'name',
  'id',
  'key',
  'description',
  'displayName',
  'icon',
  'color',
  'private',
  'timezone',
  'issueCount',
  'cyclesEnabled',
  'triageEnabled',
  'createdAt',
  'updatedAt',
];

const USERS_PRIORITY: string[] = [
  'name',
  'id',
  'displayName',
  'email',
  'active',
  'admin',
  'guest',
  'description',
  'timezone',
  'lastSeen',
  'createdAt',
  'updatedAt',
];

const LABELS_PRIORITY: string[] = [
  'name',
  'id',
  'description',
  'color',
  'isGroup',
  'team',
  'creator',
  'parent',
  'createdAt',
  'updatedAt',
];

const CYCLES_PRIORITY: string[] = [
  'number',
  'name',
  'id',
  'description',
  'startsAt',
  'endsAt',
  'progress',
  'isActive',
  'isNext',
  'isPast',
  'team',
  'completedAt',
  'createdAt',
  'updatedAt',
];

const PRIORITY_MAP: Record<string, string[]> = {
  issues: ISSUES_PRIORITY,
  projects: PROJECTS_PRIORITY,
  teams: TEAMS_PRIORITY,
  users: USERS_PRIORITY,
  labels: LABELS_PRIORITY,
  cycles: CYCLES_PRIORITY,
};

// ── Hidden fields ──
// Internal sort/board ordering, deeply nested connection objects, and system metadata
// that aren't useful in a grid view.
const HIDDEN_FIELDS = new Set([
  // Sort/board ordering internals
  'boardOrder',
  'sortOrder',
  'prioritySortOrder',
  'subIssueSortOrder',
  // SLA internals
  'slaStartedAt',
  'slaMediumRiskAt',
  'slaHighRiskAt',
  'slaBreachesAt',
  'slaType',
  // Timestamps that duplicate or are rarely useful
  'archivedAt',
  'autoArchivedAt',
  'autoClosedAt',
  'startedTriageAt',
  'suggestionsGeneratedAt',
  'addedToProjectAt',
  'addedToCycleAt',
  'addedToTeamAt',
  'healthUpdatedAt',
  'projectUpdateRemindersPausedUntilAt',
  'retiredAt',
  // Nested objects that are noise in a grid
  'favorite',
  'sourceComment',
  'sharedAccess',
  'lastAppliedTemplate',
  'recurringIssueTemplate',
  'formerAttachments',
  'formerNeeds',
  'needs',
  'suggestions',
  'incomingSuggestions',
  'asksRequester',
  'asksExternalUserRequester',
  'stateHistory',
  'reactions',
  'reactionData',
  'activitySummary',
  'summary',
  'syncedWith',
  'snoozedBy',
  'snoozedUntilAt',
  'previousIdentifiers',
  'convertedFromIssue',
  'lastUpdate',
  'progressHistory',
  'currentProgress',
  'facets',
  'initiativeToProjects',
  'initiatives',
  'externalLinks',
  // History arrays
  'issueCountHistory',
  'completedIssueCountHistory',
  'scopeHistory',
  'completedScopeHistory',
  'inProgressScopeHistory',
  // Team config internals
  'organization',
  'securitySettings',
  'posts',
  'draftWorkflowState',
  'startWorkflowState',
  'reviewWorkflowState',
  'mergeableWorkflowState',
  'mergeWorkflowState',
  'markedAsDuplicateWorkflowState',
  'defaultIssueState',
  'defaultTemplateForMembers',
  'defaultTemplateForMembersId',
  'defaultTemplateForNonMembers',
  'defaultTemplateForNonMembersId',
  'defaultProjectTemplate',
  'triageIssueState',
  'triageResponsibility',
  'activeCycle',
  'cycles',
  'memberships',
  'projects',
  'states',
  'gitAutomationStates',
  'templates',
  'webhooks',
  'issueSortOrderDefaultToBottom',
  'cycleCalenderUrl',
  'inviteHash',
  // User internals
  'identityProvider',
  'avatarBackgroundColor',
  'calendarHash',
  'disableReason',
  'initials',
  'issueDrafts',
  'drafts',
  'assignedIssues',
  'delegatedIssues',
  'createdIssues',
  'teamMemberships',
  'feedFacets',
  'gitHubUserId',
  // Labels internals
  'inheritedFrom',
  'retiredBy',
  'lastAppliedAt',
  // Cycles internals
  'uncompletedIssuesUponClose',
  'links',
  'isFuture',
  'isPrevious',
  // Various settings
  'updateReminderFrequencyInWeeks',
  'updateReminderFrequency',
  'frequencyResolution',
  'updateRemindersDay',
  'updateRemindersHour',
  'groupIssueHistory',
  'aiThreadSummariesEnabled',
  'aiDiscussionSummariesEnabled',
  'slackNewIssue',
  'slackIssueComments',
  'slackIssueStatuses',
  'autoClosePeriod',
  'autoCloseStateId',
  'autoArchivePeriod',
  'autoCloseParentIssues',
  'autoCloseChildIssues',
  'cycleIssueAutoAssignStarted',
  'cycleIssueAutoAssignCompleted',
  'cycleLockToActive',
  'setIssueSortOrderOnStateChange',
  'issueEstimationType',
  'issueOrderingNoPriorityFirst',
  'issueEstimationAllowZero',
  'issueEstimationExtended',
  'defaultIssueEstimate',
  'inheritWorkflowStatuses',
  'inheritIssueEstimation',
  'scimManaged',
  'scimGroupName',
  'joinByDefault',
  // Misc booleans on users
  'isMentionable',
  'isAssignable',
  'supportsAgentSessions',
  'canAccessAnyPublicTeam',
  'isMe',
  'app',
]);

/**
 * Relation fields, keyed by `<entityType>.<fieldId>` → the Linear entity table they link to.
 *
 * Every one of these is pulled as a `{ id }` reference object (or, for `labelIds`, a bare array
 * of ids). Left generic they land as an opaque JSON blob — or, worse, as a blank cell when the
 * view points at a `.name` that the reference-only pull never fetched. Instead the view emits a
 * column at the inner id path and declares the foreign key, so a Live Export plan turns it into a
 * real linked record / FK column instead of raw UUID text (DEV-11023, DEV-11024).
 *
 * `linkedTableId` is the target table's remote id, which for Linear is the entity type — see
 * `LinearConnector.listTables` (`remoteId: [entityType]`).
 *
 * The verbatim reference object stays on disk untouched (Connector Prime Directive); the view only
 * points a column at the id already inside it. All of these are read-only on Linear's side except
 * `labelIds`, so surfacing them as links never publishes an edit back through them.
 */
const RELATION_FOREIGN_KEYS: Record<string, { linkedTableId: EntityType; isSingleValued: boolean }> = {
  'issues.team': { linkedTableId: 'teams', isSingleValued: true },
  'issues.project': { linkedTableId: 'projects', isSingleValued: true },
  'issues.cycle': { linkedTableId: 'cycles', isSingleValued: true },
  'issues.assignee': { linkedTableId: 'users', isSingleValued: true },
  'issues.creator': { linkedTableId: 'users', isSingleValued: true },
  'issues.delegate': { linkedTableId: 'users', isSingleValued: true },
  'issues.parent': { linkedTableId: 'issues', isSingleValued: true },
  'issues.labelIds': { linkedTableId: 'labels', isSingleValued: false },
  'projects.creator': { linkedTableId: 'users', isSingleValued: true },
  'projects.lead': { linkedTableId: 'users', isSingleValued: true },
  'projects.labelIds': { linkedTableId: 'labels', isSingleValued: false },
  'labels.team': { linkedTableId: 'teams', isSingleValued: true },
  'labels.creator': { linkedTableId: 'users', isSingleValued: true },
  'labels.parent': { linkedTableId: 'labels', isSingleValued: true },
  'cycles.team': { linkedTableId: 'teams', isSingleValued: true },
  'teams.parent': { linkedTableId: 'teams', isSingleValued: true },
};

/**
 * Relation fields whose ids live directly on the field (a bare array of remote ids) rather than
 * inside a nested `{ id }` reference object. These keep their own path; every other relation
 * column drills to `<fieldId>.id`.
 */
const FLAT_ID_RELATION_FIELDS = new Set(['labelIds']);

const DOCUMENT_CONTENT_SUBFIELDS: TableViewSubfield[] = [
  // The document body is Markdown — `richtext` is what makes a destination create a long-text
  // field that keeps its newlines rather than a single-line one that strips them (DEV-11028).
  { relativePath: 'content', name: 'Content', type: 'richtext' },
  { relativePath: 'id', name: 'Id', type: 'string' },
];

/**
 * Nested objects the view unpacks to a single inner value, keyed by `<entityType>.<fieldId>`.
 * These are the object fields that are NOT relations onto a Linear entity table: without a pluck
 * they sync as a JSON blob, and the value worth keeping is already inside the pulled object.
 *
 * Keyed per entity because the same field name means different things across Linear's entities —
 * a Project's `state` is a plain enum string, an Issue's is a `WorkflowState` reference object.
 */
const UNPACKED_OBJECT_SUBFIELDS: Record<string, TableViewSubfield[]> = {
  // An Issue's workflow status. `WorkflowState` isn't one of the six entity types we expose, so
  // there's no table to link to and the status has to travel on the Issue itself — which is why
  // the pull now selects its displayable fields rather than only `{ id }`, and why the default is
  // the human-readable `name` ("In Progress") rather than the uuid the whole object used to
  // export as (DEV-11024).
  'issues.state': [
    { relativePath: 'name', name: 'Name', type: 'string' },
    { relativePath: 'type', name: 'Type', type: 'string' },
    { relativePath: 'color', name: 'Color', type: 'string' },
    { relativePath: 'id', name: 'Id', type: 'string' },
  ],
  // A Project's `status` is a full `ProjectStatus` object and the pull fetches all of it, so the
  // useful value — the status name — is right there rather than in a 244-character JSON blob
  // (DEV-11027).
  'projects.status': [
    { relativePath: 'name', name: 'Name', type: 'string' },
    { relativePath: 'type', name: 'Type', type: 'string' },
    { relativePath: 'id', name: 'Id', type: 'string' },
  ],
  'issues.documentContent': DOCUMENT_CONTENT_SUBFIELDS,
  'projects.documentContent': DOCUMENT_CONTENT_SUBFIELDS,
};

/**
 * Build a default TableView for a Linear entity type.
 */
export function buildLinearDefaultView(schema: TSchema, entityType: EntityType): TableView {
  const properties: Record<string, TSchema> =
    (schema as TSchema & { properties?: Record<string, TSchema> }).properties ?? {};

  const fieldIds = Object.keys(properties);
  const priority = PRIORITY_MAP[entityType] ?? [];
  const sorted = sortFields(fieldIds, priority);
  const cols: TableViewCol[] = [];

  for (const fieldId of sorted) {
    const relation = RELATION_FOREIGN_KEYS[`${entityType}.${fieldId}`];
    if (relation) {
      cols.push(buildForeignKeyCol(fieldId, properties[fieldId], relation));
    } else {
      cols.push(buildCol(fieldId, properties[fieldId], UNPACKED_OBJECT_SUBFIELDS[`${entityType}.${fieldId}`]));
    }
  }

  return { name: 'Default', cols };
}

// ── Helpers ──

/** Sort fields: priority fields first (in defined order), then the rest in schema order. */
function sortFields(fieldIds: string[], priority: string[]): string[] {
  const priorityIndex = new Map(priority.map((f, i) => [f, i]));
  const inPriority: string[] = [];
  const rest: string[] = [];

  for (const id of fieldIds) {
    if (priorityIndex.has(id)) {
      inPriority.push(id);
    } else {
      rest.push(id);
    }
  }

  inPriority.sort((a, b) => (priorityIndex.get(a) ?? 0) - (priorityIndex.get(b) ?? 0));
  // rest stays in original schema order

  return [...inPriority, ...rest];
}

/** Format a camelCase field ID as Title Case. */
function formatFieldName(fieldId: string): string {
  // Insert space before uppercase letters, then title-case
  return fieldId
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}

/** Detect the TablePropertyType from a TypeBox schema. */
function mapType(fieldSchema: TSchema | undefined): TablePropertyType | undefined {
  if (!fieldSchema) return undefined;

  // Unwrap Optional
  const inner = unwrapSchema(fieldSchema);
  if (!inner) return undefined;

  // Markdown bodies (Issue/Project `description`, Project `content`) are annotated in
  // `linear-json-schema.ts`. `richtext` is the view's long-text hint: without it a destination
  // creates a single-line text field that collapses every newline and tab in the body
  // (DEV-11028). The annotation sits on the outer nullable union, so check before unwrapping.
  if (isMarkdownBody(fieldSchema) || isMarkdownBody(inner)) return 'richtext';

  const kind = inner[Kind] as string | undefined;
  const format = (inner as TSchema & { format?: string }).format;

  if (format === 'date-time' || format === 'date') return 'date';
  if (format === 'uri') return 'url';
  if (kind === 'Boolean') return 'checkbox';
  if (kind === 'Number' || kind === 'Integer') return 'number';
  if (kind === 'Array' || kind === 'Object') return 'object';
  if (kind === 'Unknown') return 'object';

  return undefined;
}

/** Unwrap Optional/Union wrappers to find the meaningful inner schema. */
function unwrapSchema(schema: TSchema): TSchema | undefined {
  if (!schema) return undefined;
  const kind = schema[Kind] as string | undefined;

  // Optional wrapper — inner schema is on the schema itself (TypeBox puts Optional as a modifier)
  if (kind === 'Optional') {
    return unwrapSchema((schema as TSchema & { type?: TSchema }).type ?? schema);
  }

  // Union with Null — pick the non-null branch
  if (kind === 'Union') {
    const anyOf = (schema as TSchema & { anyOf?: TSchema[] }).anyOf;
    if (anyOf) {
      const nonNull = anyOf.find((s) => s[Kind] !== 'Null');
      if (nonNull) return nonNull;
    }
  }

  return schema;
}

/** True when the schema node is annotated as a Markdown body (see `linear-json-schema.ts`). */
function isMarkdownBody(schema: TSchema | undefined): boolean {
  return (schema as (TSchema & { contentMediaType?: string }) | undefined)?.contentMediaType === 'text/markdown';
}

/**
 * Build the link column for a relation field: a column pointing at the id Linear already carries
 * (`team.id`, or `labelIds` itself for the flat-array relations) and declaring the foreign key, so
 * the plan generator makes it a linked record / FK column instead of raw UUID text.
 *
 * Deliberately NOT built with `subfields`/`selectedSubfield`: a column that renders a selected
 * subfield is exported through a separate branch of `selectPlanFieldsFromTableView` that never
 * reads `foreignKey`, so the declaration would be silently dropped. Drilling with the path is what
 * Shopify's equivalent link columns do (DEV-11017).
 */
function buildForeignKeyCol(
  fieldId: string,
  fieldSchema: TSchema | undefined,
  relation: { linkedTableId: EntityType; isSingleValued: boolean },
): TableViewCol {
  const isFlatIdList = FLAT_ID_RELATION_FIELDS.has(fieldId);
  return {
    kind: 'col',
    // The id path is a plain string; the whole reference object stays on disk unchanged.
    path: isFlatIdList ? fieldId : `${fieldId}.id`,
    name: formatFieldName(fieldId),
    type: 'string',
    // A reference object is read-only on Linear (`x-scratch-readonly` on the field itself); a flat
    // id list like `labelIds` is writable, so take the answer from the schema rather than assuming.
    readonly: fieldSchema?.[X_SCRATCH_READONLY] === true || undefined,
    // `linkedTableRemoteId` is the target table's full remote id array — for Linear that's
    // `[entityType]` (see `LinearConnector.listTables`, `remoteId: [entityType]`), and the FK's
    // `linkedTableId` IS that entity type, so the array is the single-element `[linkedTableId]`.
    foreignKey: {
      linkedTableId: relation.linkedTableId,
      linkedTableRemoteId: [relation.linkedTableId],
      isSingleValued: relation.isSingleValued,
    },
  };
}

/** Build a TableViewCol from a field ID and its TypeBox schema. */
function buildCol(fieldId: string, fieldSchema: TSchema | undefined, subfields?: TableViewSubfield[]): TableViewCol {
  const hidden = HIDDEN_FIELDS.has(fieldId) || undefined;
  const isReadonly = fieldSchema?.[X_SCRATCH_READONLY] === true;

  const col: TableViewCol = {
    kind: 'col',
    path: fieldId,
    name: formatFieldName(fieldId),
    type: mapType(fieldSchema),
    readonly: isReadonly || undefined,
    hidden,
  };

  // An unpacked object shows its first subfield by default rather than the raw JSON.
  if (subfields) {
    col.subfields = subfields;
    col.selectedSubfield = 0;
  }

  return col;
}
