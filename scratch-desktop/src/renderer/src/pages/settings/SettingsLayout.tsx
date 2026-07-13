import { Text12Book, Text12Medium, Text13Medium, Text13Regular } from '@/components/base/text';
import { StyledLucideIcon } from '@/components/icons/StyledLucideIcon';
import { Box, Stack, UnstyledButton } from '@mantine/core';
import { ArrowLeftIcon, CreditCardIcon, LucideIcon, SettingsIcon, UserIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';

const SIDEBAR_WIDTH = 220;

interface SettingsNavItem {
  label: string;
  icon: LucideIcon;
  path: string;
}

// Billing, User. Deep links (scratch://settings/<sub>) and the bare /settings index both resolve into one of
// these. The Application sub-section is temporarily hidden (its page/route still exist — see App.tsx); re-add the
// entry here (and to the deep-link allowlist + defaults) to bring it back.
const SETTINGS_NAV_ITEMS: SettingsNavItem[] = [
  { label: 'Billing', icon: CreditCardIcon, path: '/settings/billing' },
  { label: 'User', icon: UserIcon, path: '/settings/user' },
];

function SettingsNavButton({ item, active }: { item: SettingsNavItem; active: boolean }) {
  const navigate = useNavigate();
  const color = active ? 'var(--fg-primary)' : 'var(--fg-secondary)';
  return (
    <UnstyledButton
      px="sm"
      py={8}
      onClick={() => void navigate(item.path)}
      style={{
        width: '100%',
        backgroundColor: active ? 'var(--bg-selected)' : 'transparent',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}
    >
      <StyledLucideIcon Icon={item.icon} size="sm" c={color} />
      <Text13Regular c={color}>{item.label}</Text13Regular>
    </UnstyledButton>
  );
}

/**
 * Dimmed version + build-commit footer pinned to the bottom-left of the Settings sidebar. The version comes
 * from the main process (`app.getVersion()`, i.e. package.json's version stamped at release time) and the short
 * commit hash is baked into the renderer bundle at build time (`__GIT_COMMIT_HASH__`, see electron.vite.config.ts).
 */
function SettingsSidebarBuildInfoFooter() {
  const [appVersion, setAppVersion] = useState<string | null>(null);
  useEffect(() => {
    void window.scratchDesktop.getAppVersion().then(setAppVersion);
  }, []);

  return (
    <Box px="sm" py={8} style={{ borderTop: '0.5px solid var(--fg-divider)' }}>
      {appVersion && <Text12Book c="var(--fg-muted)">v{appVersion}</Text12Book>}
      <Text12Book c="var(--fg-muted)">{__GIT_COMMIT_HASH__}</Text12Book>
    </Box>
  );
}

/**
 * Full-screen shell for the desktop Settings view: a left sidebar (Application / User / Billing) and a back
 * button, with the active sub-page rendered through `<Outlet/>`. Rendered outside the workspace `Layout`, so it
 * has no trial banner or workspace chrome — mirroring the web client's `/settings` layout.
 */
export function SettingsLayout() {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  // Leave Settings back to the last open workspace if there is one, otherwise the home picker. Preferred over
  // history(-1) because the user may have arrived here via a deep link (e.g. the Stripe billing return) with no
  // in-app history to go back to.
  const goBack = (): void => {
    void (async () => {
      try {
        const currentWorkspaceId = await window.scratchPreferences.getCurrentWorkspaceId();
        void navigate(currentWorkspaceId ? `/workspace/${currentWorkspaceId}` : '/');
      } catch {
        void navigate('/');
      }
    })();
  };

  return (
    <Box
      style={{
        display: 'flex',
        height: '100vh',
        width: '100vw',
        overflow: 'hidden',
        backgroundColor: 'var(--bg-panel)',
        padding: 6,
      }}
    >
      <Stack
        gap={0}
        style={{
          width: SIDEBAR_WIDTH,
          minWidth: SIDEBAR_WIDTH,
          height: '100%',
          border: '0.5px solid var(--fg-divider)',
          borderRadius: 4,
          backgroundColor: 'var(--bg-base)',
          flexShrink: 0,
        }}
      >
        <Box px="sm" py="xs" style={{ borderBottom: '0.5px solid var(--fg-divider)' }}>
          <Box style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <UnstyledButton
              type="button"
              aria-label="Go back"
              onClick={goBack}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 24,
                height: 24,
                borderRadius: 4,
              }}
            >
              <StyledLucideIcon Icon={ArrowLeftIcon} size="sm" c="var(--fg-muted)" />
            </UnstyledButton>
            <Box style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <StyledLucideIcon Icon={SettingsIcon} size="sm" c="var(--fg-muted)" />
              <Text13Medium c="var(--fg-primary)">Settings</Text13Medium>
            </Box>
          </Box>
        </Box>
        <Box style={{ flex: 1, minHeight: 0, overflowY: 'auto' }} py="xs">
          <Stack gap={0}>
            <Box px="sm" py={6}>
              <Text12Medium c="var(--fg-muted)" style={{ textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Settings
              </Text12Medium>
            </Box>
            {SETTINGS_NAV_ITEMS.map((item) => (
              <SettingsNavButton key={item.path} item={item} active={pathname.startsWith(item.path)} />
            ))}
          </Stack>
        </Box>
        <SettingsSidebarBuildInfoFooter />
      </Stack>

      <Box
        style={{
          flex: 1,
          minWidth: 0,
          height: '100%',
          overflow: 'hidden',
          border: '0.5px solid var(--fg-divider)',
          borderRadius: 4,
          backgroundColor: 'var(--bg-base)',
          marginLeft: 6,
        }}
      >
        <Outlet />
      </Box>
    </Box>
  );
}
