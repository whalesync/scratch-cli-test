import { ScratchGitNotFoundError } from 'src/scratch-git/scratch-git.client';
import {
  decideRealScratchAccountMigration,
  formatRealScratchAccountMigrationReport,
  LiveExportWorkbookState,
  migrateRealScratchAccountOffWhalesyncTeam,
  NEW_ORGANIZATION_ID_PLACEHOLDER,
  RealScratchAccountMigrationDeps,
  RealScratchAccountMigrationFailed,
  RealScratchAccountState,
  RepoMoveOutcome,
} from '../whalesync-real-account-migration';
import {
  moveRepoOnScratchGit,
  whalesyncSubscriptionPayloadFromWhalesyncPlanRow,
} from '../whalesync-real-account-migration.service';

// ── An in-memory Scratch, behind the migration's deps ─────────────────────────────────────────────────────────────

interface FakeUser {
  id: string;
  clerkId: string | null;
  email: string | null;
  whalesyncTeamId: string | null;
  whalesyncUserId: string | null;
  organizationId: string | null;
  lastWorkbookId: string | null;
}

interface FakeWorkbook {
  id: string;
  name: string;
  organizationId: string;
  userId: string | null;
  managedBy: 'ws_export' | null;
  isPendingDelete: boolean;
  permissionUserIds: string[];
  activeRoutineRunCount: number;
  nonTerminalJobCount: number;
}

interface FakeConnection {
  id: string;
  workbookId: string;
  repoPath: string;
  userId: string | null;
  migrationLocked: boolean;
}

interface FakeSchedule {
  id: string;
  workbookId: string;
  organizationId: string;
  userId: string | null;
  enabled: boolean;
  disabledForMigration: boolean;
}

class CrashError extends Error {
  constructor() {
    super('simulated crash');
    this.name = 'CrashError';
  }
}

class FakeScratch {
  users = new Map<string, FakeUser>();
  workbooks = new Map<string, FakeWorkbook>();
  connections = new Map<string, FakeConnection>();
  schedules = new Map<string, FakeSchedule>();
  reposOnDisk = new Set<string>();
  whalesyncPlanStatusByOrganizationId = new Map<string, string>();
  sessionTokenCountByUserId = new Map<string, number>();
  auditLogEntries: { organizationId: string; entityId: string; message: string }[] = [];
  mutatingCallLog: string[] = [];
  createdShadowUserCount = 0;

  /** When set, the process "dies" just before this many-th mutating call: it and every later call throw. */
  crashBeforeMutatingCallNumber: number | null = null;
  private mutatingCallCount = 0;
  private crashed = false;

  /** Hooks a test can use to change the world mid-run, the way a concurrent session or run would. */
  afterPause: ((workbookId: string) => void) | null = null;
  throwOnPause: Error | null = null;
  failRepoMoveFrom: string | null = null;

  private assertAlive(): void {
    if (this.crashed) {
      throw new CrashError();
    }
  }

  private mutate(callName: string): void {
    this.assertAlive();
    this.mutatingCallCount += 1;
    if (this.crashBeforeMutatingCallNumber !== null && this.mutatingCallCount >= this.crashBeforeMutatingCallNumber) {
      this.crashed = true;
      throw new CrashError();
    }
    this.mutatingCallLog.push(callName);
  }

  /** A fresh process after a crash: same data, no crash pending. */
  restart(): void {
    this.crashed = false;
    this.crashBeforeMutatingCallNumber = null;
    this.mutatingCallCount = 0;
    this.mutatingCallLog = [];
  }

  organizationMemberCount(organizationId: string | null): number {
    return organizationId ? [...this.users.values()].filter((u) => u.organizationId === organizationId).length : 0;
  }

  liveExportState(workbook: FakeWorkbook): LiveExportWorkbookState {
    const connections = [...this.connections.values()].filter((c) => c.workbookId === workbook.id);
    const schedules = [...this.schedules.values()].filter((s) => s.workbookId === workbook.id);
    return {
      workbookId: workbook.id,
      name: workbook.name,
      organizationId: workbook.organizationId,
      userId: workbook.userId,
      isPendingDelete: workbook.isPendingDelete,
      connections: connections.map((c) => ({ connectorAccountId: c.id, repoPath: c.repoPath })),
      scheduleCount: schedules.length,
      workspacePermissionUserIdsOtherThanCreator: workbook.permissionUserIds.filter((id) => id !== workbook.userId),
      activeRoutineRunCount: workbook.activeRoutineRunCount,
      nonTerminalJobCount: workbook.nonTerminalJobCount,
      migrationLockedConnectionCount: connections.filter((c) => c.migrationLocked).length,
      schedulesDisabledForMigrationCount: schedules.filter((s) => s.disabledForMigration).length,
    };
  }

  liveExportsCreatedBy(userId: string): FakeWorkbook[] {
    return [...this.workbooks.values()].filter((w) => w.userId === userId && w.managedBy === 'ws_export');
  }

