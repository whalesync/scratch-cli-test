# Notion Markdown Converter - Block Type Support

This document lists all Notion block types and how they're handled by the `NotionMarkdownConverter`.

## ✅ Fully Supported Block Types

These block types convert cleanly to markdown and back:

| Block Type           | Markdown Output            | Notes                                       |
| -------------------- | -------------------------- | ------------------------------------------- |
| `paragraph`          | Plain text                 | With inline formatting (bold, italic, etc.) |
| `heading_1`          | `# Heading`                | H1 heading                                  |
| `heading_2`          | `## Heading`               | H2 heading                                  |
| `heading_3`          | `### Heading`              | H3 heading                                  |
| `bulleted_list_item` | `* Item`                   | Supports nesting                            |
| `numbered_list_item` | `1. Item`                  | Supports nesting                            |
| `to_do`              | `- [ ] Task`               | Checkbox tasks                              |
| `quote`              | `> Quote text`             | Blockquotes                                 |
| `code`               | ` ```language\ncode\n``` ` | Code blocks with syntax highlighting        |
| `divider`            | `---`                      | Horizontal rule                             |
| `table`              | Markdown table             | With headers and data rows                  |
| `image`              | `![alt](url)`              | Images with captions                        |
| `bookmark`           | `[url](url)`               | Link bookmarks                              |

## 🔧 Supported with HTML Fallback

These block types are converted to HTML since markdown doesn't have native equivalents:

| Block Type    | Output                  | Notes                                 |
| ------------- | ----------------------- | ------------------------------------- |
| `callout`     | `<div>` with comment    | Styled div with HTML comment marker   |
| `toggle`      | `<details><summary>`    | HTML details/summary element          |
| `video`       | `<video>` with comment  | HTML video element                    |
| `audio`       | `<audio>` with comment  | HTML audio element                    |
| `embed`       | `<iframe>` with comment | HTML iframe for embeds                |
| `column_list` | Markdown table          | Renders columns as table with comment |
| `column`      | Content only            | Handled by parent `column_list`       |

All HTML blocks are prefixed with `<!-- Notion [block_type] block -->` for tracking.

## ⚠️ Unsupported Block Types (Data Loss)

These block types cannot be represented in markdown and are dropped with warnings:

| Block Type       | Behavior             | Error Message                                                         |
| ---------------- | -------------------- | --------------------------------------------------------------------- |
| `child_page`     | Dropped with warning | `<!-- POTENTIAL DATA LOSS: Notion child page: [title] -->`            |
| Any unknown type | Dropped with warning | `<!-- POTENTIAL DATA LOSS: Unsupported Notion block type: [type] -->` |

## 🎨 Rich Text Formatting Support

All block types that contain rich text support these inline formats:

- **Bold** - `**text**`
- _Italic_ - `*text*`
- ~~Strikethrough~~ - `~~text~~`
- `Code` - `` `text` ``
- <u>Underline</u> - `<u>text</u>` (HTML)
- [Links](url) - `[text](url)`

## 📊 Additional Notion Block Types Not Yet Encountered

According to Notion API documentation, these block types exist but aren't in our test data:

### Layout Blocks

- `synced_block` - Synced content blocks
- `breadcrumb` - Page breadcrumb navigation

### Media Blocks

- `file` - File attachments
- `pdf` - PDF embeds

### Database Blocks

- `child_database` - Inline databases
- `link_to_page` - Links to other pages

### Advanced Blocks

- `equation` - LaTeX equations
- `template` - Template blocks (Notion buttons)
- `table_of_contents` - Auto-generated TOC

**Recommendation:** These will be handled by the `default` case and generate data loss warnings until explicitly supported.

## 🔄 Conversion Behavior

### Notion → Markdown

- All supported blocks convert to clean markdown or semantic HTML
- Unsupported blocks generate `<!-- POTENTIAL DATA LOSS: ... -->` comments
- These comments are extracted and shown to users as errors

### Markdown → Notion

- Uses existing `convertToNotionBlocks()` function
- Handles all standard markdown elements
- Can parse the HTML elements we generate (callouts, toggles, etc.)

## 📝 Notes on Specific Conversions

### Tables (`table` + `table_row`)

- Properly formatted as markdown tables
- Supports column headers
- Escapes pipe characters in cells

### Nested Lists

- Maintains nesting hierarchy
- Indentation preserved

### Columns (`column_list` + `column`)

- Rendered as markdown table
- Each column becomes a table cell
- Line breaks within columns preserved with `<br>` tags

### Code Blocks

- Language specified in fence: ` ```javascript `
- Original language metadata preserved

## 🧪 Test Coverage

**All supported block types are tested!**

### Test Data Files

1. **simple-table** - Table with headers and data rows
2. **additional-block-types** - Toggle, video, audio, link_preview, child_page, to-do items
3. **content-marketing** - Complex article with callouts, images, tables, lists, quotes
4. **product-launch** - Product docs with columns, headings, dividers, embeds
5. **social-strategy** - Strategy doc with callouts, lists, nested content
6. **whale-encyclopedia** - Large document with deeply nested lists

### Test Suite

- **18 test scenarios** covering all block types
- **Round-trip conversion tests** (Notion → MD → Notion)
- **Snapshot regression tests** for all conversions
- **64 total Notion tests passing**

See `notion-markdown-converter.spec.ts` for full test suite.
