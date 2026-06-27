// Aggregator entry for /design-sync's converter. Our design system isn't a published package
// with a dist/ — it lives inside the renderer — so this module re-exports the components the
// Storybook stories use, letting the converter bundle them into window.<globalName>.
export {
  Box,
  Checkbox,
  Group,
  MantineProvider,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
export * from '../src/renderer/src/components/base/buttons';
export * from '../src/renderer/src/components/base/text';
// The theme object, exported so cfg.provider can $ref it. We deliberately do NOT re-export
// AppMantineProvider: it pulls in @mantine/notifications, which resolves @mantine/core via CJS
// while our components import it via ESM — bundling two @mantine/core copies (two MantineContexts),
// so the provider's context is invisible to the components. cfg.provider wraps in MantineProvider
// directly instead.
export { Plus } from 'lucide-react';
export { SCRATCH_MANTINE_THEME } from '../src/renderer/src/theme/theme';
// Composed screens — faithful reproductions of real app surfaces (the "complete picture").
export { ConnectionsPanel } from '../src/renderer/src/components/base/ds/screens/ConnectionsPanel';
export { PublishHistoryPanel } from '../src/renderer/src/components/base/ds/screens/PublishHistoryPanel';
export { RecordDetailView } from '../src/renderer/src/components/base/ds/screens/RecordDetailView';
export { SettingsPanel } from '../src/renderer/src/components/base/ds/screens/SettingsPanel';
export { ValidationPanel } from '../src/renderer/src/components/base/ds/screens/ValidationPanel';
export { WorkspaceShell } from '../src/renderer/src/components/base/ds/screens/WorkspaceShell';
// Phase 3 — modals & flows.
export { ChooseTablesModal } from '../src/renderer/src/components/base/ds/screens/ChooseTablesModal';
export { CreateConnectionModal } from '../src/renderer/src/components/base/ds/screens/CreateConnectionModal';
export { PublishProgressModal } from '../src/renderer/src/components/base/ds/screens/PublishProgressModal';
export { PublishReviewModal } from '../src/renderer/src/components/base/ds/screens/PublishReviewModal';
export { PullProgressModal } from '../src/renderer/src/components/base/ds/screens/PullProgressModal';
// Phase 4 — onboarding, home & settings pages.
export { HomePage } from '../src/renderer/src/components/base/ds/screens/HomePage';
export { LoginPage } from '../src/renderer/src/components/base/ds/screens/LoginPage';
export { SettingsBillingPage } from '../src/renderer/src/components/base/ds/screens/SettingsBillingPage';
export { SettingsUserPage } from '../src/renderer/src/components/base/ds/screens/SettingsUserPage';
export { WelcomePage } from '../src/renderer/src/components/base/ds/screens/WelcomePage';