  deps(): RealScratchAccountMigrationDeps {
    return {
      loadRealScratchAccountState: (realUserId) => {
        this.assertAlive();
        return Promise.resolve(this.loadRealScratchAccountState(realUserId));
      },
      createShadowUserAwaitingTeam: (whalesyncTeamId) => {
        this.mutate('createShadowUserAwaitingTeam');
        const clerkId = `ws_${whalesyncTeamId}`;
        if ([...this.users.values()].some((u) => u.clerkId === clerkId)) {
          throw new Error('unique violation on clerkId');
        }
        this.createdShadowUserCount += 1;
        const shadowUser: FakeUser = {
          id: `usr_shadow_${this.createdShadowUserCount}`,
          clerkId,
          email: null,
          whalesyncTeamId: null,
          whalesyncUserId: null,
          organizationId: `org_shadow_${this.createdShadowUserCount}`,
          lastWorkbookId: null,
        };
        this.users.set(shadowUser.id, shadowUser);
        return Promise.resolve({ userId: shadowUser.id, organizationId: shadowUser.organizationId as string });
      },
      copyWhalesyncPlanToShadowUser: (realUserId, shadowUserId) => {
        this.mutate('copyWhalesyncPlanToShadowUser');
        const realOrganizationId = this.users.get(realUserId)?.organizationId ?? '';
        const shadowOrganizationId = this.users.get(shadowUserId)?.organizationId ?? '';
        if (this.whalesyncPlanStatusByOrganizationId.has(shadowOrganizationId)) {
          return Promise.resolve('already_present' as const);
        }
        const planStatus = this.whalesyncPlanStatusByOrganizationId.get(realOrganizationId);
        if (!planStatus) {
          return Promise.resolve('nothing_to_copy' as const);
        }
        if (planStatus !== 'active') {
          return Promise.resolve('inactive_not_copied' as const);
        }
        this.whalesyncPlanStatusByOrganizationId.set(shadowOrganizationId, planStatus);
        return Promise.resolve('copied' as const);
      },
      pauseLiveExport: (workbookId, connectorAccountIds) => {
        this.mutate(`pauseLiveExport:${workbookId}`);
        for (const schedule of this.schedules.values()) {
          if (schedule.workbookId === workbookId && schedule.enabled && !schedule.disabledForMigration) {
            schedule.enabled = false;
            schedule.disabledForMigration = true;
          }
        }
        for (const connectorAccountId of connectorAccountIds) {
          const connection = this.connections.get(connectorAccountId);
          if (connection) {
            connection.migrationLocked = true;
          }
        }
        if (this.throwOnPause) {
          return Promise.reject(this.throwOnPause);
        }
        this.afterPause?.(workbookId);
        return Promise.resolve();
      },
      releaseLiveExport: (workbookId, connectorAccountIds) => {
        this.mutate(`releaseLiveExport:${workbookId}`);
        for (const connectorAccountId of connectorAccountIds) {
          const connection = this.connections.get(connectorAccountId);
          if (connection) {
            connection.migrationLocked = false;
          }
        }
        for (const schedule of this.schedules.values()) {
          if (schedule.workbookId === workbookId && schedule.disabledForMigration) {
            schedule.enabled = true;
            schedule.disabledForMigration = false;
          }
        }
        return Promise.resolve();
      },
      countActiveRoutineRuns: (workbookId) => {
        this.assertAlive();
        return Promise.resolve(this.workbooks.get(workbookId)?.activeRoutineRunCount ?? 0);
      },
      moveRepo: (fromRepoId, toRepoId) => {
        this.mutate(`moveRepo:${fromRepoId}`);
        if (fromRepoId === this.failRepoMoveFrom) {
          return Promise.reject(new Error(`scratch-git 500 moving ${fromRepoId}`));
        }
        const sourceExists = this.reposOnDisk.has(fromRepoId);
        const destinationExists = this.reposOnDisk.has(toRepoId);
        let outcome: RepoMoveOutcome;
        if (sourceExists && destinationExists) {
          return Promise.reject(new Error(`409: destination ${toRepoId} exists`));
        } else if (sourceExists) {
          this.reposOnDisk.delete(fromRepoId);
          this.reposOnDisk.add(toRepoId);
          outcome = 'moved';
        } else if (destinationExists) {
          outcome = 'already_moved';
        } else {
          outcome = 'no_repo';
        }
        return Promise.resolve(outcome);
      },
      moveLiveExportRows: (move) => {
        this.mutate(`moveLiveExportRows:${move.workbookId}`);
        const workbook = this.workbooks.get(move.workbookId);
        if (!workbook || workbook.userId !== move.fromUserId || workbook.organizationId !== move.fromOrganizationId) {
          return Promise.resolve();
        }
        workbook.userId = move.toUserId;
        workbook.organizationId = move.toOrganizationId;
        workbook.permissionUserIds = workbook.permissionUserIds.map((id) =>
          id === move.fromUserId ? move.toUserId : id,
        );
        for (const [connectorAccountId, newRepoPath] of move.connectorAccountIdToNewRepoPath) {
          const connection = this.connections.get(connectorAccountId) as FakeConnection;
          connection.repoPath = newRepoPath;
        }
        for (const connection of this.connections.values()) {
          if (connection.workbookId === move.workbookId && connection.userId === move.fromUserId) {
            connection.userId = move.toUserId;
          }
        }
        for (const schedule of this.schedules.values()) {
          if (schedule.workbookId === move.workbookId) {
            schedule.organizationId = move.toOrganizationId;
            if (schedule.userId === move.fromUserId) {
              schedule.userId = move.toUserId;
            }
          }
        }
        const realUser = this.users.get(move.fromUserId) as FakeUser;
        if (realUser.lastWorkbookId === move.workbookId) {
          realUser.lastWorkbookId = null;
        }
        return Promise.resolve();
      },
      unlinkRealScratchAccount: (realUserId, handOverWhalesyncIdentityToUserId) => {
        this.mutate('unlinkRealScratchAccount');
        if (this.liveExportsCreatedBy(realUserId).length > 0) {
          return Promise.reject(new Error('409: still holds Live Exports'));
        }
        const realUser = this.users.get(realUserId) as FakeUser;
        if (realUser.organizationId) {
          this.whalesyncPlanStatusByOrganizationId.delete(realUser.organizationId);
        }
        // One transaction: revoke, clear, hand over.
        if (handOverWhalesyncIdentityToUserId) {
          const shadowUser = this.users.get(handOverWhalesyncIdentityToUserId);
          if (!shadowUser || shadowUser.whalesyncTeamId || shadowUser.whalesyncUserId) {
            return Promise.reject(new Error('409: shadow user already has a Whalesync identity'));
          }
          shadowUser.whalesyncTeamId = realUser.whalesyncTeamId;
          shadowUser.whalesyncUserId = realUser.whalesyncUserId;
        }
        this.sessionTokenCountByUserId.set(realUserId, 0);
        realUser.whalesyncTeamId = null;
        realUser.whalesyncUserId = null;
        return Promise.resolve();
      },
      logAudit: (entry) => {
        this.mutate('logAudit');
        this.auditLogEntries.push(entry);
        return Promise.resolve();
      },
    };
  }

