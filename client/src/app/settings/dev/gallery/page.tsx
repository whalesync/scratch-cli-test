'use client';

import { ActionIconThreeDots } from '@/app/components/base/action-icons';
import { Badge, BadgeError, BadgeOK } from '@/app/components/base/badge';
import {
  ButtonCompactDanger,
  ButtonCompactPrimary,
  ButtonCompactSecondary,
  ButtonDangerLight,
  ButtonPrimaryLight,
  ButtonPrimarySolid,
  ButtonSecondaryGhost,
  ButtonSecondaryInline,
  ButtonSecondaryOutline,
  ButtonSecondarySolid,
  DevToolButton,
  IconButtonGhost,
  IconButtonInline,
  IconButtonOutline,
  IconButtonToolbar,
} from '@/app/components/base/buttons';
import {
  Text12Book,
  Text12Medium,
  Text12Regular,
  Text13Book,
  Text13Medium,
  Text13Regular,
  Text16Book,
  Text16Medium,
  Text16Regular,
  Text9Regular,
  TextMono12Regular,
  TextMono13Regular,
  TextTitle1,
  TextTitle2,
  TextTitle3,
  TextTitle4,
} from '@/app/components/base/text';
import { CircularProgress } from '@/app/components/CircularProgress';
import { CloseButtonInline } from '@/app/components/CloseButtonInline';
import { ConfigSection } from '@/app/components/ConfigSection';
import { CornerBoxedBadge } from '@/app/components/CornerBoxedBadge';
import { DebouncedTextArea } from '@/app/components/DebouncedTextArea';
import { DevToolPopover } from '@/app/components/DevToolPopover';
import { DotSpacer } from '@/app/components/DotSpacer';
import { ConnectorIcon } from '@/app/components/Icons/ConnectorIcon';
import { DecorativeBoxedIcon } from '@/app/components/Icons/DecorativeBoxedIcon';
import { ModelProviderIcon } from '@/app/components/Icons/ModelProvidericon';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { EmptyListInfoPanel, ErrorInfo, Info } from '@/app/components/InfoPanel';
import { LabelValuePair } from '@/app/components/LabelValuePair';
import MainContent from '@/app/components/layouts/MainContent';
import { LoaderWithMessage } from '@/app/components/LoaderWithMessage';
import { ConfirmDialog, useConfirmDialog } from '@/app/components/modals/ConfirmDialog';
import { RelativeDate } from '@/app/components/RelativeDate';
import { ToolIconButton } from '@/app/components/ToolIconButton';
import {
  Alert,
  Anchor,
  Box,
  Checkbox,
  Code,
  ColorSwatch,
  Divider,
  Group,
  Kbd,
  List,
  Loader,
  Menu,
  Popover,
  Stack,
  Tooltip,
} from '@mantine/core';
import { Service } from '@spinner/shared-types';
import {
  AlertTriangle,
  AlignEndHorizontal,
  Ambulance,
  Bird,
  BookMarked,
  BrainIcon,
  CheckIcon,
  CircleCheckBigIcon,
  Home,
  LayoutGridIcon,
  MessageSquareIcon,
  MoonStar,
  PenLineIcon,
  Plus,
  Settings,
  Trash2,
} from 'lucide-react';
import Image from 'next/image';
import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';

