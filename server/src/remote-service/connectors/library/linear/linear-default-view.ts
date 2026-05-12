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
  'parent', // parent issue — too nested for grid
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

// Fields that are subfield-able objects with {id, ...} where we want to default to a specific subfield.
const ID_SUBFIELD_FIELDS = new Set(['team', 'project', 'cycle']);

const USER_SUBFIELD_FIELDS = new Set(['assignee', 'creator', 'lead', 'delegate', 'snoozedBy']);

const DOCUMENT_CONTENT_SUBFIELDS: TableViewSubfield[] = [
  { relativePath: 'content', name: 'Content', type: 'string' },
  { relativePath: 'id', name: 'Id', type: 'string' },
];

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
    cols.push(buildCol(fieldId, properties[fieldId]));
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

  inPriority.sort((a, b) => priorityIndex.get(a)! - priorityIndex.get(b)!);
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

/** Build subfields for ID-subfield objects (team, project, cycle). */
function idSubfields(): TableViewSubfield[] {
  return [{ relativePath: 'id', name: 'Id', type: 'string' }];
}

/** Build subfields for user objects (assignee, creator, etc.). */
function userSubfields(): TableViewSubfield[] {
  return [
    { relativePath: 'name', name: 'Name', type: 'string' },
    { relativePath: 'displayName', name: 'Display Name', type: 'string' },
    { relativePath: 'email', name: 'Email', type: 'string' },
    { relativePath: 'id', name: 'Id', type: 'string' },
  ];
}

/** Build a TableViewCol from a field ID and its TypeBox schema. */
function buildCol(fieldId: string, fieldSchema: TSchema | undefined): TableViewCol {
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

  // ID-subfield objects: team, project, cycle → default to showing id
  if (ID_SUBFIELD_FIELDS.has(fieldId)) {
    col.subfields = idSubfields();
    col.selectedSubfield = 0;
  }

  // User objects: assignee, creator, lead → default to showing name
  if (USER_SUBFIELD_FIELDS.has(fieldId)) {
    col.subfields = userSubfields();
    col.selectedSubfield = 0;
  }

  // documentContent → default to showing content
  if (fieldId === 'documentContent') {
    col.subfields = DOCUMENT_CONTENT_SUBFIELDS;
    col.selectedSubfield = 0;
  }

  return col;
}