  private loadRealScratchAccountState(realUserId: string): RealScratchAccountState | null {
    const realUser = this.users.get(realUserId);
    if (!realUser || (!realUser.whalesyncTeamId && !realUser.whalesyncUserId) || realUser.clerkId?.startsWith('ws_')) {
      return null;
    }
    const shadowUser = realUser.whalesyncTeamId
      ? [...this.users.values()].find((u) => u.clerkId === `ws_${realUser.whalesyncTeamId}`)
      : undefined;
    return {
      userId: realUser.id,
      whalesyncTeamId: realUser.whalesyncTeamId,
      whalesyncUserId: realUser.whalesyncUserId,
      organizationId: realUser.organizationId,
      organizationMemberCount: this.organizationMemberCount(realUser.organizationId),
      liveExportsCreatedByAccount: this.liveExportsCreatedBy(realUserId).map((w) => this.liveExportState(w)),
      liveExportIdsInOrganizationCreatedByOthers: [...this.workbooks.values()]
        .filter(
          (w) => w.organizationId === realUser.organizationId && w.managedBy === 'ws_export' && w.userId !== realUserId,
        )
        .map((w) => w.id),
      shadowUserWithTeamClerkId: shadowUser
        ? {
            userId: shadowUser.id,
            organizationId: shadowUser.organizationId,
            organizationMemberCount: this.organizationMemberCount(shadowUser.organizationId),
            whalesyncTeamId: shadowUser.whalesyncTeamId,
            whalesyncUserId: shadowUser.whalesyncUserId,
            email: shadowUser.email,
          }
        : null,
      liveExportsOnShadowUserLeftPaused: shadowUser
        ? this.liveExportsCreatedBy(shadowUser.id)
            .map((w) => this.liveExportState(w))
            .filter((w) => w.migrationLockedConnectionCount > 0 || w.schedulesDisabledForMigrationCount > 0)
        : [],
      whalesyncPlanStatusOfOrganization: realUser.organizationId
        ? (this.whalesyncPlanStatusByOrganizationId.get(realUser.organizationId) ?? null)
        : null,
    };
  }
}

/**
 * A person's real Scratch account holding two Live Exports for team `tm_1` (three connections, two schedules, one of
 * them disabled by the person), plus a native workbook of their own.
 */
function makeAccountWithLiveExports(): FakeScratch {
  const scratch = new FakeScratch();
  scratch.users.set('usr_real', {
    id: 'usr_real',
    clerkId: 'user_clerk',
    email: 'person@example.com',
    whalesyncTeamId: 'tm_1',
    whalesyncUserId: 'wsu_1',
    organizationId: 'org_real',
    lastWorkbookId: 'wkb_le_1',
  });
  scratch.sessionTokenCountByUserId.set('usr_real', 1);
  scratch.whalesyncPlanStatusByOrganizationId.set('org_real', 'active');
  const addWorkbook = (id: string, managedBy: 'ws_export' | null): void => {
    scratch.workbooks.set(id, {
      id,
      name: id,
      organizationId: 'org_real',
      userId: 'usr_real',
      managedBy,
      isPendingDelete: false,
      permissionUserIds: ['usr_real'],
      activeRoutineRunCount: 0,
      nonTerminalJobCount: 0,
    });
    scratch.reposOnDisk.add(`org_real/${id}/${id}`);
    scratch.reposOnDisk.add(`org_real/${id}/scratch`);
  };
  const addConnection = (id: string, workbookId: string): void => {
    scratch.connections.set(id, {
      id,
      workbookId,
      repoPath: `org_real/${workbookId}/${id}`,
      userId: 'usr_real',
      migrationLocked: false,
    });
    scratch.reposOnDisk.add(`org_real/${workbookId}/${id}`);
  };
  addWorkbook('wkb_native', null);
  addConnection('coa_native', 'wkb_native');
  addWorkbook('wkb_le_1', 'ws_export');
  addConnection('coa_1a', 'wkb_le_1');
  addConnection('coa_1b', 'wkb_le_1');
  addWorkbook('wkb_le_2', 'ws_export');
  addConnection('coa_2a', 'wkb_le_2');
  // wkb_le_2 predates scratch repos.
  scratch.reposOnDisk.delete('org_real/wkb_le_2/scratch');
  scratch.schedules.set('sch_1', {
    id: 'sch_1',
    workbookId: 'wkb_le_1',
    organizationId: 'org_real',
    userId: 'usr_real',
    enabled: true,
    disabledForMigration: false,
  });
  scratch.schedules.set('sch_2', {
    id: 'sch_2',
    workbookId: 'wkb_le_2',
    organizationId: 'org_real',
    userId: 'usr_real',
    enabled: false,
    disabledForMigration: false,
  });
  return scratch;
}