export default function DevComponentGalleryPage() {
  return (
    <MainContent>
      <MainContent.BasicHeader title="Component Gallery" Icon={LayoutGridIcon} />
      <MainContent.Body>
        <Stack w="100%" p="md">
          <Alert color="orange" icon={<BookMarked size={24} />}>
            For machine (and human) readable instructions on how to use these components, refer to{' '}
            <Code>UI_SYSTEM.md</Code>
          </Alert>
          <Text13Regular>This is a gallery of components and patterns to use in the application</Text13Regular>
          {/* Table of contents */}
          <List>
            <List.Item>
              <Anchor href="#shades">Key shades</Anchor>
            </List.Item>
            <List.Item>
              <Anchor href="#colors">Colors</Anchor>
            </List.Item>
            <List.Item>
              <Anchor href="#title-text">Text: title</Anchor>
            </List.Item>
            <List.Item>
              <Anchor href="#body-text">Text: body</Anchor>
            </List.Item>
            <List.Item>
              <Anchor href="#mono-text">Text: monospace</Anchor>
            </List.Item>
            <List.Item>
              <Anchor href="#buttons">Buttons</Anchor>
            </List.Item>
            <List.Item>
              <Anchor href="#action-icons">Action Icons</Anchor>
            </List.Item>
            <List.Item>
              <Anchor href="#input-components">Input Components</Anchor>
            </List.Item>
            <List.Item>
              <Anchor href="#badges">Badges</Anchor>
            </List.Item>
            <List.Item>
              <Anchor href="#loaders">Loaders</Anchor>
            </List.Item>
            <List.Item>
              <Anchor href="#icons">Icons</Anchor>
            </List.Item>
            <List.Item>
              <Anchor href="#formatting">Formatting</Anchor>
            </List.Item>
            <List.Item>
              <Anchor href="#info-panels">Info Panels</Anchor>
            </List.Item>
            <List.Item>
              <Anchor href="#dev-tool-components">Dev Tool Components</Anchor>
            </List.Item>
            <List.Item>
              <Anchor href="#patterns">Complete Patterns & Examples</Anchor>
            </List.Item>
            <List.Item>
              <Anchor href="#dialogs">Dialogs</Anchor>
            </List.Item>
          </List>
          <GallerySection id="shades" title="Key shades" />
          <Text12Book c="dimmed">
            These are single-color shades that adjust for light/dark mode. Use these for all panels and text.
          </Text12Book>
          <GalleryItem label="Background: base" notes="Main body/page background color">
            <ColorChip cssName="--bg-base" modeAware />
          </GalleryItem>
          <GalleryItem
            label="Background: panel"
            notes="Use this for elevated background region of panels and cards. AKA --mantine-color-gray-0, or Figma grey/1"
          >
            <ColorChip cssName="--bg-panel" modeAware />
          </GalleryItem>
          <GalleryItem
            label="Background: selected"
            notes="Use this as background for selected items. AKA --mantine-color-gray-1, or Figma grey/2"
          >
            <ColorChip cssName="--bg-selected" modeAware />
          </GalleryItem>
          <GalleryItem
            label="Foreground: primary"
            notes="Use for all main text. AKA --mantine-color-gray-9, or Figma grey/12"
          >
            <ColorChip cssName="--fg-primary" modeAware />
          </GalleryItem>
          <GalleryItem
            label="Foreground: secondary"
            notes="Use for secondary text: table headers, . AKA --mantine-color-gray-8, or Figma grey/11"
          >
            <ColorChip cssName="--fg-secondary" modeAware />
          </GalleryItem>
          <GalleryItem
            label="Foreground: muted"
            notes="Tertiary text, most toolbars or decorative icons. AKA --mantine-color-gray-7, or Figma grey/10"
          >
            <ColorChip cssName="--fg-muted" modeAware />
          </GalleryItem>
          <GalleryItem
            label="Foreground: divider"
            notes="Most dividers between sections. AKA --mantine-color-gray-5, or Figma grey/6"
          >
            <ColorChip cssName="--fg-divider" modeAware />
          </GalleryItem>
          <GallerySection id="colors" title="Colors" />
          <Text12Book c="dimmed">
            These are the full 10-shade colors from Mantine. Their numbers don&apos;t exactly match the design system,
            because Mantine only supports 10 shades. Mostly use the shades above instead.
          </Text12Book>
          <GalleryColor
            color="green"
            modeAware
            notes="AKA primary. Can be used in light or dark for emphasis"
            figmaNames={[
              'green/1',
              'green/2',
              'green/3',
              'green/4',
              'green/6',
              'green/7',
              'green/9',
              'green/10',
              'green/11',
              'green/12',
            ]}
          />
          <GalleryColor
            color="gray"
            modeAware
            figmaNames={[
              'gray/1',
              'gray/2',
              'gray/3',
              'gray/4',
              'gray/6',
              'gray/7',
              'gray/9',
              'gray/10',
              'gray/11',
              'gray/12',
            ]}
          />
          <GalleryColor
            color="red"
            modeAware
            figmaNames={['red/1', 'red/2', 'red/3', 'red/4', 'red/6', 'red/7', 'red/9', 'red/10', 'red/11', 'red/12']}
          />
          <GalleryColor color="blue" />
          <GalleryColor color="devTool" notes="Use for anything dev-only." />
          <GallerySection id="title-text" title="Text: title" />
          <TypeGalleryItem label="TextTitle1" figmaName="title/24">
            <TextTitle1>Brown fox is quick</TextTitle1>
          </TypeGalleryItem>
          <TypeGalleryItem label="TextTitle2" figmaName="title/18">
            <TextTitle2>Brown fox is quick</TextTitle2>
          </TypeGalleryItem>
          <TypeGalleryItem label="TextTitle3" figmaName="title/16">
            <TextTitle3>Brown fox is quick</TextTitle3>
          </TypeGalleryItem>
          <TypeGalleryItem label="TextTitle4" figmaName="title/14">
            <TextTitle4>Brown fox is quick</TextTitle4>
          </TypeGalleryItem>
          <GallerySection id="body-text" title="Text: body" />
          <Text12Book c="dimmed">All of these support c=&apos;dimmed&apos;</Text12Book>
          <TypeGalleryItem label="Text16Medium" figmaName="text/16-medium">
            <Text16Medium>Brown fox is quick</Text16Medium>
          </TypeGalleryItem>
          <TypeGalleryItem label="Text16Regular" figmaName="text/16-regular">
            <Text16Regular>Brown fox is quick</Text16Regular>
          </TypeGalleryItem>
          <TypeGalleryItem label="Text16Book" figmaName="text/16-book">
            <Text16Book>Brown fox is quick</Text16Book>
          </TypeGalleryItem>
          <TypeGalleryItem label="Text13Medium" figmaName="text/13-medium">
            <Text13Medium>Brown fox is quick</Text13Medium>
          </TypeGalleryItem>
          <TypeGalleryItem label="Text13Regular" figmaName="text/13-regular">
            <Text13Regular>Brown fox is quick</Text13Regular>
          </TypeGalleryItem>
          <TypeGalleryItem label="Text13Book" figmaName="text/13-book">
            <Text13Book>Brown fox is quick</Text13Book>
          </TypeGalleryItem>
          <TypeGalleryItem label="Text12Medium" figmaName="text/12-medium">
            <Text12Medium>Brown fox is quick</Text12Medium>
          </TypeGalleryItem>
          <TypeGalleryItem label="Text12Regular" figmaName="text/12-regular">
            <Text12Regular>Brown fox is quick</Text12Regular>
          </TypeGalleryItem>
          <TypeGalleryItem label="Text12Book" figmaName="text/12-book">
            <Text12Book>Brown fox is quick</Text12Book>
          </TypeGalleryItem>
          <TypeGalleryItem label="Text12Book c='dimmed'">
            <Text12Book c="dimmed">Brown fox is quick</Text12Book>
          </TypeGalleryItem>
          <TypeGalleryItem label="Text9Regular" notes="Off-spec but for very tiny text needs">
            <Text9Regular c="dimmed">Brown fox is quick</Text9Regular>
          </TypeGalleryItem>
          <GalleryItem label="DotSpacer">
            <Group gap={0}>
              <Text13Regular>Item 1</Text13Regular>
              <DotSpacer />
              <Text13Regular>Item 2</Text13Regular>
            </Group>
          </GalleryItem>
          <GallerySection id="mono-text" title="Text: monospace" />
          <TypeGalleryItem label="TextMono13Regular" figmaName="mono/13-regular">
            <TextMono13Regular>Brown fox is quick</TextMono13Regular>
          </TypeGalleryItem>
          <TypeGalleryItem label="TextMono12Regular" figmaName="mono/12-regular">
            <TextMono12Regular>Brown fox is quick</TextMono12Regular>
          </TypeGalleryItem>
          <TypeGalleryItem label="Code">
            <Code>Brown fox is quick</Code>
          </TypeGalleryItem>
          <GallerySection id="buttons" title="Buttons" />
          <GalleryItem label="ButtonPrimarySolid">
            <ButtonPrimarySolid leftSection={<Plus />}>Click</ButtonPrimarySolid>
          </GalleryItem>
          <GalleryItem label="ButtonPrimaryLight">
            <ButtonPrimaryLight leftSection={<Plus />}>Click</ButtonPrimaryLight>
          </GalleryItem>
          <GalleryItem label="ButtonSecondarySolid">
            <ButtonSecondarySolid leftSection={<Plus />}>Click</ButtonSecondarySolid>
          </GalleryItem>
          <GalleryItem label="ButtonSecondaryOutline">
            <ButtonSecondaryOutline leftSection={<Plus />}>Click</ButtonSecondaryOutline>
          </GalleryItem>
          <GalleryItem label="ButtonSecondaryGhost">
            <ButtonSecondaryGhost leftSection={<Plus />}>Click</ButtonSecondaryGhost>
          </GalleryItem>
          <GalleryItem label="ButtonSecondaryInline">
            <ButtonSecondaryInline leftSection={<Plus />}>Click</ButtonSecondaryInline>
          </GalleryItem>
          <GalleryItem label="ButtonDangerLight">
            <ButtonDangerLight leftSection={<Plus />}>Click</ButtonDangerLight>
          </GalleryItem>
          <GalleryItem
            label="ButtonCompactPrimary"
            notes="Small button for toolbars/sidebars. Use for primary actions like Publish."
          >
            <ButtonCompactPrimary leftSection={<Plus />}>Publish</ButtonCompactPrimary>
          </GalleryItem>
          <GalleryItem
            label="ButtonCompactDanger"
            notes="Small button for toolbars/sidebars. Use for destructive actions like Discard."
          >
            <ButtonCompactDanger leftSection={<Trash2 />}>Discard</ButtonCompactDanger>
          </GalleryItem>
          <GalleryItem
            label="ButtonCompactSecondary"
            notes="Small button for toolbars/sidebars. Use for secondary actions."
          >
            <ButtonCompactSecondary leftSection={<Plus />}>Connect</ButtonCompactSecondary>
          </GalleryItem>
          <GalleryItem label="IconButtonOutline">
            <IconButtonOutline>
              <CircleCheckBigIcon />
            </IconButtonOutline>
          </GalleryItem>
          <GalleryItem label="IconButtonGhost">
            <IconButtonGhost>
              <CircleCheckBigIcon />
            </IconButtonGhost>
          </GalleryItem>
          <GalleryItem label="IconButtonInline">
            <IconButtonInline>
              <CircleCheckBigIcon />
            </IconButtonInline>
          </GalleryItem>
          <GalleryItem label="IconButtonToolbar" notes="Compact 24x24 icon button for toolbars.">
            <IconButtonToolbar>
              <StyledLucideIcon Icon={Settings} size="sm" />
            </IconButtonToolbar>
          </GalleryItem>
          <GalleryItem label="CloseButtonInline">
            <CloseButtonInline />
          </GalleryItem>
          <GalleryItem label="ToolIconButton" notes="ActionIcon Button with tooltip. Use on toolbars and inline rows. ">
            <ToolIconButton icon={Settings} onClick={() => console.debug('clicked')} tooltip="Settings" size="sm" />
          </GalleryItem>
          <GallerySection id="action-icons" title="Action Icons" />
          <GalleryItem label="ActionIconThreeDots">
            <ActionIconThreeDots />
          </GalleryItem>
          <GallerySection id="input-components" title="Input Components" />
          <GalleryItem
            label="Menu"
            notes="Use standard Mantine Menu components. Use data-delete to style a delete item."
          >
            <Menu>
              <Menu.Target>
                <ActionIconThreeDots />
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item leftSection={<AlignEndHorizontal size={16} />}>Item 1</Menu.Item>
                <Menu.Item leftSection={<Bird size={16} />} rightSection={<Kbd>⌘B</Kbd>}>
                  Bird
                </Menu.Item>
                <Menu.Divider />
                <Menu.Item data-delete leftSection={<Trash2 size={16} />}>
                  Delete
                </Menu.Item>
                <Menu.Item data-accept leftSection={<CheckIcon size={16} />}>
                  Accept
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </GalleryItem>{' '}
          <GalleryItem
            label="Always dark menu"
            notes="In the grid we have a dark menu variant. Set data-always-dark on the dropdown"
          >
            <Menu>
              <Menu.Target>
                <ActionIconThreeDots />
              </Menu.Target>
              <Menu.Dropdown data-always-dark>
                <Menu.Item leftSection={<AlignEndHorizontal size={16} />}>Item 1</Menu.Item>
                <Menu.Item leftSection={<Bird size={16} />} rightSection={<Kbd>⌘B</Kbd>}>
                  Bird
                </Menu.Item>
                <Menu.Divider />
                <Menu.Item data-delete leftSection={<Trash2 size={16} />}>
                  Delete
                </Menu.Item>
                <Menu.Item data-accept leftSection={<CheckIcon size={16} />}>
                  Accept
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </GalleryItem>
          <GalleryItem label="Checkbox">
            <Checkbox defaultChecked label="I agree to use these components responsibly" />
          </GalleryItem>
          <GalleryItem label="DebouncedTextArea">
            <DebouncedTextArea
              placeholder="Type something... (debounced)"
              minRows={3}
              onChange={(e) => console.debug('Debounced value:', e.target.value)}
            />
          </GalleryItem>
          <GallerySection id="badges" title="Badges" />
          <GalleryItem
            label="Badge"
            notes="This is a custom badge, not the Mantine Badge component. It fights custom styling really hard, so use this instead."
          >
            <Group gap="xs">
              <Badge color="black">Black badge</Badge>
              <Badge color="gray">Gray badge</Badge>
              <Badge color="green">Green badge</Badge>
              <Badge color="red">Red badge</Badge>
              <Badge color="devTool">Dev Tool badge</Badge>
            </Group>
          </GalleryItem>
          <GalleryItem label="Badge with Icon">
            <Badge color="green" icon={CircleCheckBigIcon}>
              Success
            </Badge>
          </GalleryItem>
          <GalleryItem label="BadgeOK">
            <BadgeOK>Success</BadgeOK>
          </GalleryItem>
          <GalleryItem label="BadgeError">
            <BadgeError>Error</BadgeError>
          </GalleryItem>
          <GalleryItem label="Tooltip">
            <Tooltip label="❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️">
              <Ambulance color="pink" />
            </Tooltip>
          </GalleryItem>
          <GalleryItem label="Popover">
            <Popover>
              <Popover.Target>
                <ButtonSecondaryInline>Popover trigger</ButtonSecondaryInline>
              </Popover.Target>
              <Popover.Dropdown>
                <Text13Regular>❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️</Text13Regular>
              </Popover.Dropdown>
            </Popover>
          </GalleryItem>
          <GallerySection id="loaders" title="Loaders" />
          <GalleryItem label="Loader">
            <Loader size="sm" />
          </GalleryItem>
          <GalleryItem label="LoaderWithMessage">
            <LoaderWithMessage message="Customize me..." />
          </GalleryItem>
          <GallerySection id="icons" title="Icons" />
          <GalleryItem label="StyledLucideIcon" notes="Adds standard mantine styling options to Lucide icons">
            <Group gap="sm">
              <StyledLucideIcon Icon={Home} size="xs" />
              <StyledLucideIcon Icon={Home} size="sm" c="gray" />
              <StyledLucideIcon Icon={Home} size="md" c="green" />
              <StyledLucideIcon Icon={Home} size="lg" c="red" />
              <StyledLucideIcon Icon={Home} size="xl" c="devTool" />
            </Group>
          </GalleryItem>
          <GalleryItem
            label="DecorativeBoxedIcon"
            notes="This isn't a Button, it's just a little box. Sometimes you want your icon in a little box? Decorative icons added to sections to provide delight."
          >
            <DecorativeBoxedIcon Icon={Home} />
          </GalleryItem>
          <GalleryItem
            label="CornerBoxedBadge"
            notes="This is a badge but in a corner box. Supports tooltip too. Similar to DecorativeBoxedIcon. Great for context badges, or onboarding progress."
          >
            <CornerBoxedBadge
              label="Some Badge"
              icon={<StyledLucideIcon Icon={Settings} size="sm" />}
              tooltip={'Hello'}
            />
          </GalleryItem>
          <GalleryItem
            label="CircularProgress"
            notes="A simple circular progress indicator. Mantine's is too complicated."
          >
            <CircularProgress fraction={0.75} />
          </GalleryItem>
          <GalleryItem label="ConnectorIcon (40px, with border)">
            <Group gap="sm">
              {Object.values(Service).map((service) => (
                <ConnectorIcon key={service} connector={service} withBorder color="red" />
              ))}
            </Group>
          </GalleryItem>
          <GalleryItem label="ConnectorIcon (40px, no border)">
            <Group gap="sm">
              {Object.values(Service).map((service) => (
                <ConnectorIcon key={service} connector={service} color="red" />
              ))}
            </Group>
          </GalleryItem>
          <GalleryItem label="ConnectorIcon (20px)">
            <Group gap="sm">
              {Object.values(Service).map((service) => (
                <ConnectorIcon key={service} connector={service} size={24} color="red" />
              ))}
            </Group>
          </GalleryItem>
          <GalleryItem label="ModelProviderIcon (20px)">
            <Group gap="sm">
              {[
                'openai/gpt-4o',
                'google/gemini-2.5-flash',
                'meta/llama-3.1-8b',
                'ai21/j1-mini',
                'aion/j1-mini',
                'anthropic/claude-3-5-sonnet',
                'xai/x-ai',
                'open-router',
                'scratch',
              ].map((model) => (
                <ModelProviderIcon key={model} model={model} size={24} withBorder={true} />
              ))}
            </Group>
          </GalleryItem>
          <GalleryItem label="ModelProviderIcon (20px, no border)">
            <Group gap="sm">
              {[
                'openai/gpt-4o',
                'google/gemini-2.5-flash',
                'meta/llama-3.1-8b',
                'ai21/j1-mini',
                'aion/j1-mini',
                'anthropic/claude-3-5-sonnet',
                'xai/x-ai',
                'open-router',
                'scratch',
              ].map((model) => (
                <ModelProviderIcon key={model} model={model} size={24} />
              ))}
            </Group>
          </GalleryItem>
          <GallerySection id="formatting" title="Formatting" />
          <GalleryItem label="RelativeDate (with tooltip)">
            <Text13Book c="dimmed">
              <RelativeDate date={'2025-10-05T00:25:10.892Z'} />
            </Text13Book>
          </GalleryItem>
          <GallerySection id="info-panels" title="Info & Error Status Panels" />
          <GalleryItem label="EmptyListInfoPanel">
            <EmptyListInfoPanel
              title="No items yet"
              description="Get started by creating your first item"
              actionButton={
                <Info.AddEntityButton label="Create Item" onClick={() => console.debug('Create Item clicked')} />
              }
            />
          </GalleryItem>
          <GalleryItem label="Error Info Panel with retry">
            <ErrorInfo
              title="Failed to upload file"
              description="Unable to upload the scratch file. Please try again."
              error={new Error('A network error occurred while uploading the file.')}
              retry={() => console.debug('Retry clicked')}
            />
          </GalleryItem>
          <GalleryItem label="Customized Info Panel">
            <Info>
              <Info.Icon Icon={MessageSquareIcon} />
              <Info.Title>A custom title</Info.Title>
              <Info.Description>Some information about the situation and notes about what to do next.</Info.Description>
              <Info.Actions>
                <Info.ViewDocsButton link="https://docs.scratch.md/getting-started/quick-start" />
                <Info.AddEntityButton label="Create Item" onClick={() => console.debug('Create Item clicked')} />
                <Info.ReloadPageButton />
              </Info.Actions>
            </Info>
          </GalleryItem>
          <GallerySection id="dev-tool-components" title="Dev Tool Components" />
          <GalleryItem label="DevToolButton">
            <DevToolButton>Click</DevToolButton>
          </GalleryItem>
          <GalleryItem label="DevToolPopover" notes="Hide extra information only in dev">
            <DevToolPopover>
              <Text13Regular>
                Here is some extra information that is only visible in dev, it doesn&apos;t take up space in the layout.
              </Text13Regular>
            </DevToolPopover>
          </GalleryItem>
          <GalleryItem label="LabelValuePair">
            <LabelValuePair label="Name" value="John Doe" canCopy />
          </GalleryItem>
          <GallerySection id="patterns" title="Complete Patterns & Examples" />
          <Text12Book c="dimmed" mb="md">
            These examples show how to properly compose base components for common use cases. Use these as templates
            when building new features.
          </Text12Book>
          <Box ml="md">
            <TextTitle3 mb="md">Table Row Pattern</TextTitle3>
            <Text12Book c="dimmed" mb="sm">
              Example of a table row with proper text hierarchy and actions
            </Text12Book>
            <Box p="md" style={{ border: '0.5px solid var(--mantine-color-gray-3)', borderRadius: '8px' }}>
              <Group justify="space-between" align="center">
                <Stack gap={4}>
                  <Text13Regular>Database Connection</Text13Regular>
                  <Group gap="xs">
                    <TextMono12Regular c="dimmed">conn_abc123</TextMono12Regular>
                    <DotSpacer />
                    <Text12Regular c="var(--fg-muted)">Created 2 days ago</Text12Regular>
                  </Group>
                </Stack>
                <Group gap="xs">
                  <BadgeOK />
                  <IconButtonGhost>
                    <StyledLucideIcon Icon={Settings} size="sm" />
                  </IconButtonGhost>
                  <ActionIconThreeDots />
                </Group>
              </Group>
            </Box>
          </Box>
          <Box ml="md" mt="xl">
            <TextTitle3 mb="md">Empty State Pattern</TextTitle3>
            <Text12Book c="dimmed" mb="sm">
              Centered content with icon, title, description, and action. Use the{' '}
              <code>&gt;EmptyListInfoPanel&lt;</code> component for this.
            </Text12Book>
            <EmptyListInfoPanel
              title="No items yet"
              description="Get started by creating your first item"
              actionButton={
                <Info.AddEntityButton label="Create Item" onClick={() => console.debug('Create Item clicked')} />
              }
            />
          </Box>
          <Box ml="md" mt="xl">
            <TextTitle3 mb="md">Card with Header and Footer</TextTitle3>
            <Text12Book c="dimmed" mb="sm">
              Standard card pattern with title, content, metadata, and actions
            </Text12Book>
            <Box p="md" style={{ border: '1px solid var(--mantine-color-gray-3)', borderRadius: '8px' }}>
              <Stack gap="md">
                <Group justify="space-between" align="flex-start">
                  <TextTitle4>Integration Settings</TextTitle4>
                  <IconButtonGhost>
                    <StyledLucideIcon Icon={Settings} size="sm" />
                  </IconButtonGhost>
                </Group>
                <Text13Regular>Configure how data syncs between your applications and services.</Text13Regular>
                <Group justify="space-between" align="center">
                  <Text12Regular c="var(--fg-muted)">Last updated 5 minutes ago</Text12Regular>
                  <Group gap="xs">
                    <ButtonSecondaryGhost>Cancel</ButtonSecondaryGhost>
                    <ButtonPrimarySolid>Save Changes</ButtonPrimarySolid>
                  </Group>
                </Group>
              </Stack>
            </Box>
          </Box>
          <Box ml="md" mt="xl">
            <TextTitle3 mb="md">Form Field Pattern</TextTitle3>
            <Text12Book c="dimmed" mb="sm">
              Label above input with helper text
            </Text12Book>
            <Box p="md" style={{ border: '1px solid var(--mantine-color-gray-3)', borderRadius: '8px' }} maw={400}>
              <Stack gap="sm">
                <div>
                  <Text12Medium mb={4} c="var(--fg-secondary)">
                    Connection Name
                  </Text12Medium>
                  <Text12Regular c="var(--fg-muted)" mb={8}>
                    A friendly name to identify this connection
                  </Text12Regular>
                  {/* Note: Actual input would go here */}
                  <Box p="sm" style={{ border: '1px solid var(--mantine-color-gray-4)', borderRadius: '4px' }}>
                    <Text13Regular c="var(--fg-muted)">My Database Connection</Text13Regular>
                  </Box>
                </div>
              </Stack>
            </Box>
          </Box>
          <Box ml="md" mt="xl">
            <TextTitle3 mb="md">Status List Item</TextTitle3>
            <Text12Book c="dimmed" mb="sm">
              List item showing status with proper color usage
            </Text12Book>
            <Stack gap="xs">
              <Box p="sm" style={{ border: '1px solid var(--mantine-color-gray-3)', borderRadius: '4px' }}>
                <Group justify="space-between">
                  <Group gap="sm">
                    <StyledLucideIcon Icon={CircleCheckBigIcon} size="sm" c="var(--mantine-color-green-6)" />
                    <Text13Regular>Sync completed successfully</Text13Regular>
                  </Group>
                  <Text12Regular c="dimmed">2 minutes ago</Text12Regular>
                </Group>
              </Box>
              <Box p="sm" style={{ border: '1px solid var(--mantine-color-gray-3)', borderRadius: '4px' }}>
                <Group justify="space-between">
                  <Group gap="sm">
                    <Loader size="sm" />
                    <Text13Regular>Syncing data...</Text13Regular>
                  </Group>
                  <Text12Regular c="dimmed">In progress</Text12Regular>
                </Group>
              </Box>
              <Box p="sm" style={{ border: '1px solid var(--mantine-color-gray-3)', borderRadius: '4px' }}>
                <Group justify="space-between">
                  <Group gap="sm">
                    <StyledLucideIcon Icon={AlertTriangle} size="sm" c="var(--mantine-color-red-6)" />
                    <Text13Regular>Connection failed</Text13Regular>
                  </Group>
                  <Text12Regular c="dimmed">5 minutes ago</Text12Regular>
                </Group>
              </Box>
            </Stack>
          </Box>
          <Box ml="md" mt="xl">
            <TextTitle3 mb="md">Action Group Pattern</TextTitle3>
            <Text12Book c="dimmed" mb="sm">
              Common button groupings for different scenarios
            </Text12Book>
            <Stack gap="md">
              <div>
                <Text12Medium mb="xs">Primary + Secondary Actions</Text12Medium>
                <Group gap="xs">
                  <ButtonPrimarySolid leftSection={<StyledLucideIcon Icon={Plus} size="sm" />}>
                    Create New
                  </ButtonPrimarySolid>
                  <ButtonSecondaryOutline leftSection={<StyledLucideIcon Icon={Settings} size="sm" />}>
                    Settings
                  </ButtonSecondaryOutline>
                </Group>
              </div>
              <div>
                <Text12Medium mb="xs">Confirm/Cancel Dialog Actions</Text12Medium>
                <Group gap="xs" justify="flex-end">
                  <ButtonSecondaryGhost>Cancel</ButtonSecondaryGhost>
                  <ButtonPrimarySolid>Confirm</ButtonPrimarySolid>
                </Group>
              </div>
              <div>
                <Text12Medium mb="xs">Destructive Action</Text12Medium>
                <Group gap="xs" justify="flex-end">
                  <ButtonSecondaryGhost>Cancel</ButtonSecondaryGhost>
                  <ButtonDangerLight leftSection={<StyledLucideIcon Icon={Trash2} size="sm" />}>
                    Delete
                  </ButtonDangerLight>
                </Group>
              </div>
            </Stack>
          </Box>
          <Box ml="md" mt="xl">
            <TextTitle3 mb="md">Config Section </TextTitle3>
            <Text12Book c="dimmed" mb="sm">
              A stacked layout with a title, description and a borderedbox containing children - either some information
              or a form.
            </Text12Book>
            <Stack gap="md">
              <div>
                <ConfigSection
                  title="Default Model"
                  description="Set the default LLM to use in your conversations in new workspaces."
                >
                  <Group justify="space-between">
                    <Group gap="xs" wrap="nowrap">
                      <DecorativeBoxedIcon Icon={BrainIcon} size="sm" />
                      <Text13Regular>openai/chat-gpt-4d</Text13Regular>
                    </Group>
                    <IconButtonGhost size="xs">
                      <StyledLucideIcon Icon={PenLineIcon} size={13} />
                    </IconButtonGhost>
                  </Group>
                </ConfigSection>
              </div>
            </Stack>
          </Box>
          <Box ml="md" mt="xl" mb="xl">
            <TextTitle3 mb="md">&apos;⛔ Anti-Patterns (DON&apos;T DO THIS)&apos;</TextTitle3>
            <Text12Book c="dimmed" mb="sm">
              Common mistakes to avoid when using the UI system
            </Text12Book>
            <Stack gap="md">
              <Box p="md" style={{ border: '2px solid var(--mantine-color-red-4)', borderRadius: '8px' }}>
                <Text12Medium c="var(--mantine-color-red-6)" mb="xs">
                  ❌ DON&apos;T: Use hardcoded colors or hex values
                </Text12Medium>
                <Code block>{`<Text style={{ color: '#666' }}>Gray text</Text>`}</Code>
                <Text12Medium c="var(--mantine-color-green-6)" mt="sm" mb="xs">
                  ✅ DO: Use semantic CSS variables
                </Text12Medium>
                <Code block>{`<Text13Regular c="var(--fg-secondary)">Gray text</Text13Regular>`}</Code>
              </Box>

              <Box p="md" style={{ border: '2px solid var(--mantine-color-red-4)', borderRadius: '8px' }}>
                <Text12Medium c="var(--mantine-color-red-6)" mb="xs">
                  ❌ DON&apos;T: Import raw Mantine Text/Title components
                </Text12Medium>
                <Code block>{`import { Text } from '@mantine/core'
<Text size="sm" fw={500}>Hello</Text>`}</Code>
                <Text12Medium c="var(--mantine-color-green-6)" mt="sm" mb="xs">
                  ✅ DO: Use base text components
                </Text12Medium>
                <Code block>{`import { Text13Medium } from '@/components/base/text'
<Text13Medium>Hello</Text13Medium>`}</Code>
              </Box>

              <Box p="md" style={{ border: '2px solid var(--mantine-color-red-4)', borderRadius: '8px' }}>
                <Text12Medium c="var(--mantine-color-red-6)" mb="xs">
                  ❌ DON&apos;T: Use raw Lucide icons
                </Text12Medium>
                <Code block>{`import { Settings } from 'lucide-react'
<Settings size={16} />`}</Code>
                <Text12Medium c="var(--mantine-color-green-6)" mt="sm" mb="xs">
                  ✅ DO: Use StyledLucideIcon wrapper
                </Text12Medium>
                <Code block>{`import { StyledLucideIcon } from '@/components/Icons/StyledLucideIcon'
import { Settings } from 'lucide-react'
<StyledLucideIcon Icon={Settings} size="sm" />`}</Code>
              </Box>

              <Box p="md" style={{ border: '2px solid var(--mantine-color-red-4)', borderRadius: '8px' }}>
                <Text12Medium c="var(--mantine-color-red-6)" mb="xs">
                  ❌ DON&apos;T: Create custom button variants inline
                </Text12Medium>
                <Code block>{`<Button variant="filled" color="blue" size="sm">Click</Button>`}</Code>
                <Text12Medium c="var(--mantine-color-green-6)" mt="sm" mb="xs">
                  ✅ DO: Use existing button components
                </Text12Medium>
                <Code block>{`<ButtonPrimarySolid>Click</ButtonPrimarySolid>`}</Code>
              </Box>
            </Stack>
          </Box>
          <GallerySection id="dialogs" title="Dialogs" />
          <Text12Book c="dimmed" mb="md">
            Use the ConfirmDialog component for all confirmation dialogs. Never use native confirm() or alert().
          </Text12Book>
          <ConfirmDialogDemo />
        </Stack>
      </MainContent.Body>
    </MainContent>
  );
}

