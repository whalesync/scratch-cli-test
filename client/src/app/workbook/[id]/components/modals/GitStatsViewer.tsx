import { Code, Text, Tooltip } from '@mantine/core';

interface GitStatsViewerProps {
  stats: string;
}

const STATS_DESCRIPTIONS: Record<string, string> = {
  count: 'The number of loose (unpacked) objects. High numbers indicate a need for GC.',
  size: 'The total disk space occupied by loose objects, in kilobytes.',
  'in-pack': 'The number of objects securely compressed inside pack files.',
  packs: 'The number of pack files. Fewer pack files generally means faster performance.',
  'size-pack': 'The total disk space occupied by all pack files, in kilobytes.',
  'prune-packable': 'The number of loose objects that are already in packed form and can be safely deleted.',
  garbage: 'The number of completely unrecognized or orphan files in the object database.',
  'size-garbage': 'The total disk space occupied by garbage files, in kilobytes.',
};

export function GitStatsViewer({ stats }: GitStatsViewerProps) {
  const lines = stats.split('\n').filter((line) => line.trim().length > 0);

  return (
    <Code block style={{ whiteSpace: 'pre-wrap' }}>
      {lines.map((line, i) => {
        const parts = line.split(':');
        if (parts.length < 2) {
          return <div key={i}>{line}</div>;
        }

        const key = parts[0].trim();
        const value = parts.slice(1).join(':');
        const desc = STATS_DESCRIPTIONS[key];

        if (!desc) {
          return <div key={i}>{line}</div>;
        }

        return (
          <div key={i}>
            <Tooltip label={desc} position="right" withArrow withinPortal>
              <Text span style={{ cursor: 'help', borderBottom: '1px dotted currentColor' }}>
                {key}
              </Text>
            </Tooltip>
            {':' + value}
          </div>
        );
      })}
    </Code>
  );
}