/** The end state the move has to reach, however many runs it took. */
function expectAccountMovedOffTeam(scratch: FakeScratch): void {
  const shadowUsers = [...scratch.users.values()].filter((u) => u.clerkId === 'ws_tm_1');
  expect(shadowUsers).toHaveLength(1);
  const [shadowUser] = shadowUsers;
  const shadowOrganizationId = shadowUser.organizationId as string;
  expect(shadowUser).toMatchObject({ whalesyncTeamId: 'tm_1', whalesyncUserId: 'wsu_1', email: null });
  expect(scratch.organizationMemberCount(shadowOrganizationId)).toBe(1);

  const realUser = scratch.users.get('usr_real') as FakeUser;
  expect(realUser).toMatchObject({
    whalesyncTeamId: null,
    whalesyncUserId: null,
    clerkId: 'user_clerk',
    email: 'person@example.com',
    organizationId: 'org_real',
    lastWorkbookId: null,
  });
  expect(scratch.sessionTokenCountByUserId.get('usr_real')).toBe(0);

  // The person keeps their native workbook, its connection, and its repos.
  expect(scratch.workbooks.get('wkb_native')).toMatchObject({ userId: 'usr_real', organizationId: 'org_real' });
  expect(scratch.connections.get('coa_native')).toMatchObject({ repoPath: 'org_real/wkb_native/coa_native' });
  expect(scratch.reposOnDisk.has('org_real/wkb_native/coa_native')).toBe(true);
  expect(scratch.reposOnDisk.has('org_real/wkb_native/wkb_native')).toBe(true);

  for (const workbookId of ['wkb_le_1', 'wkb_le_2']) {
    expect(scratch.workbooks.get(workbookId)).toMatchObject({
      userId: shadowUser.id,
      organizationId: shadowOrganizationId,
      permissionUserIds: [shadowUser.id],
    });
    expect(scratch.reposOnDisk.has(`${shadowOrganizationId}/${workbookId}/${workbookId}`)).toBe(true);
    expect(scratch.reposOnDisk.has(`org_real/${workbookId}/${workbookId}`)).toBe(false);
  }
  expect(scratch.reposOnDisk.has(`${shadowOrganizationId}/wkb_le_1/scratch`)).toBe(true);
  for (const [connectorAccountId, workbookId] of [
    ['coa_1a', 'wkb_le_1'],
    ['coa_1b', 'wkb_le_1'],
    ['coa_2a', 'wkb_le_2'],
  ]) {
    const newRepoPath = `${shadowOrganizationId}/${workbookId}/${connectorAccountId}`;
    expect(scratch.connections.get(connectorAccountId)).toMatchObject({
      repoPath: newRepoPath,
      userId: shadowUser.id,
      migrationLocked: false,
    });
    expect(scratch.reposOnDisk.has(newRepoPath)).toBe(true);
    expect(scratch.reposOnDisk.has(`org_real/${workbookId}/${connectorAccountId}`)).toBe(false);
  }
  expect(scratch.schedules.get('sch_1')).toMatchObject({
    organizationId: shadowOrganizationId,
    userId: shadowUser.id,
    enabled: true,
    disabledForMigration: false,
  });
  // The schedule the person had disabled stays disabled.
  expect(scratch.schedules.get('sch_2')).toMatchObject({
    organizationId: shadowOrganizationId,
    enabled: false,
    disabledForMigration: false,
  });
  expect(scratch.whalesyncPlanStatusByOrganizationId.get(shadowOrganizationId)).toBe('active');
  expect(scratch.whalesyncPlanStatusByOrganizationId.has('org_real')).toBe(false);
}

/** Holds after any step: a Live Export is never left on an account that has been unlinked from its team. */
function expectNoLiveExportOnAnUnlinkedAccount(scratch: FakeScratch): void {
  const realUser = scratch.users.get('usr_real') as FakeUser;
  if (!realUser.whalesyncTeamId) {
    expect(scratch.liveExportsCreatedBy('usr_real')).toHaveLength(0);
  }
}

function baseAccountState(overrides: Partial<RealScratchAccountState> = {}): RealScratchAccountState {
  return {
    userId: 'usr_real',
    whalesyncTeamId: 'tm_1',
    whalesyncUserId: 'wsu_1',
    organizationId: 'org_real',
    organizationMemberCount: 1,
    liveExportsCreatedByAccount: [],
    liveExportIdsInOrganizationCreatedByOthers: [],
    shadowUserWithTeamClerkId: null,
    liveExportsOnShadowUserLeftPaused: [],
    whalesyncPlanStatusOfOrganization: 'active',
    ...overrides,
  };
}

