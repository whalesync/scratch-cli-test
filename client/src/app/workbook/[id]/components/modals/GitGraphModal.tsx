import { workbookApi } from '@/lib/api/workbook';
import { BranchUserApi } from '@gitgraph/core';
import { Gitgraph, templateExtend, TemplateName } from '@gitgraph/react';
import type { ReactSvgElement } from '@gitgraph/react/lib/types';
import { ActionIcon, Box, Code, Loader, Modal, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { WorkbookId } from '@spinner/shared-types';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { Code2, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

// Import dayjs
dayjs.extend(relativeTime);

interface GitGraphModalProps {
  workbookId: WorkbookId;
  opened: boolean;
  onClose: () => void;
  connectorAccountId?: string;
  useConfigRepo?: boolean;
}

// Helper to build commit info
const buildCommitInfo = (commit: CommitData, refs: RefData[]) => {
  const msg = commit.message.trim().split('\n')[0];
  const timeAgo = dayjs.unix(commit.timestamp).fromNow();
  const refString =
    refs.length > 0
      ? refs
          .map((r) => {
            const icon = r.type === 'branch' ? '⎇' : '🏷';
            return `[${icon} ${r.name}]`;
          })
          .join(' ')
      : '';

  const parentString =
    commit.parents.length > 0 ? ` {parents: ${commit.parents.map((p) => p.substring(0, 7)).join(', ')}}` : '';

  const line1 = `${commit.oid.substring(0, 7)} - ${timeAgo} ${refString}${parentString}`;
  return { subject: line1, body: msg };
};

interface CommitData {
  oid: string;
  message: string;
  parents: string[];
  timestamp: number;
  author: { name: string; email: string };
}

interface RefData {
  name: string;
  oid: string;
  type: 'branch' | 'tag';
}

interface GraphData {
  commits: CommitData[];
  refs: RefData[];
}

export const GitGraphModal = ({
  workbookId,
  opened,
  onClose,
  connectorAccountId,
  useConfigRepo,
}: GitGraphModalProps) => {
  const [data, setData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(false);
  const [renderKey, setRenderKey] = useState(0);

  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    if (opened) {
      setRenderKey((k) => k + 1);
      fetchGraph();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, workbookId, connectorAccountId, useConfigRepo]);

  const fetchGraph = async () => {
    setLoading(true);
    try {
      const graphData = await workbookApi.getGraph(workbookId, connectorAccountId, useConfigRepo);
      setData(graphData as GraphData);
    } catch (e) {
      console.error(e);
      notifications.show({
        title: 'Error',
        message: 'Could not load git graph.',
        color: 'red',
      });
    } finally {
      setLoading(false);
    }
  };

  const title = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span>Git Graph</span>
      <ActionIcon
        size="sm"
        variant="subtle"
        onClick={() => {
          setRenderKey((k) => k + 1);
          fetchGraph();
        }}
        title="Refresh"
        loading={loading}
      >
        <RefreshCw size={16} />
      </ActionIcon>
      {data && (
        <ActionIcon
          size="sm"
          variant={showRaw ? 'filled' : 'subtle'}
          onClick={() => setShowRaw(!showRaw)}
          title="Toggle Raw Data"
        >
          <Code2 size={16} />
        </ActionIcon>
      )}
    </div>
  );

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={title}
      size="xl"
      scrollAreaComponent={Box}
      styles={{ body: { padding: 0 } }}
    >
      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
          <Loader />
        </div>
      ) : !data || data.commits.length === 0 ? (
        <Text p="xl">No commits found</Text>
      ) : showRaw ? (
        <Code block style={{ whiteSpace: 'pre-wrap', margin: 20 }}>
          {JSON.stringify(data, null, 2)}
        </Code>
      ) : (
        <GitGraphRenderer key={renderKey} data={data} />
      )}
    </Modal>
  );
};