function ConfirmDialogDemo(): ReactNode {
  const { open, dialogProps } = useConfirmDialog();

  const handlePrimaryConfirm = () => {
    open({
      title: 'Publish Changes',
      message: 'Are you sure you want to publish all changes?',
      confirmLabel: 'Publish',
      variant: 'primary',
      onConfirm: async () => {
        // Simulate async action
        await new Promise((resolve) => setTimeout(resolve, 1000));
        console.debug('Published!');
      },
    });
  };

  const handleDangerConfirm = () => {
    open({
      title: 'Delete Item',
      message: 'Are you sure you want to delete this item? This action cannot be undone.',
      confirmLabel: 'Delete',
      variant: 'danger',
      onConfirm: async () => {
        // Simulate async action
        await new Promise((resolve) => setTimeout(resolve, 1000));
        console.debug('Deleted!');
      },
    });
  };

  return (
    <Box ml="md">
      <GalleryItem
        label="ConfirmDialog (primary)"
        notes="Use for non-destructive confirmations like publish, submit, etc."
      >
        <ButtonPrimaryLight onClick={handlePrimaryConfirm}>Show Primary Confirm</ButtonPrimaryLight>
      </GalleryItem>
      <GalleryItem label="ConfirmDialog (danger)" notes="Use for destructive actions like delete, discard, reset, etc.">
        <ButtonDangerLight onClick={handleDangerConfirm}>Show Danger Confirm</ButtonDangerLight>
      </GalleryItem>
      <ConfirmDialog {...dialogProps} />
    </Box>
  );
}