function liveExportState(overrides: Partial<LiveExportWorkbookState> = {}): LiveExportWorkbookState {
  return {
    workbookId: 'wkb_le',
    name: 'Live Export',
    organizationId: 'org_real',
    userId: 'usr_real',
    isPendingDelete: false,
    connections: [{ connectorAccountId: 'coa_1', repoPath: 'org_real/wkb_le/coa_1' }],
    scheduleCount: 1,
    workspacePermissionUserIdsOtherThanCreator: [],
    activeRoutineRunCount: 0,
    nonTerminalJobCount: 0,
    migrationLockedConnectionCount: 0,
    schedulesDisabledForMigrationCount: 0,
    ...overrides,
  };
}

const shadowUserFromPreviousRun = {
  userId: 'usr_shadow',
  organizationId: 'org_shadow',
  organizationMemberCount: 1,
  whalesyncTeamId: null,
  whalesyncUserId: null,
  email: null,
};

// ── Decisions ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe('decideRealScratchAccountMigration', () => {
  it('unlinks an account that holds no Live Export', () => {
    expect(decideRealScratchAccountMigration(baseAccountState())).toEqual({ branch: 'unlink' });
  });

  it('moves an account that holds Live Exports to a new shadow user', () => {
    expect(
      decideRealScratchAccountMigration(baseAccountState({ liveExportsCreatedByAccount: [liveExportState()] })),
    ).toEqual({ branch: 'move', shadowUser: 'create' });
  });

  it("finishes a previous run's move, never just unlinking, once every Live Export is already on its shadow user", () => {
    expect(
      decideRealScratchAccountMigration(baseAccountState({ shadowUserWithTeamClerkId: shadowUserFromPreviousRun })),
    ).toEqual({ branch: 'move', shadowUser: 'reuse' });
  });

  it("accepts a connection repo path already in the previous run's organization", () => {
    expect(
      decideRealScratchAccountMigration(
        baseAccountState({
          shadowUserWithTeamClerkId: shadowUserFromPreviousRun,
          liveExportsCreatedByAccount: [
            liveExportState({ connections: [{ connectorAccountId: 'coa_1', repoPath: 'org_shadow/wkb_le/coa_1' }] }),
          ],
        }),
      ),
    ).toEqual({ branch: 'move', shadowUser: 'reuse' });
  });

  it.each([
    ['no_organization', baseAccountState({ organizationId: null })],
    ['organization_has_other_members', baseAccountState({ organizationMemberCount: 2 })],
    [
      'live_export_created_by_another_user',
      baseAccountState({ liveExportIdsInOrganizationCreatedByOthers: ['wkb_x'] }),
    ],
    [
      'live_export_in_another_organization',
      baseAccountState({ liveExportsCreatedByAccount: [liveExportState({ organizationId: 'org_other' })] }),
    ],
    [
      'live_export_pending_delete',
      baseAccountState({ liveExportsCreatedByAccount: [liveExportState({ isPendingDelete: true })] }),
    ],
    [
      'live_export_shared_with_another_user',
      baseAccountState({
        liveExportsCreatedByAccount: [liveExportState({ workspacePermissionUserIdsOtherThanCreator: ['usr_other'] })],
      }),
    ],
    [
      'routine_run_in_progress',
      baseAccountState({ liveExportsCreatedByAccount: [liveExportState({ activeRoutineRunCount: 1 })] }),
    ],
    [
      'job_in_progress',
      baseAccountState({ liveExportsCreatedByAccount: [liveExportState({ nonTerminalJobCount: 1 })] }),
    ],
    [
      'no_whalesync_team_id',
      baseAccountState({ whalesyncTeamId: null, liveExportsCreatedByAccount: [liveExportState()] }),
    ],
    [
      'team_already_has_a_pure_shadow_user',
      baseAccountState({ shadowUserWithTeamClerkId: { ...shadowUserFromPreviousRun, whalesyncTeamId: 'tm_1' } }),
    ],
    [
      'team_already_has_a_pure_shadow_user',
      baseAccountState({ shadowUserWithTeamClerkId: { ...shadowUserFromPreviousRun, organizationMemberCount: 2 } }),
    ],
    [
      'connection_repo_path_unexpected',
      baseAccountState({
        liveExportsCreatedByAccount: [
          liveExportState({ connections: [{ connectorAccountId: 'coa_1', repoPath: 'org_x/wkb_le/coa_1' }] }),
        ],
      }),
    ],
    [
      'connection_repo_path_unexpected',
      baseAccountState({
        liveExportsCreatedByAccount: [
          liveExportState({ connections: [{ connectorAccountId: 'coa_1', repoPath: null }] }),
        ],
      }),
    ],
  ])('skips with %s', (skipReason, account) => {
    const decision = decideRealScratchAccountMigration(account);
    expect(decision.branch).toBe('skip');
    expect(decision.branch === 'skip' && decision.skipReasons).toContain(skipReason);
  });

  it('unlinks an account with no team id and no Live Export (a link that never got its team)', () => {
    expect(decideRealScratchAccountMigration(baseAccountState({ whalesyncTeamId: null }))).toEqual({
      branch: 'unlink',
    });
  });
});