// Separate component to handle rendering with ref guard
const GitGraphRenderer = ({ data }: { data: GraphData }) => {
  const hasPopulatedRef = useRef(false);

  return (
    <div style={{ padding: 20 }}>
      {/* Gitgraph options remain same */}
      <Gitgraph
        options={{
          template: templateExtend(TemplateName.Metro, {
            colors: ['#0088CC', '#27ae60', '#e74c3c', '#f39c12', '#9b59b6'],
            branch: {
              lineWidth: 2,
              spacing: 30,
              label: {
                display: false,
                font: '10px sans-serif',
                borderRadius: 4,
              },
            },
            commit: {
              spacing: 15,
              dot: { size: 6 },
              message: {
                displayAuthor: false,
                displayHash: false,
                font: '12px monospace',
              },
            },
          }),
        }}
      >
        {(gitgraph) => {
          if (hasPopulatedRef.current) return;
          hasPopulatedRef.current = true;

          // 1. Index commits
          const commitMap = new Map<string, CommitData>();
          data.commits.forEach((c) => commitMap.set(c.oid, c));

          // 2. Map OID -> Refs
          const refsByOid = new Map<string, RefData[]>();
          data.refs.forEach((r) => {
            const list = refsByOid.get(r.oid) || [];
            list.push(r);
            refsByOid.set(r.oid, list);
          });

          // 3. Pre-calculate branch assignment (Walk back from tips)
          const oidToBranchName = new Map<string, string>();
          const branchTips = data.refs.filter((r) => r.type === 'branch');
          const priority = ['main', 'master', 'dirty'];

          // Sort pointers by priority then name
          branchTips.sort((a, b) => {
            const idxA = priority.indexOf(a.name);
            const idxB = priority.indexOf(b.name);
            if (idxA > -1 && idxB > -1) return idxA - idxB;
            if (idxA > -1) return -1;
            if (idxB > -1) return 1;
            return a.name.localeCompare(b.name);
          });

          // Walk back from each tip
          for (const tip of branchTips) {
            let currentOid: string | undefined = tip.oid;
            while (currentOid) {
              if (oidToBranchName.has(currentOid)) {
                // Already claimed by a higher priority branch
                break;
              }
              oidToBranchName.set(currentOid, tip.name);

              const commit = commitMap.get(currentOid);
              if (!commit || commit.parents.length === 0) {
                break;
              }
              // Follow first parent for main line of history
              currentOid = commit.parents[0];
            }
          }

          // 4. Sort commits topologically (Parents before Children, then Oldest first)
          const sortedCommits: CommitData[] = [];

          {
            const commitOids = new Set(data.commits.map((c) => c.oid));
            const inDegree = new Map<string, number>(); // oid -> number of parents in dataset
            const childrenMap = new Map<string, string[]>(); // parent -> list of children

            // Initialize
            data.commits.forEach((c) => {
              inDegree.set(c.oid, 0);
              childrenMap.set(c.oid, []);
            });

            // Build Graph
            data.commits.forEach((child) => {
              let recognizedParents = 0;
              child.parents.forEach((p_oid) => {
                if (commitOids.has(p_oid)) {
                  recognizedParents++;
                  const siblings = childrenMap.get(p_oid) || [];
                  siblings.push(child.oid);
                  childrenMap.set(p_oid, siblings);
                }
              });
              inDegree.set(child.oid, recognizedParents);
            });

            // Queue of commits with 0 parents (roots in this dataset context)
            const queue = data.commits.filter((c) => (inDegree.get(c.oid) || 0) === 0);

            // Process
            while (queue.length > 0) {
              // Always pick the oldest available commit to keep chronological order
              queue.sort((a, b) => a.timestamp - b.timestamp);

              const current = queue.shift()!;
              sortedCommits.push(current);

              const children = childrenMap.get(current.oid) || [];
              for (const childOid of children) {
                const currentInDegree = (inDegree.get(childOid) || 0) - 1;
                inDegree.set(childOid, currentInDegree);

                if (currentInDegree === 0) {
                  const child = commitMap.get(childOid)!;
                  queue.push(child);
                }
              }
            }

            // Handle cycles / orphans (fallback to remaining commits sorted by timestamp)
            if (sortedCommits.length !== data.commits.length) {
              const processed = new Set(sortedCommits.map((c) => c.oid));
              const remaining = data.commits
                .filter((c) => !processed.has(c.oid))
                .sort((a, b) => a.timestamp - b.timestamp);
              sortedCommits.push(...remaining);
            }
          }

          // 5. Render loop
          const branchObjs = new Map<string, BranchUserApi<ReactSvgElement>>();

          for (const commit of sortedCommits) {
            const refs = refsByOid.get(commit.oid) || [];

            // Determine which visual branch this commit belongs to
            let targetBranchName = oidToBranchName.get(commit.oid);

            // Fallback for orphans or merged commits not reached by first-parent walk
            if (!targetBranchName) {
              if (commit.parents.length > 0) {
                // inherit from first parent if possible
                targetBranchName = oidToBranchName.get(commit.parents[0]);
              }
            }
            if (!targetBranchName) {
              targetBranchName = 'detached';
            }

            // Ensure branch object exists
            let branch = branchObjs.get(targetBranchName);
            if (!branch) {
              // Try to find a parent to branch off from
              if (commit.parents.length > 0) {
                const pOid = commit.parents[0];
                const parentBranchName = oidToBranchName.get(pOid) || 'main'; // best guess
                const parentBranch = branchObjs.get(parentBranchName);

                if (parentBranch) {
                  branch = parentBranch.branch(targetBranchName);
                } else {
                  branch = gitgraph.branch(targetBranchName);
                }
              } else {
                branch = gitgraph.branch(targetBranchName);
              }
              branchObjs.set(targetBranchName, branch);
            }

            // Update oid map dynamically for next iterations (in case we synthesized a fallback)
            oidToBranchName.set(commit.oid, targetBranchName);

            // Prepare commit info
            const { subject, body } = buildCommitInfo(commit, refs);

            const commitOptions = {
              subject,
              body,
            };

            // Handle merges (2+ parents)
            if (commit.parents.length > 1) {
              const otherParentOid = commit.parents[1];
              // The "other" parent might belong to a different branch
              const otherBranchName = oidToBranchName.get(otherParentOid);
              const otherBranch = otherBranchName ? branchObjs.get(otherBranchName) : undefined;

              if (otherBranch) {
                branch.merge({
                  branch: otherBranch,
                  commitOptions,
                });
              } else {
                branch.commit(commitOptions);
              }
            } else {
              branch.commit(commitOptions);
            }
          }
        }}
      </Gitgraph>
    </div>
  );
};