function GallerySection({ id, title }: { id: string; title: string }): ReactNode {
  return (
    <Stack mb={0} mt="xl">
      <TextTitle2 id={id}>{title}</TextTitle2>
      <Divider />
    </Stack>
  );
}

function GalleryItem({
  label,
  notes,
  figmaName,
  children,
  deprecated = false,
}: {
  label: string;
  notes?: string;
  figmaName?: string;
  deprecated?: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    <Group align="center" ml="md">
      <Stack>
        <Text16Medium w={250} style={{ textDecoration: deprecated ? 'line-through' : 'none' }}>
          {label}
        </Text16Medium>
        {notes && (
          <Text13Book c="dimmed" maw={250}>
            {notes}
          </Text13Book>
        )}
        {figmaName && (
          <Text13Book maw={250}>
            <Figma />
            {figmaName}
          </Text13Book>
        )}
      </Stack>

      <Box flex={1} p="md">
        {children}
      </Box>
      {/* TODO: Show both light and dark mode versions of the item. */}
    </Group>
  );
}

function TypeGalleryItem({
  label,
  notes,
  figmaName,
  children,
  deprecated = false,
}: {
  label: string;
  notes?: string;
  figmaName?: string;
  deprecated?: boolean;
  children: ReactNode;
}): ReactNode {
  // Renamed the ref for clarity
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [styles, setStyles] = useState<{ fontSize: string; fontWeight: string; lineHeight: string } | null>(null);

  useEffect(() => {
    // Check if the wrapper exists AND has a first element child
    if (wrapperRef.current && wrapperRef.current.firstElementChild) {
      // Get the style from the *child element* (e.g., TextSmBookDimmed's rendered element)
      const childElement = wrapperRef.current.firstElementChild;
      const computedStyle = window.getComputedStyle(childElement);

      setStyles({
        fontSize: computedStyle.fontSize,
        fontWeight: computedStyle.fontWeight,
        lineHeight: computedStyle.lineHeight,
      });
    }
  }, [children]); // This effect will re-run if the children change

  return (
    <GalleryItem label={label} notes={notes} figmaName={figmaName} deprecated={deprecated}>
      <Group align="baseline">
        {/* Wrap children in a div and attach the ref to it */}
        <div ref={wrapperRef}>{children}</div>

        <Code>{styles ? `fz: ${styles.fontSize} / fw: ${styles.fontWeight} / lh: ${styles.lineHeight}` : '—'}</Code>
      </Group>
    </GalleryItem>
  );
}