// ── Runs ──────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('migrateRealScratchAccountOffWhalesyncTeam', () => {
  it('moves every Live Export to a new pure shadow user, then unlinks the account, and a re-run does nothing', async () => {
    const scratch = makeAccountWithLiveExports();

    const report = await migrateRealScratchAccountOffWhalesyncTeam('usr_real', scratch.deps(), { dryRun: false });

    expect(report.outcome).toBe('moved');
    expect(report.whalesyncPlanCopy).toBe('copied');
    expectAccountMovedOffTeam(scratch);
    // wkb_le_2 had no scratch repo: reported, not fatal.
    expect(
      report.liveExports.find((l) => l.workbookId === 'wkb_le_2')?.repoMoves.find((m) => m.kind === 'scratch')?.outcome,
    ).toBe('no_repo');
    // One audit entry in each organization per Live Export.
    expect(scratch.auditLogEntries).toHaveLength(4);

    const rerun = await migrateRealScratchAccountOffWhalesyncTeam('usr_real', scratch.deps(), { dryRun: false });
    expect(rerun.outcome).toBe('not_a_candidate');
    expect(scratch.createdShadowUserCount).toBe(1);
  });

  it('runs its steps in an order that cannot lose data', async () => {
    const scratch = makeAccountWithLiveExports();

    await migrateRealScratchAccountOffWhalesyncTeam('usr_real', scratch.deps(), { dryRun: false });

    const log = scratch.mutatingCallLog;
    const indexOf = (callName: string): number => log.indexOf(callName);
    expect(log[0]).toBe('createShadowUserAwaitingTeam');
    expect(log[1]).toBe('copyWhalesyncPlanToShadowUser');
    for (const workbookId of ['wkb_le_1', 'wkb_le_2']) {
      const pauseIndex = indexOf(`pauseLiveExport:${workbookId}`);
      const rowsIndex = indexOf(`moveLiveExportRows:${workbookId}`);
      const releaseIndex = indexOf(`releaseLiveExport:${workbookId}`);
      const repoMoveIndexes = log
        .map((callName, index) => (callName.startsWith(`moveRepo:org_real/${workbookId}/`) ? index : -1))
        .filter((index) => index >= 0);
      expect(repoMoveIndexes.length).toBeGreaterThan(0);
      expect(Math.min(...repoMoveIndexes)).toBeGreaterThan(pauseIndex);
      expect(Math.max(...repoMoveIndexes)).toBeLessThan(rowsIndex);
      expect(releaseIndex).toBeGreaterThan(rowsIndex);
    }
    // The unlink, which hands the team over, comes last.
    expect(log.filter((callName) => callName !== 'logAudit').at(-1)).toBe('unlinkRealScratchAccount');
  });

  it('unlinks an account that holds no Live Export without creating a shadow user', async () => {
    const scratch = makeAccountWithLiveExports();
    for (const workbookId of ['wkb_le_1', 'wkb_le_2']) {
      (scratch.workbooks.get(workbookId) as FakeWorkbook).managedBy = null;
    }

    const report = await migrateRealScratchAccountOffWhalesyncTeam('usr_real', scratch.deps(), { dryRun: false });

    expect(report.outcome).toBe('unlinked');
    expect(scratch.mutatingCallLog).toEqual(['unlinkRealScratchAccount']);
    expect(scratch.users.get('usr_real')).toMatchObject({ whalesyncTeamId: null, whalesyncUserId: null });
    expect([...scratch.users.values()].some((u) => u.clerkId === 'ws_tm_1')).toBe(false);
  });

  it('changes nothing on a dry run and reports what each step would do', async () => {
    const scratch = makeAccountWithLiveExports();

    const report = await migrateRealScratchAccountOffWhalesyncTeam('usr_real', scratch.deps(), { dryRun: true });

    expect(report.outcome).toBe('would_move');
    expect(scratch.mutatingCallLog).toEqual([]);
    expect(report.liveExports.map((l) => [l.workbookId, l.connectionCount, l.scheduleCount])).toEqual([
      ['wkb_le_1', 2, 1],
      ['wkb_le_2', 1, 1],
    ]);
    expect(report.liveExports[0].repoMoves).toEqual([
      {
        kind: 'connection',
        connectorAccountId: 'coa_1a',
        fromRepoId: 'org_real/wkb_le_1/coa_1a',
        toRepoId: `${NEW_ORGANIZATION_ID_PLACEHOLDER}/wkb_le_1/coa_1a`,
      },
      {
        kind: 'connection',
        connectorAccountId: 'coa_1b',
        fromRepoId: 'org_real/wkb_le_1/coa_1b',
        toRepoId: `${NEW_ORGANIZATION_ID_PLACEHOLDER}/wkb_le_1/coa_1b`,
      },
      {
        kind: 'workbook',
        fromRepoId: 'org_real/wkb_le_1/wkb_le_1',
        toRepoId: `${NEW_ORGANIZATION_ID_PLACEHOLDER}/wkb_le_1/wkb_le_1`,
      },
      {
        kind: 'scratch',
        fromRepoId: 'org_real/wkb_le_1/scratch',
        toRepoId: `${NEW_ORGANIZATION_ID_PLACEHOLDER}/wkb_le_1/scratch`,
      },
    ]);
    const reportLines = formatRealScratchAccountMigrationReport(report);
    expect(reportLines[0]).toContain('usr_real: would_move');
    expect(reportLines[0]).toContain('team tm_1');
  });

  it('skips, releasing the Live Export, when a routine run starts after the account was read', async () => {
    const scratch = makeAccountWithLiveExports();
    scratch.afterPause = (workbookId) => {
      (scratch.workbooks.get(workbookId) as FakeWorkbook).activeRoutineRunCount = 1;
    };

    const report = await migrateRealScratchAccountOffWhalesyncTeam('usr_real', scratch.deps(), { dryRun: false });

    expect(report).toMatchObject({ outcome: 'skipped', skipReasons: ['routine_run_in_progress'] });
    expect(scratch.connections.get('coa_1a')?.migrationLocked).toBe(false);
    expect(scratch.schedules.get('sch_1')).toMatchObject({ enabled: true, disabledForMigration: false });
    expect(scratch.reposOnDisk.has('org_real/wkb_le_1/coa_1a')).toBe(true);
    expect(scratch.users.get('usr_real')?.whalesyncTeamId).toBe('tm_1');

    // Once the run is over, the next run finishes the job with the same shadow user.
    (scratch.workbooks.get('wkb_le_1') as FakeWorkbook).activeRoutineRunCount = 0;
    scratch.afterPause = null;
    await migrateRealScratchAccountOffWhalesyncTeam('usr_real', scratch.deps(), { dryRun: false });
    expectAccountMovedOffTeam(scratch);
    expect(scratch.createdShadowUserCount).toBe(1);
  });

  it('skips with connection_busy, releasing the Live Export, when a connection does not drain', async () => {
    const scratch = makeAccountWithLiveExports();
    const drainTimeout = new Error('still active');
    drainTimeout.name = 'ConnectionDrainTimeoutError';
    scratch.throwOnPause = drainTimeout;

    const report = await migrateRealScratchAccountOffWhalesyncTeam('usr_real', scratch.deps(), { dryRun: false });

    expect(report).toMatchObject({ outcome: 'skipped', skipReasons: ['connection_busy'] });
    expect(scratch.connections.get('coa_1a')?.migrationLocked).toBe(false);
    expect(scratch.schedules.get('sch_1')).toMatchObject({ enabled: true, disabledForMigration: false });
  });

  it('leaves the account linked when a session creates a Live Export mid-run, and the next run moves it', async () => {
    const scratch = makeAccountWithLiveExports();
    scratch.afterPause = (workbookId) => {
      if (workbookId === 'wkb_le_2' && !scratch.workbooks.has('wkb_le_3')) {
        scratch.workbooks.set('wkb_le_3', {
          id: 'wkb_le_3',
          name: 'wkb_le_3',
          organizationId: 'org_real',
          userId: 'usr_real',
          managedBy: 'ws_export',
          isPendingDelete: false,
          permissionUserIds: ['usr_real'],
          activeRoutineRunCount: 0,
          nonTerminalJobCount: 0,
        });
      }
    };

    const report = await migrateRealScratchAccountOffWhalesyncTeam('usr_real', scratch.deps(), { dryRun: false });
    expect(report).toMatchObject({ outcome: 'skipped', skipReasons: ['live_export_created_during_migration'] });
    expect(scratch.users.get('usr_real')?.whalesyncTeamId).toBe('tm_1');

    scratch.afterPause = null;
    const rerun = await migrateRealScratchAccountOffWhalesyncTeam('usr_real', scratch.deps(), { dryRun: false });
    expect(rerun.outcome).toBe('moved');
    expectAccountMovedOffTeam(scratch);
    expect(scratch.workbooks.get('wkb_le_3')?.userId).toBe('usr_shadow_1');
  });

  it('leaves a Live Export paused when it fails between its repo moves and its row move, and the next run finishes it', async () => {
    const scratch = makeAccountWithLiveExports();
    scratch.failRepoMoveFrom = 'org_real/wkb_le_1/coa_1b';

    const error = await migrateRealScratchAccountOffWhalesyncTeam('usr_real', scratch.deps(), { dryRun: false }).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(RealScratchAccountMigrationFailed);
    const partialReport = (error as RealScratchAccountMigrationFailed).partialReport;
    expect(partialReport.liveExportIdsLeftPausedForNextRun).toEqual(['wkb_le_1']);
    expect(formatRealScratchAccountMigrationReport(partialReport).join('\n')).toContain('LEFT PAUSED wkb_le_1');
    // Repos and rows disagree (coa_1a moved, its row didn't), so nothing may run: still locked and disabled.
    expect(scratch.reposOnDisk.has('org_shadow_1/wkb_le_1/coa_1a')).toBe(true);
    expect(scratch.connections.get('coa_1a')).toMatchObject({
      repoPath: 'org_real/wkb_le_1/coa_1a',
      migrationLocked: true,
    });
    expect(scratch.schedules.get('sch_1')).toMatchObject({ enabled: false, disabledForMigration: true });
    expect(scratch.users.get('usr_real')?.whalesyncTeamId).toBe('tm_1');

    scratch.failRepoMoveFrom = null;
    const rerun = await migrateRealScratchAccountOffWhalesyncTeam('usr_real', scratch.deps(), { dryRun: false });
    expect(rerun.outcome).toBe('moved');
    expectAccountMovedOffTeam(scratch);
  });

  it('counts a lapsed Whalesync plan as not copied', async () => {
    const scratch = makeAccountWithLiveExports();
    scratch.whalesyncPlanStatusByOrganizationId.set('org_real', 'expired');

    const report = await migrateRealScratchAccountOffWhalesyncTeam('usr_real', scratch.deps(), { dryRun: false });

    expect(report.outcome).toBe('moved');
    expect(report.whalesyncPlanCopy).toBe('inactive_not_copied');
  });

  // A crash before each mutating step, then a fresh run. Every step boundary is covered, including inside the
  // per-Live Export sequence and between the last release and the unlink.
  describe('resumes after a crash before any step', () => {
    const scratchForCounting = makeAccountWithLiveExports();
    let totalMutatingCallCount = 0;
    beforeAll(async () => {
      await migrateRealScratchAccountOffWhalesyncTeam('usr_real', scratchForCounting.deps(), { dryRun: false });
      totalMutatingCallCount = scratchForCounting.mutatingCallLog.length;
    });

    it('has steps to crash between', () => {
      expect(totalMutatingCallCount).toBeGreaterThan(10);
      // Every step has a crash case below.
      expect(totalMutatingCallCount).toBeLessThanOrEqual(30);
    });

    for (let crashBeforeMutatingCallNumber = 1; crashBeforeMutatingCallNumber <= 30; crashBeforeMutatingCallNumber++) {
      it(`crash before mutating call #${crashBeforeMutatingCallNumber}, then a re-run, ends moved with nothing duplicated`, async () => {
        if (crashBeforeMutatingCallNumber > totalMutatingCallCount) {
          return;
        }
        const scratch = makeAccountWithLiveExports();
        scratch.crashBeforeMutatingCallNumber = crashBeforeMutatingCallNumber;

        await expect(
          migrateRealScratchAccountOffWhalesyncTeam('usr_real', scratch.deps(), { dryRun: false }),
        ).rejects.toThrow('simulated crash');
        expectNoLiveExportOnAnUnlinkedAccount(scratch);

        scratch.restart();
        const rerun = await migrateRealScratchAccountOffWhalesyncTeam('usr_real', scratch.deps(), { dryRun: false });

        // A crash just before the last audit entries leaves nothing for the re-run to do.
        expect(['moved', 'not_a_candidate']).toContain(rerun.outcome);
        expectAccountMovedOffTeam(scratch);
        expect(scratch.createdShadowUserCount).toBe(1);

        scratch.restart();
        const thirdRun = await migrateRealScratchAccountOffWhalesyncTeam('usr_real', scratch.deps(), {
          dryRun: false,
        });
        expect(thirdRun.outcome).toBe('not_a_candidate');
        expect(scratch.mutatingCallLog).toEqual([]);
      });
    }
  });
});

