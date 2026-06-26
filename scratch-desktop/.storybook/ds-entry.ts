// Aggregator entry for /design-sync's converter. Our design system isn't a published package
// with a dist/ — it lives inside the renderer — so this module re-exports the components the
// Storybook stories use, letting the converter bundle them into window.<globalName>.
export * from '../src/renderer/src/components/base/buttons';
export * from '../src/renderer/src/components/base/text';
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
// The theme object, exported so cfg.provider can $ref it. We deliberately do NOT re-export
// AppMantineProvider: it pulls in @mantine/notifications, which resolves @mantine/core via CJS
// while our components import it via ESM — bundling two @mantine/core copies (two MantineContexts),
// so the provider's context is invisible to the components. cfg.provider wraps in MantineProvider
// directly instead.
export { SCRATCH_MANTINE_THEME } from '../src/renderer/src/theme/theme';
export { Plus } from 'lucide-react';
