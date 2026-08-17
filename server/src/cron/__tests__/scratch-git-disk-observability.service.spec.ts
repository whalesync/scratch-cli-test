import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { CustomMetric } from 'src/metrics/custom-metrics';
import { CustomMetricsService } from 'src/metrics/custom-metrics-service';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { ScratchGitDiskObservabilityService, parseLooseObjectCount } from '../scratch-git-disk-observability.service';

/** A realistic `git count-objects -v` block with a given loose-object `count:`. */
function countObjectsOutput(looseObjects: number): string {
  return [
    `count: ${looseObjects}`,
    `size: ${looseObjects * 4}`,
    'in-pack: 1000',
    'packs: 1',
    'size-pack: 2048',
    'prune-packable: 0',
    'garbage: 0',
    'size-garbage: 0',
  ].join('\n');
}

function makeService(deps: {
  // repoPath -> loose-object count, or the string 'throw' to simulate a per-repo failure.
  reposByPath: Record<string, number | 'throw'>;
}) {
  const connectorAccounts = Object.keys(deps.reposByPath).map((repoPath, index) => ({
    id: `coa_${index}`,
    repoPath,
  }));

  const db = {
    client: {
      connectorAccount: {
        findMany: jest.fn().mockResolvedValue(connectorAccounts),
      },
    },
  } as unknown as DbService;

  const getObjectCounts = jest.fn((repoPath: string) => {
    const value = deps.reposByPath[repoPath];
    if (value === 'throw') {
      throw new Error(`boom for ${repoPath}`);
    }
    return Promise.resolve({ stats: countObjectsOutput(value), gcInProgress: null });
  });
  const scratchGitService = { getObjectCounts } as unknown as ScratchGitService;

  const metricsService = { logValue: jest.fn() };

  const service = new ScratchGitDiskObservabilityService(
    db,
    scratchGitService,
    metricsService as unknown as CustomMetricsService,
  );
  return { service, getObjectCounts, metricsService };
}

describe('parseLooseObjectCount', () => {
  it('extracts the count: line from count-objects -v output', () => {
    expect(parseLooseObjectCount(countObjectsOutput(212116))).toBe(212116);
    expect(parseLooseObjectCount(countObjectsOutput(0))).toBe(0);
  });

  it('returns null when the count: line is absent/unparseable', () => {
    expect(parseLooseObjectCount('in-pack: 5\npacks: 1')).toBeNull();
    expect(parseLooseObjectCount('')).toBeNull();
    // A `count-` prefix that is not the loose-object line must not match.
    expect(parseLooseObjectCount('count-something: 9')).toBeNull();
  });
});

describe('ScratchGitDiskObservabilityService', () => {
  beforeEach(() => {
    jest.spyOn(WSLogger, 'info').mockImplementation();
    jest.spyOn(WSLogger, 'warn').mockImplementation();
    jest.spyOn(WSLogger, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it("emits the worst repo's loose-object count as the gauge", async () => {
    const { service, metricsService } = makeService({
      reposByPath: { 'org_a--wkb_a--coa_a': 42, 'org_b--wkb_b--coa_b': 212116, 'org_c--wkb_c--coa_c': 0 },
    });

    await service.emitDiskObservabilityMetrics();

    expect(metricsService.logValue).toHaveBeenCalledTimes(1);
    expect(metricsService.logValue).toHaveBeenCalledWith(CustomMetric.SCRATCH_GIT_REPO_LOOSE_OBJECTS, 212116);
  });

  it('skips a repo whose object-count read throws and still emits the max of the rest', async () => {
    const { service, metricsService } = makeService({
      reposByPath: { 'org_a--wkb_a--coa_a': 10, 'org_b--wkb_b--coa_b': 'throw', 'org_c--wkb_c--coa_c': 500 },
    });

    const warnSpy = jest.spyOn(WSLogger, 'warn');
    await service.emitDiskObservabilityMetrics();

    expect(metricsService.logValue).toHaveBeenCalledWith(CustomMetric.SCRATCH_GIT_REPO_LOOSE_OBJECTS, 500);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('emits 0 when there are no git-backed repos (a continuous series, not a gap)', async () => {
    const { service, metricsService, getObjectCounts } = makeService({ reposByPath: {} });

    await service.emitDiskObservabilityMetrics();

    expect(getObjectCounts).not.toHaveBeenCalled();
    expect(metricsService.logValue).toHaveBeenCalledWith(CustomMetric.SCRATCH_GIT_REPO_LOOSE_OBJECTS, 0);
  });
});