describe('whalesyncSubscriptionPayloadFromWhalesyncPlanRow', () => {
  it('copies the recorded Whalesync status, metadata, and expiration', () => {
    expect(
      whalesyncSubscriptionPayloadFromWhalesyncPlanRow({
        stripeStatus: 'active',
        metadata: {
          whalesyncStatus: 'active',
          whalesyncProductType: 'live_export',
          liveExportRecordCountLimit: 50000,
          liveExportCadence: 'hourly',
        },
        expiration: new Date('2027-01-01T00:00:00.000Z'),
      }),
    ).toEqual({
      status: 'active',
      whalesyncProductType: 'live_export',
      liveExportRecordCountLimit: 50000,
      liveExportCadence: 'hourly',
      expiresAt: '2027-01-01T00:00:00.000Z',
    });
  });

  it('falls back to the Stripe-style status when the metadata has none', () => {
    const expiration = new Date('2126-01-01T00:00:00.000Z');
    expect(
      whalesyncSubscriptionPayloadFromWhalesyncPlanRow({ stripeStatus: 'active', metadata: null, expiration }),
    ).toEqual(expect.objectContaining({ status: 'active', expiresAt: expiration.toISOString() }));
    expect(
      whalesyncSubscriptionPayloadFromWhalesyncPlanRow({ stripeStatus: 'canceled', metadata: {}, expiration }).status,
    ).toBe('expired');
  });
});

