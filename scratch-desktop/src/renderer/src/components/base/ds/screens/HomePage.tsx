// Faithful reproduction of the desktop app's Home screen — the workspace picker: downloaded
// workspaces + cloud workspaces, with the create-workspace action and footer. Self-contained; no
// IPC. From the real HomePage + WorkspaceCard source (DEV-10592).
import { Box, Group } from '@mantine/core';
import { Download, MoreHorizontal, Plus } from 'lucide-react';
import { ButtonPrimaryLight, ButtonSecondaryOutline, IconButtonGhost } from '../../buttons';
import { Text12Medium, Text12Regular, TextTitle1, TextTitle4 } from '../../text';

const DOWNLOADED = [{ name: 'QA Webflow', files: 62, services: ['#146EF5'] }];
const CLOUD = [
  { name: 'Marketing site', files: 248, services: ['#FCB400', '#146EF5'] },
  { name: 'Product CRM', files: 1320, services: ['#FF7A59'] },
];

function SectionLabel({ label, count }: { label: string; count: number }) {
  return (
    <Group gap={6} mt={16} mb={4} px={2}>
      <Text12Medium c="var(--fg-muted)" tt="uppercase" style={{ letterSpacing: '0.08em' }}>
        {label}
      </Text12Medium>
      <Text12Regular c="var(--fg-muted)" style={{ opacity: 0.7 }}>
        · {count}
      </Text12Regular>
    </Group>
  );
}

function ServiceIcons({ services, faded }: { services: string[]; faded?: boolean }) {
  return (
    <Group gap={6} style={{ opacity: faded ? 0.75 : 1 }}>
      {services.map((s, i) => (
        <Box key={i} style={{ width: 18, height: 18, borderRadius: 3, background: s }} />
      ))}
    </Group>
  );
}

export function HomePage() {
  return (
    <Box
      style={{
        width: 1100,
        height: 700,
        background: 'var(--bg-base)',
        border: '0.5px solid var(--fg-divider)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <Box style={{ flex: 1, overflow: 'hidden', paddingLeft: 32, paddingRight: 32 }}>
        <Box style={{ width: '66%', margin: '0 auto' }}>
          <Group pt={28} pb={12} justify="space-between">
            <TextTitle1>Your Workspaces</TextTitle1>
            <ButtonPrimaryLight size="sm" leftSection={<Plus size={14} />}>
              New Workspace
            </ButtonPrimaryLight>
          </Group>

          <SectionLabel label="Downloaded" count={DOWNLOADED.length} />
          {DOWNLOADED.map((w) => (
            <Group
              key={w.name}
              justify="space-between"
              wrap="nowrap"
              px={18}
              py={16}
              mb={10}
              style={{
                background: '#fff',
                border: '1px solid var(--fg-divider)',
                borderRadius: 10,
                boxShadow: '0 1px 3px rgba(0,0,0,.06)',
              }}
            >
              <Box style={{ minWidth: 0 }}>
                <TextTitle4>{w.name}</TextTitle4>
                <Group gap={8} align="center" mt={6}>
                  <ServiceIcons services={w.services} />
                  <Text12Regular c="var(--fg-muted)">{w.files.toLocaleString()} files</Text12Regular>
                </Group>
              </Box>
              <IconButtonGhost>
                <MoreHorizontal size={16} />
              </IconButtonGhost>
            </Group>
          ))}

          <SectionLabel label="In the cloud" count={CLOUD.length} />
          <Box
            style={{
              border: '1px dashed var(--fg-divider)',
              borderRadius: 10,
              background: '#fbfbf9',
              overflow: 'hidden',
            }}
          >
            {CLOUD.map((w, i) => (
              <Group
                key={w.name}
                justify="space-between"
                wrap="nowrap"
                px={14}
                py={10}
                style={{ borderTop: i > 0 ? '1px solid var(--fg-divider)' : 'none' }}
              >
                <Box style={{ minWidth: 0 }}>
                  <TextTitle4 c="var(--fg-secondary)">{w.name}</TextTitle4>
                  <Group gap={8} align="center" mt={6}>
                    <ServiceIcons services={w.services} faded />
                    <Text12Regular c="var(--fg-muted)">{w.files.toLocaleString()} files</Text12Regular>
                  </Group>
                </Box>
                <ButtonSecondaryOutline size="xs" leftSection={<Download size={14} />}>
                  Download to…
                </ButtonSecondaryOutline>
              </Group>
            ))}
          </Box>
        </Box>
      </Box>

      {/* footer */}
      <Group h={40} px={16} justify="space-between" style={{ borderTop: '1px solid var(--fg-divider)', flexShrink: 0 }}>
        <Group gap={8} align="center">
          <Box
            style={{
              width: 20,
              height: 20,
              borderRadius: '50%',
              background: 'var(--bg-selected)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text12Medium c="var(--fg-secondary)">t</Text12Medium>
          </Box>
          <Text12Regular c="var(--fg-secondary)">testing@whalesync.com</Text12Regular>
        </Group>
        <Text12Regular c="var(--fg-muted)">Test v1.4.0</Text12Regular>
      </Group>
    </Box>
  );
}
