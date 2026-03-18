# UI System Guide for AI Agents

> **Purpose**: This document provides explicit guidance for AI agents (like Claude) on how to use the standard UI components in this codebase. Follow these rules strictly to maintain consistency.

> **Visual Reference**: See the component gallery at `/dev/gallery` (http://localhost:3000/dev/gallery) for live examples of all components, complete patterns, and anti-patterns.

## Table of Contents

1. [Core Principles](#core-principles)
2. [Import Paths](#import-paths)
3. [Component Decision Tree](#component-decision-tree)
4. [Typography](#typography)
5. [Buttons](#buttons)
6. [Layout](#layout)
7. [Icons](#icons)
8. [Colors and Theming](#colors-and-theming)
9. [Anti-Patterns](#anti-patterns)
10. [Common Scenarios](#common-scenarios)

---

## Core Principles

### DO:

- ✅ Use base components from `@/components/base/`
- ✅ Use semantic CSS variables for colors (`var(--fg-primary)`, `var(--bg-base)`)
- ✅ Use Mantine spacing tokens (`xs`, `sm`, `md`, `lg`, `xl`)
- ✅ Use `StyledLucideIcon` for all icons
- ✅ Use `MainContent` layout for page structure
- ✅ Reference the gallery at `/dev/gallery` for examples

### DON'T:

- ❌ Import raw Mantine components directly (e.g., `import { Text } from '@mantine/core'`)
- ❌ Use inline styles or sx prop for typography
- ❌ Use hardcoded colors or hex values
- ❌ Create new text/button variants without adding to base components
- ❌ Use raw Lucide icons without StyledLucideIcon wrapper

---

## Import Paths

### Base Components

```typescript
// Typography
import { TextTitle1, TextTitle2, Text16Medium, Text13Regular, TextMono12Regular } from '@/components/base/text';

// Buttons
import { ButtonPrimarySolid, ButtonSecondaryOutline, IconButtonGhost } from '@/components/base/buttons';

// Badges
import { Badge, BadgeOK, BadgeError } from '@/components/base/badge';

// Action Icons
import { ActionIconThreeDots } from '@/components/base/action-icons';
```

### Layout

```typescript
import { MainContent } from '@/components/layouts/MainContent';
```

### Icons

```typescript
import { StyledLucideIcon } from '@/components/Icons/StyledLucideIcon';
import { PlusIcon, ArrowRightIcon, SettingsIcon } from 'lucide-react';
```

### Theme

```typescript
import { customColors } from '@/components/theme/custom-colors';
import cornerBorders from '@/components/theme/custom-borders.module.css';
```

---

## Component Decision Tree

### "I need to display text"

```
├─ Is it a page/section title?
│  ├─ Large title (h1) → TextTitle1
│  ├─ Section heading (h2) → TextTitle2
│  ├─ Subsection (h3) → TextTitle3
│  └─ Small heading (h4) → TextTitle4
│
├─ Is it body text?
│  ├─ Large (16px)
│  │  ├─ Emphasized → Text16Medium
│  │  ├─ Normal → Text16Regular
│  │  └─ Light → Text16Book
│  │
│  ├─ Standard (13px)
│  │  ├─ Emphasized → Text13Medium
│  │  ├─ Normal → Text13Regular
│  │  └─ Light → Text13Book
│  │
│  └─ Small (12px)
│     ├─ Emphasized → Text12Medium
│     ├─ Normal → Text12Regular
│     └─ Light → Text12Book
│
└─ Is it code/monospace?
   ├─ Standard (13px) → TextMono13Regular
   └─ Small (12px) → TextMono12Regular
```

### "I need a button"

```
├─ Primary action on page?
│  ├─ Solid background → ButtonPrimarySolid
│  └─ Light background → ButtonPrimaryLight
│
├─ Secondary action?
│  ├─ Needs strong visual weight → ButtonSecondarySolid
│  ├─ Needs border → ButtonSecondaryOutline
│  ├─ Subtle, no border → ButtonSecondaryGhost
│  └─ Inline with text → ButtonSecondaryInline
│
├─ Destructive action?
│  └─ Light background → ButtonDangerLight
│
└─ Icon only?
   ├─ With border → IconButtonOutline
   ├─ Without border → IconButtonGhost
   └─ Inline → IconButtonInline
```

### "I need a layout"

```
├─ Standard page with header?
│  └─ Use MainContent with BasicHeader
│     <MainContent>
│       <MainContent.BasicHeader />
│       <MainContent.Body />
│       <MainContent.Footer />  {/* optional */}
│     </MainContent>
│
├─ Custom header needed?
│  └─ Use MainContent with children
│     <MainContent>
│       {/* custom header */}
│       <MainContent.Body />
│     </MainContent>
│
└─ Full custom layout?
   └─ Build with flex/grid, but use base components for content
```

---

## Typography

### Available Components

| Component           | Size | Weight | Use Case                 |
| ------------------- | ---- | ------ | ------------------------ |
| `TextTitle1`        | 32px | 700    | Page titles, h1          |
| `TextTitle2`        | 20px | 600    | Section headers, h2      |
| `TextTitle3`        | 16px | 600    | Subsection headers, h3   |
| `TextTitle4`        | 14px | 600    | Small headings, h4       |
| `Text16Medium`      | 16px | 500    | Emphasized body text     |
| `Text16Regular`     | 16px | 400    | Large body text          |
| `Text16Book`        | 16px | 350    | Light large text         |
| `Text13Medium`      | 13px | 500    | Emphasized standard text |
| `Text13Regular`     | 13px | 400    | Standard body text       |
| `Text13Book`        | 13px | 350    | Light standard text      |
| `Text12Medium`      | 12px | 500    | Emphasized small text    |
| `Text12Regular`     | 12px | 400    | Small text, labels       |
| `Text12Book`        | 12px | 350    | Light small text         |
| `TextMono13Regular` | 13px | 400    | Code, technical text     |
| `TextMono12Regular` | 12px | 400    | Small code, IDs          |

### Color Props

Use the `c` prop with semantic variables:

```typescript
// Text emphasis levels
<Text13Regular c="var(--fg-primary)">Primary text (default)</Text13Regular>
<Text13Regular c="var(--fg-secondary)">Secondary text</Text13Regular>
<Text13Regular c="var(--fg-muted)">Muted text</Text13Regular>

// Or use Mantine shorthand
<Text13Regular c="dimmed">Dimmed text</Text13Regular>

// Status colors
<Text13Regular c="var(--mantine-color-green-6)">Success</Text13Regular>
<Text13Regular c="var(--mantine-color-red-6)">Error</Text13Regular>
```

### Example Usage

```typescript
// Page header
<TextTitle2>Data Sources</TextTitle2>

// Body content with hierarchy
<Text16Medium>Main content description</Text16Medium>
<Text13Regular c="dimmed">Supporting details</Text13Regular>

// Table cell
<TextMono12Regular>{item.id}</TextMono12Regular>

// Label
<Text12Medium c="var(--fg-secondary)">Created at</Text12Medium>
```

---

## Buttons

### Primary Buttons

Use for the main action on a page.

```typescript
<ButtonPrimarySolid
  leftSection={<StyledLucideIcon icon={Plus} size="sm" />}
  onClick={handleCreate}
  loading={isLoading}
>
  Create New
</ButtonPrimarySolid>

<ButtonPrimaryLight onClick={handleAction}>
  Secondary Primary Action
</ButtonPrimaryLight>
```

### Secondary Buttons

Use for additional actions.

```typescript
// Solid (strong visual weight)
<ButtonSecondarySolid onClick={handleSave}>Save</ButtonSecondarySolid>

// Outline (needs definition)
<ButtonSecondaryOutline onClick={handleEdit}>Edit</ButtonSecondaryOutline>

// Ghost (subtle)
<ButtonSecondaryGhost onClick={handleCancel}>Cancel</ButtonSecondaryGhost>

// Inline (text-like)
<ButtonSecondaryInline onClick={handleViewMore}>View more</ButtonSecondaryInline>
```

### Danger Buttons

Use for destructive actions.

```typescript
<ButtonDangerLight onClick={handleDelete}>Delete</ButtonDangerLight>
```

### Icon Buttons

Use when only an icon is needed.

```typescript
<IconButtonOutline onClick={handleEdit}>
  <StyledLucideIcon icon={Edit} size="sm" />
</IconButtonOutline>

<IconButtonGhost onClick={handleClose}>
  <StyledLucideIcon icon={X} size="sm" />
</IconButtonGhost>

<IconButtonInline onClick={handleExpand}>
  <StyledLucideIcon icon={ChevronDown} size="sm" />
</IconButtonInline>
```

### Button Props

Common props you can use:

```typescript
interface ButtonProps {
  loading?: boolean; // Shows loading spinner
  disabled?: boolean; // Disables the button
  leftSection?: ReactNode; // Icon/content before text
  rightSection?: ReactNode; // Icon/content after text
  fullWidth?: boolean; // Makes button full width
  onClick?: () => void; // Click handler
}
```

---

## Layout

### MainContent Pattern

The standard page layout uses the `MainContent` compound component:

```typescript
import { MainContent } from '@/components/layouts/MainContent'
import { TextTitle2 } from '@/components/base/text'
import { ButtonPrimarySolid } from '@/components/base/buttons'

export default function MyPage() {
  return (
    <MainContent>
      <MainContent.BasicHeader
        title="Page Title"
        description="Optional description"
        action={
          <ButtonPrimarySolid onClick={handleCreate}>
            Create New
          </ButtonPrimarySolid>
        }
      />
      <MainContent.Body>
        {/* Page content */}
      </MainContent.Body>
      <MainContent.Footer>
        {/* Optional footer */}
      </MainContent.Footer>
    </MainContent>
  )
}
```

### Custom Header

For more control:

```typescript
<MainContent>
  <div className={styles.customHeader}>
    <TextTitle2>Custom Title</TextTitle2>
    {/* custom header content */}
  </div>
  <MainContent.Body>
    {/* content */}
  </MainContent.Body>
</MainContent>
```

---

## Icons

### Always Use StyledLucideIcon

Never import Lucide icons directly. Always wrap them with `StyledLucideIcon`:

```typescript
import { StyledLucideIcon } from '@/components/Icons/StyledLucideIcon'
import { Plus, Settings, ArrowRight } from 'lucide-react'

// Standalone icon
<StyledLucideIcon icon={Settings} size="md" />

// In button
<ButtonPrimarySolid
  leftSection={<StyledLucideIcon icon={Plus} size="sm" />}
>
  Create
</ButtonPrimarySolid>

// With custom color
<StyledLucideIcon
  icon={ArrowRight}
  size="sm"
  c="var(--fg-muted)"
/>
```

### Icon Sizes

| Size | Pixels | Use Case                  |
| ---- | ------ | ------------------------- |
| `xs` | 8px    | Tiny indicators           |
| `sm` | 12px   | Button icons, inline text |
| `md` | 16px   | Standard icons (default)  |
| `lg` | 24px   | Large icons, headers      |
| `xl` | 32px   | Hero icons, empty states  |

---

## Colors and Theming

### Semantic CSS Variables

Always use semantic CSS variables instead of hardcoded colors:

#### Text and Icon Colors

Most text and icons should use these aliases:

```css
var(--fg-primary)     /* Primary text (default) */
var(--fg-secondary)   /* Secondary text */
var(--fg-muted)       /* Muted/disabled text */
```

#### Background Colors

Most page and panel backgrounds should use these aliases:

```css
var(--bg-base)        /* Base background */
var(--bg-panel)       /* Elevated surfaces */
var(--bg-selected)    /* Selected items, or someting to contrast with panel */
```

#### Full 10-shade colors

We have full 10-shade variants of common custom colors, that are also adjusted for light and dark mode:

- green (primary)
- gray
- red
- blue
- devTool (purple)

Mantine uses colors with 10 shades, 0-indexed. Our design system in Figma uses 12-shade colors, 1-indexed. Shade
indexes don't line up with each other. Here's the mapping:

- gray.0 (mantine) === var(--mantine-color-gray-0) === gray/1 (figma)
- gray.1 (mantine) === var(--mantine-color-gray-1) === gray/2 (figma)
- gray.2 (mantine) === var(--mantine-color-gray-2) === gray/3 (figma)
- gray.3 (mantine) === var(--mantine-color-gray-3) === gray/4 (figma)
- Skip gray/5 (figma)
- gray.4 (mantine) === var(--mantine-color-gray-4) === gray/6 (figma)
- gray.5 (mantine) === var(--mantine-color-gray-5) === gray/7 (figma)
- Skip gray/8 (figma)
- gray.6 (mantine) === var(--mantine-color-gray-6) === gray/9 (figma)
- gray.7 (mantine) === var(--mantine-color-gray-7) === gray/10 (figma)
- gray.8 (mantine) === var(--mantine-color-gray-8) === gray/11 (figma)
- gray.9 (mantine) === var(--mantine-color-gray-9) === gray/12 (figma)

#### Status Colors

For status colors, use Mantine's color tokens:

```typescript
// Success
c = 'var(--mantine-color-green-6)';

// Error
c = 'var(--mantine-color-red-6)';

// Warning
c = 'var(--mantine-color-yellow-6)';

// Info
c = 'var(--mantine-color-blue-6)';
```

### Spacing

Use Mantine spacing tokens:

```typescript
// Padding/Margin
p="xs"    // 8px
p="sm"    // 12px
p="md"    // 16px
p="lg"    // 24px
p="xl"    // 32px

// Examples
<Box p="md" mb="lg">Content</Box>
<Stack gap="sm">Items</Stack>
<Group gap="xs">Buttons</Group>
```

---

## Anti-Patterns

### ❌ DON'T: Import raw Mantine components for Text and Button

```typescript
// WRONG
import { Text, Button } from '@mantine/core'

<Text size="sm" fw={500}>Hello</Text>
<Button variant="filled">Click</Button>
```

### ✅ DO: Use Mantine components for everything else, or from base components if they exist

```typescript
// CORRECT
import { Text13Medium } from '@/components/base/text'
import { ButtonPrimarySolid } from '@/components/base/buttons'
import { Menu } from '@mantine/core'

<Text13Medium>Hello</Text13Medium>
<ButtonPrimarySolid>Click</ButtonPrimarySolid>
<Menu> ... standard menu components </Menu>
```

---

### ❌ DON'T: Use inline styles or sx prop for typography

```typescript
// WRONG
<Text size="16px" fw={500} c="#333">Hello</Text>
<div style={{ fontSize: '16px', fontWeight: 500 }}>Hello</div>
```

### ✅ DO: Use the correct text component

```typescript
// CORRECT
<Text16Medium>Hello</Text16Medium>
```

---

### ❌ DON'T: Use hardcoded colors

```typescript
// WRONG
<Text c="#666">Gray text</Text>
<Text c="gray.6">Gray text</Text>
<Box style={{ backgroundColor: '#f0f0f0' }}>Content</Box>
```

### ✅ DO: Use semantic CSS variables

```typescript
// CORRECT
<Text13Regular c="var(--fg-secondary)">Gray text</Text13Regular>
<Box style={{ backgroundColor: 'var(--bg-elevated)' }}>Content</Box>
```

---

### ❌ DON'T: Import Lucide icons directly

```typescript
// WRONG
import { Plus } from 'lucide-react'

<Button leftSection={<Plus size={16} />}>Create</Button>
```

### ✅ DO: Use StyledLucideIcon wrapper

```typescript
// CORRECT
import { StyledLucideIcon } from '@/components/Icons/StyledLucideIcon'
import { Plus } from 'lucide-react'

<ButtonPrimarySolid leftSection={<StyledLucideIcon icon={Plus} size="sm" />}>
  Create
</ButtonPrimarySolid>
```

---

### ❌ DON'T: Create custom button variants inline

```typescript
// WRONG
<Button variant="outline" color="blue" size="sm">
  Custom Button
</Button>
```

### ✅ DO: Use existing button components or add to base

```typescript
// CORRECT - use existing
<ButtonSecondaryOutline>Custom Button</ButtonSecondaryOutline>

// If truly needed, add to base/buttons.tsx first:
export const ButtonCustomVariant = withProps(Button, { variant: 'outline', color: 'blue', size: 'sm' })
```

---

## Dialogs and Modals

### Confirmation Dialogs

**IMPORTANT**: Never use native `confirm()` or `alert()` dialogs. Always use the `ConfirmDialog` component for user confirmations.

```typescript
import { ConfirmDialog, useConfirmDialog } from '@/components/modals/ConfirmDialog';

// In your component
const { open, dialogProps } = useConfirmDialog();

// Primary confirmation (non-destructive action)
const handlePublish = () => {
  open({
    title: 'Publish Changes',
    message: 'Are you sure you want to publish all changes?',
    confirmLabel: 'Publish',
    variant: 'primary',
    onConfirm: async () => {
      await publishChanges();
    },
  });
};

// Danger confirmation (destructive action)
const handleDelete = () => {
  open({
    title: 'Delete Item',
    message: 'Are you sure you want to delete this item? This action cannot be undone.',
    confirmLabel: 'Delete',
    variant: 'danger',
    onConfirm: async () => {
      await deleteItem();
    },
  });
};

return (
  <>
    <Button onClick={handlePublish}>Publish</Button>
    <Button onClick={handleDelete}>Delete</Button>
    <ConfirmDialog {...dialogProps} />
  </>
);
```

### ConfirmDialog Props

| Prop           | Type                      | Default     | Description                                |
| -------------- | ------------------------- | ----------- | ------------------------------------------ |
| `title`        | `string`                  | required    | Dialog title                               |
| `message`      | `ReactNode`               | required    | Dialog body content                        |
| `confirmLabel` | `string`                  | `'Confirm'` | Text for confirm button                    |
| `cancelLabel`  | `string`                  | `'Cancel'`  | Text for cancel button                     |
| `variant`      | `'primary'` \| `'danger'` | `'primary'` | Button style (green primary or red danger) |
| `onConfirm`    | `() => Promise<void>`     | required    | Async action to perform on confirm         |

---

## Common Scenarios

### Scenario 1: Creating a Table Page

```typescript
import { MainContent } from '@/components/layouts/MainContent'
import { TextTitle2, Text13Regular, TextMono12Regular } from '@/components/base/text'
import { ButtonPrimarySolid, IconButtonGhost } from '@/components/base/buttons'
import { StyledLucideIcon } from '@/components/Icons/StyledLucideIcon'
import { Plus, MoreVertical } from 'lucide-react'
import { Table } from '@mantine/core'

export default function DataPage() {
  return (
    <MainContent>
      <MainContent.BasicHeader
        title="Data Items"
        description="Manage your data items"
        action={
          <ButtonPrimarySolid
            leftSection={<StyledLucideIcon icon={Plus} size="sm" />}
            onClick={handleCreate}
          >
            Create Item
          </ButtonPrimarySolid>
        }
      />
      <MainContent.Body>
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Name</Table.Th>
              <Table.Th>ID</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th></Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {items.map((item) => (
              <Table.Tr key={item.id}>
                <Table.Td>
                  <Text13Regular>{item.name}</Text13Regular>
                </Table.Td>
                <Table.Td>
                  <TextMono12Regular c="dimmed">{item.id}</TextMono12Regular>
                </Table.Td>
                <Table.Td>
                  {item.status === 'ok' ? <BadgeOK /> : <BadgeError />}
                </Table.Td>
                <Table.Td>
                  <IconButtonGhost onClick={() => handleMenu(item.id)}>
                    <StyledLucideIcon icon={MoreVertical} size="sm" />
                  </IconButtonGhost>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </MainContent.Body>
    </MainContent>
  )
}
```

### Scenario 2: Creating a Form

```typescript
import { TextTitle3, Text13Regular, Text12Regular } from '@/components/base/text'
import { ButtonPrimarySolid, ButtonSecondaryGhost } from '@/components/base/buttons'
import { TextInput, Textarea, Stack, Group } from '@mantine/core'

export function CreateForm({ onSubmit, onCancel }) {
  return (
    <Stack gap="lg">
      <div>
        <TextTitle3 mb="md">Create New Item</TextTitle3>
        <Text13Regular c="dimmed">Fill in the details below</Text13Regular>
      </div>

      <Stack gap="sm">
        <div>
          <Text12Regular mb={4} c="var(--fg-secondary)">Name</Text12Regular>
          <TextInput placeholder="Enter name" />
        </div>

        <div>
          <Text12Regular mb={4} c="var(--fg-secondary)">Description</Text12Regular>
          <Textarea placeholder="Enter description" rows={4} />
        </div>
      </Stack>

      <Group justify="flex-end" gap="sm">
        <ButtonSecondaryGhost onClick={onCancel}>Cancel</ButtonSecondaryGhost>
        <ButtonPrimarySolid onClick={onSubmit}>Create</ButtonPrimarySolid>
      </Group>
    </Stack>
  )
}
```

### Scenario 3: Empty State

```typescript
import { StyledLucideIcon } from '@/components/Icons/StyledLucideIcon'
import { Text16Medium, Text13Regular } from '@/components/base/text'
import { ButtonPrimarySolid } from '@/components/base/buttons'
import { Database, Plus } from 'lucide-react'
import { Stack } from '@mantine/core'

export function EmptyState() {
  return (
    <Stack align="center" gap="md" py="xl">
      <StyledLucideIcon icon={Database} size="xl" c="var(--fg-muted)" />
      <div style={{ textAlign: 'center' }}>
        <Text16Medium mb="xs">No data yet</Text16Medium>
        <Text13Regular c="dimmed">Get started by creating your first item</Text13Regular>
      </div>
      <ButtonPrimarySolid
        leftSection={<StyledLucideIcon icon={Plus} size="sm" />}
        onClick={handleCreate}
      >
        Create Item
      </ButtonPrimarySolid>
    </Stack>
  )
}
```

### Scenario 4: Card with Actions

```typescript
import { TextTitle4, Text13Regular, Text12Regular } from '@/components/base/text'
import { IconButtonGhost } from '@/components/base/buttons'
import { StyledLucideIcon } from '@/components/Icons/StyledLucideIcon'
import { Edit, Trash } from 'lucide-react'
import { Card, Group, Stack } from '@mantine/core'

export function ItemCard({ item }) {
  return (
    <Card>
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start">
          <TextTitle4>{item.name}</TextTitle4>
          <Group gap="xs">
            <IconButtonGhost onClick={() => handleEdit(item.id)}>
              <StyledLucideIcon icon={Edit} size="sm" />
            </IconButtonGhost>
            <IconButtonGhost onClick={() => handleDelete(item.id)}>
              <StyledLucideIcon icon={Trash} size="sm" c="var(--mantine-color-red-6)" />
            </IconButtonGhost>
          </Group>
        </Group>
        <Text13Regular c="dimmed">{item.description}</Text13Regular>
        <Text12Regular c="var(--fg-muted)">
          Created {new Date(item.createdAt).toLocaleDateString()}
        </Text12Regular>
      </Stack>
    </Card>
  )
}
```

---

## Quick Reference

### When to use each component:

- **Page title** → `TextTitle1` or `TextTitle2`
- **Section header** → `TextTitle3` or `TextTitle4`
- **Body text** → `Text13Regular` or `Text16Regular`
- **Labels** → `Text12Medium` or `Text12Regular`
- **IDs/Code** → `TextMono12Regular` or `TextMono13Regular`
- **Primary action** → `ButtonPrimarySolid`
- **Secondary action** → `ButtonSecondaryOutline` or `ButtonSecondaryGhost`
- **Destructive action** → `ButtonDangerLight`
- **Icon button** → `IconButtonGhost` or `IconButtonOutline`
- **Any icon** → `StyledLucideIcon`
- **Page layout** → `MainContent` with `BasicHeader` and `Body`

### Color hierarchy:

1. `var(--fg-primary)` - Most important text
2. `var(--fg-secondary)` - Secondary information
3. `var(--fg-muted)` or `dimmed` - Least important text

### Spacing:

- `xs` = 8px
- `sm` = 12px
- `md` = 16px
- `lg` = 24px
- `xl` = 32px

---

## Gallery Reference

For visual examples of all components, visit:

- **Development**: http://localhost:3000/dev/gallery
- **File**: `/client/src/app/dev/gallery/page.tsx`

The gallery shows every text variant, button style, icon size, color option, and layout pattern available in the system.

---

## Questions or Issues?

If you encounter a use case not covered here:

1. Check the gallery at `/dev/gallery`
2. Review existing pages (data-sources, snapshots) for patterns
3. Check the base components in `@/components/base/`
4. When in doubt, ask before creating custom styles

The goal is consistency - if everyone uses the same components, the UI stays cohesive and maintainable.