describe('moveRepoOnScratchGit', () => {
  const scratchGitThatThrows = (error: Error) => ({ moveRepo: jest.fn().mockRejectedValue(error) });

  it('reports moved and already moved', async () => {
    await expect(
      moveRepoOnScratchGit({ moveRepo: jest.fn().mockResolvedValue({ moved: true }) }, 'a/b/c', 'd/b/c'),
    ).resolves.toBe('moved');
    await expect(
      moveRepoOnScratchGit({ moveRepo: jest.fn().mockResolvedValue({ moved: false }) }, 'a/b/c', 'd/b/c'),
    ).resolves.toBe('already_moved');
  });

  it("counts only scratch-git's neither-repo 404 as nothing to move", async () => {
    const neitherRepo = new ScratchGitNotFoundError(
      '/api/repo/manage/move',
      '{"data":{"error":"Neither the source repo a/b/c nor the destination repo d/b/c exists","reason":"neither_repo_exists"}}',
    );
    await expect(moveRepoOnScratchGit(scratchGitThatThrows(neitherRepo), 'a/b/c', 'd/b/c')).resolves.toBe('no_repo');
  });

  it('throws any other 404, such as from a scratch-git without the move route', async () => {
    const unknownRoute = new ScratchGitNotFoundError('/api/repo/manage/move', '');
    await expect(moveRepoOnScratchGit(scratchGitThatThrows(unknownRoute), 'a/b/c', 'd/b/c')).rejects.toBe(unknownRoute);
  });
});