function GalleryColor({
  color,
  notes,
  modeAware = false,
  figmaNames,
}: {
  color: string;
  notes?: string;
  modeAware?: boolean;
  figmaNames?: string[];
}): ReactNode {
  return (
    <GalleryItem label={color} notes={notes}>
      <Group gap={0}>
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (
          <ColorChip
            key={i}
            cssName={`--mantine-color-${color}-${i}`}
            modeAware={modeAware}
            figmaName={figmaNames?.[i]}
          />
        ))}
      </Group>
    </GalleryItem>
  );
}

function ColorChip({
  cssName,
  modeAware = false,
  figmaName,
}: {
  cssName: string;
  figmaName?: string;
  modeAware?: boolean;
}): ReactNode {
  const colorValue = useMemo(() => {
    if (typeof document === 'undefined') return '';
    return getComputedStyle(document.documentElement).getPropertyValue(cssName).trim();
  }, [cssName]);

  return (
    <Stack>
      <ColorSwatch color={`var(${cssName})`} radius={0} withShadow={false} w={100} h={200}>
        {modeAware && (
          <Tooltip label="Dark-mode aware">
            <MoonStar size={16} fill="var(--mantine-color-body)" style={{ position: 'absolute', top: 3, right: 3 }} />
          </Tooltip>
        )}
        <Stack align="center" justify="flex-end" p={5}>
          <Code>{colorValue}</Code>
          <Code>{cssName}</Code>
          {figmaName && (
            <Code>
              <Figma />
              {figmaName}
            </Code>
          )}
        </Stack>
      </ColorSwatch>
    </Stack>
  );
}

function Figma() {
  return (
    <Image src="/figma.svg" alt="Figma" width={10} height={15} style={{ marginRight: 6, verticalAlign: 'middle' }} />
  );
}
