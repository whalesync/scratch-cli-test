import { cloneDeep } from 'lodash';
import { minifyHtml } from '../../../../../wrappers/html-minify';
import {
  assertUnreachableButStillReturn,
  escapeHtml,
  escapeHtmlAndSpaces,
  isUrlString,
  unescapeMarkdown,
  unescapeSafeSpacesInHtml,
} from './airmark-utils';

type InlineAnnotations = {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  code?: boolean;
  link?: { url: string };
};

/* One or greater. No indentation is a value of 1. An invalid list level (i.e. not a list) is a value of 0. */
type ListLevel = number;

export type LineAnnotations = {
  header?: 1 | 2 | 3 | 4 | 5 | 6;
  checkboxListItem?: { level: ListLevel; checked: boolean };
  unorderedListItem?: { level: ListLevel };
  orderedListItem?: { level: ListLevel };
  blockquoteLine?: boolean;
};

export type SectionAnnotations = {
  codeBlock?: { delimiter: '~' | '`' };
};

export type RichTextInlineTag = {
  type: 'tag';
  annotations: InlineAnnotations;
  children: RichTextInline[];
};
export type RichTextInlineText = {
  type: 'text';
  text: string;
};
export type RichTextInline = RichTextInlineTag | RichTextInlineText;

export type RichTextLine = {
  text: RichTextInline[];
  annotations: LineAnnotations;
};

export type ListItemLine = {
  type: 'listItem';
  /**
   * The type of list this item is in. Note for `unordered_blank`: this type is for when we translate multiple list
   * indents to a tree of sublists, but we don't want all the little bullet points to show up in HTML. The CSS style of
   * the "ul" for this list will be "list-style-type: none;".
   */
  detail:
    | { type: 'ordered' }
    | { type: 'unordered' }
    | { type: 'unordered_blank' }
    | { type: 'checkbox'; checked: boolean };
  level: ListLevel;
  text: RichTextInline[];
};

export type RichTextSection = {
  text: RichTextLine[];
  annotations: SectionAnnotations;
};

function flattenRichTextInlineToRawText(inlineList: RichTextInline[]): string {
  if (inlineList.length === 0) {
    return '';
  }
  return inlineList.map((r) => (r.type === 'tag' ? flattenRichTextInlineToRawText(r.children) : r.text)).join('');
}

/**
 * Convert AirMark rich text into HTML. The goal is to completely support the AirMark spec and what rich text looks like
 * within Airtable.
 *
 * Most lines of text are surrounded by `<p>` tags. Empty lines become `<p>&#8203;</p>` to preserve the extra lines.
 * Blockquotes have `<p>` tags within them for new lines. Code blocks and lists are not given `<p>` tags at all.
 */
export async function airMarkToHtml(richText: string): Promise<string> {
  // Airtable seems to always put a newline at the end of their string when there isn't one in the editor, so take that
  // out.
  const fixedRichText = richText.endsWith('\n') ? richText.slice(0, -1) : richText;

  // If there's really nothing in the text, don't add any HTML.
  if (fixedRichText === '') {
    return '';
  }

  const lines = fixedRichText.split('\n');
  const sections: RichTextSection[] = [{ text: [], annotations: {} }];
  let createNewSectionForNextLine = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (createNewSectionForNextLine) {
      sections.push({ text: [], annotations: {} });
      createNewSectionForNextLine = false;
    }

    const currentSection = sections[sections.length - 1];
    if (currentSection.annotations.codeBlock) {
      const d = currentSection.annotations.codeBlock.delimiter;
      if (line.startsWith(`${d}${d}${d}`)) {
        // We've ended the code block.
        createNewSectionForNextLine = true;
      } else {
        // In a code block, we don't add any annotations to the lines. We still escape HTML. Note how we don't escape
        // Markdown characters because Markdown only escapes HTML characters inside fenced code blocks, not Markdown
        // characters.
        currentSection.text.push({
          text: [{ type: 'text', text: escapeHtml(line) }],
          annotations: {},
        });
      }
      continue;
    }

    if (line.startsWith('```') || line.startsWith('~~~')) {
      // This **might** be the start of a code block. We need to find a line later to find a matching ending code fence
      // to confirm.
      const d = line.startsWith('```') ? '`' : '~';
      let hasClose = false;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].startsWith(`${d}${d}${d}`)) {
          hasClose = true;
          break;
        }
      }

      if (hasClose) {
        // We are in a complete code block!
        sections.push({ text: [], annotations: { codeBlock: { delimiter: d } } });
        continue;
      }
    }

    currentSection.text.push(renderRichTextLine(line));
  }

  // Now that we have all of the sections, we construct the HTML.
  const outputLines: string[] = [];
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    if (section.annotations.codeBlock) {
      const codeBlockText = section.text.map((l) => flattenRichTextInlineToRawText(l.text)).join('\n');
      outputLines.push(`<pre><code>${codeBlockText}</code></pre>`);
    } else {
      // This is a normal section so render the HTML line-by-line.
      let j = 0;
      while (j < section.text.length) {
        const line = section.text[j];
        const prevLine = j > 0 ? section.text[j - 1] : undefined;
        const nextLine = j < section.text.length - 1 ? section.text[j + 1] : undefined;

        if (needToStartBlockquoteTag({ line, prevLine })) {
          outputLines.push('<blockquote>');
        }

        // Lists are complex so we have special handling for them. We shortcut our loop at the end of that special
        // handling.
        if (isListItem(line)) {
          // We're at the start of a list. Find the end of the list lines, convert all of those lines to a list tree,
          // then output the HTML of that tree.
          let k = j;
          let futureLine = section.text[k];
          while (k < section.text.length && isListItem(futureLine)) {
            k++;
            futureLine = section.text[k];
          }
          const listLines = section.text.slice(j, k);
          const listItemLines: ListItemLine[] = [];
          for (const l of listLines) {
            const lil = convertRichTextLineToListItemLine(l);
            if (lil) {
              listItemLines.push(lil);
            }
          }
          const tree = richTextLinesToListTree(listItemLines);
          outputLines.push(...listTreeToHtmlLines(tree));
          j = k;
          continue;
        }

        let outputLine = richTextLineToHtml(line);

        // If the line is totally empty, we still want it to create an empty line.
        if (outputLine === '<p></p>') {
          outputLine = '<p class="whalesync-empty-line">&#8203;</p>';
        }

        // Render the line as HTML.
        outputLines.push(outputLine);

        if (needToEndBlockquoteTag({ line, nextLine })) {
          outputLines.push('</blockquote>');
        }
        j++;
      }
    }
  }

  // Clean up our aggressive &nbsp; substitutions and other substitutions we can undo.
  for (let i = 0; i < outputLines.length; i++) {
    outputLines[i] = unescapeSafeSpacesInHtml(outputLines[i]);
  }

  const html = outputLines.join('\n');
  // We don't do a try/catch here because **we** created this HTML. If it's not good, we want to hard fail.
  return minifyHtml(html);
}

function renderRichTextLine(s: string): RichTextLine {
  const headerMatch = s.match(/^(?<hashes>#{1,6})\s(?<text>.*)$/);
  if (isHeaderMatch(headerMatch) && headerMatch.groups.hashes.length > 0 && headerMatch.groups.hashes.length <= 6) {
    return {
      text: renderRichTextInline(headerMatch.groups.text),
      annotations: { header: headerMatch.groups.hashes.length as 1 | 2 | 3 | 4 | 5 | 6 },
    };
  }

  const listItem = getListItem(s);
  if (listItem) {
    const annotations: LineAnnotations = {};
    if (listItem.type === 'ordered') {
      annotations.orderedListItem = { level: listItem.level };
    } else if (listItem.type === 'unordered') {
      annotations.unorderedListItem = { level: listItem.level };
    } else if (listItem.type === 'checkbox') {
      annotations.checkboxListItem = { level: listItem.level, checked: listItem.checked };
    } else {
      assertUnreachableButStillReturn(listItem, null);
    }

    return { text: renderRichTextInline(listItem.item), annotations };
  }

  if (s.startsWith('> ')) {
    return { text: renderRichTextInline(s.slice(2)), annotations: { blockquoteLine: true } };
  }

  return { text: renderRichTextInline(s), annotations: {} };
}

function renderRichTextInline(s: string | undefined): RichTextInline[] {
  if (s === undefined || s.length === 0) {
    return [];
  }

  // Try to match all of the inline styles. We then check which one matched first. We'll apply that one.
  const matchBold = s.match(
    /^(?<before>([^_]|\\_)*)(?<!\\)_(?<!\\)_(?<styledText>([^_]|\\_)+)(?<!\\)_(?<!\\)_(?<after>.*)$/,
  );
  const matchBoldAlt = s.match(
    /^(?<before>([^*]|\\\*)*)(?<!\\)\*(?<!\\)\*(?<styledText>([^*]|\\\*)+)(?<!\\)\*(?<!\\)\*(?<after>.*)$/,
  );
  const matchItalic = s.match(/^(?<before>([^_]|\\_)*)(?<!\\)_(?<styledText>([^_]|\\_)+)(?<!\\)_(?<after>.*)$/);
  const matchItalicAlt = s.match(/^(?<before>([^*]|\\\*)*)(?<!\\)\*(?<styledText>([^*]|\\\*)+)(?<!\\)\*(?<after>.*)$/);
  const strikethroughMatch = s.match(
    /^(?<before>([^~]|\\~)*)(?<!\\)~(?<!\\)~(?<styledText>([^~]|\\~)+)(?<!\\)~(?<!\\)~(?<after>.*)$/,
  );
  const inlineCodeMatch = s.match(
    /^(?<before>([^`]|\\`)*)(?<!\\)`(?<!\\)`(?<styledText>.+?)(?<!\\)`(?<!\\)`(?<after>.*)$/,
  );
  const inlineCodeMatchAlt = s.match(
    /^(?<before>([^`]|\\`)*)(?<!\\)`(?<styledText>([^`]|\\`|(`[`]+))+)(?<!\\)`(?<after>.*)$/,
  );
  // Hyperlinks are weird. They seem to find the last open bracket, then match that against the last close bracket and
  // open parenthesis it can find. We'll need to test this because I'm not 100% confident this regex works in all cases.
  const hyperlinkMatch = s.match(
    /^(?<before>(((?<=\\)\[)|([^[]))*)(?<!\\)\[(?<styledText>((\](?!\())|[^\]])+)\]\((?<url>[^)]+)\)(?<after>.*)$/,
  );
  const hyperlinkMatchAlt = s.match(/^(?<before>([^<]|\\<)*)(?<!\\)<(?<url>([^>]|\\>)+)(?<!\\)>(?<after>.*)$/);

  let firstMatchIndex: { style: 'none' | 'b' | 'ba' | 'i' | 'ia' | 's' | 'c' | 'ca' | 'h' | 'ha'; index: number } = {
    style: 'none',
    index: Infinity,
  };

  if (isStyledTextMatch(matchBold) && matchBold.groups.before.length < firstMatchIndex.index) {
    firstMatchIndex = { style: 'b', index: matchBold.groups.before.length };
  }
  if (isStyledTextMatch(matchBoldAlt) && matchBoldAlt.groups.before.length < firstMatchIndex.index) {
    firstMatchIndex = { style: 'ba', index: matchBoldAlt.groups.before.length };
  }
  if (isStyledTextMatch(matchItalic) && matchItalic.groups.before.length < firstMatchIndex.index) {
    firstMatchIndex = { style: 'i', index: matchItalic.groups.before.length };
  }
  if (isStyledTextMatch(matchItalicAlt) && matchItalicAlt.groups.before.length < firstMatchIndex.index) {
    firstMatchIndex = { style: 'ia', index: matchItalicAlt.groups.before.length };
  }
  if (isStyledTextMatch(strikethroughMatch) && strikethroughMatch.groups.before.length < firstMatchIndex.index) {
    firstMatchIndex = { style: 's', index: strikethroughMatch.groups.before.length };
  }
  if (isStyledTextMatch(inlineCodeMatch) && inlineCodeMatch.groups.before.length < firstMatchIndex.index) {
    firstMatchIndex = { style: 'c', index: inlineCodeMatch.groups.before.length };
  }
  if (isStyledTextMatch(inlineCodeMatchAlt) && inlineCodeMatchAlt.groups.before.length < firstMatchIndex.index) {
    firstMatchIndex = { style: 'ca', index: inlineCodeMatchAlt.groups.before.length };
  }
  if (isHyperlinkMatch(hyperlinkMatch) && hyperlinkMatch.groups.before.length < firstMatchIndex.index) {
    firstMatchIndex = { style: 'h', index: hyperlinkMatch.groups.before.length };
  }
  if (
    isAngleBracketHyperlinkMatch(hyperlinkMatchAlt) &&
    hyperlinkMatchAlt.groups.before.length < firstMatchIndex.index
  ) {
    firstMatchIndex = { style: 'ha', index: hyperlinkMatchAlt.groups.before.length };
  }

  if (isStyledTextMatch(matchBold) && firstMatchIndex.style === 'b') {
    return addStyleToInlineText(matchBold.groups, { bold: true });
  }
  if (isStyledTextMatch(matchBoldAlt) && firstMatchIndex.style === 'ba') {
    return addStyleToInlineText(matchBoldAlt.groups, { bold: true });
  }
  if (isStyledTextMatch(matchItalic) && firstMatchIndex.style === 'i') {
    return addStyleToInlineText(matchItalic.groups, { italic: true });
  }
  if (isStyledTextMatch(matchItalicAlt) && firstMatchIndex.style === 'ia') {
    return addStyleToInlineText(matchItalicAlt.groups, { italic: true });
  }
  if (isStyledTextMatch(strikethroughMatch) && firstMatchIndex.style === 's') {
    return addStyleToInlineText(strikethroughMatch.groups, { strikethrough: true });
  }
  if (isStyledTextMatch(inlineCodeMatch) && firstMatchIndex.style === 'c') {
    return addStyleToInlineText(inlineCodeMatch.groups, { code: true });
  }
  if (isStyledTextMatch(inlineCodeMatchAlt) && firstMatchIndex.style === 'ca') {
    return addStyleToInlineText(inlineCodeMatchAlt.groups, { code: true });
  }
  if (isHyperlinkMatch(hyperlinkMatch) && firstMatchIndex.style === 'h') {
    return addStyleToInlineText(hyperlinkMatch.groups, { link: { url: hyperlinkMatch.groups.url } });
  }
  if (isAngleBracketHyperlinkMatch(hyperlinkMatchAlt) && firstMatchIndex.style === 'ha') {
    return addStyleToInlineText(
      { styledText: hyperlinkMatchAlt.groups.url, ...hyperlinkMatchAlt.groups },
      { link: { url: hyperlinkMatchAlt.groups.url } },
    );
  }

  // We escape any HTML and convert any whitespace and escaped AirMark characters into the HTML escaped sequence (e.g. a
  // space becomes &nbsp;). This completely preserves whitespace. A million &nbsp; is super messy (and also doesn't
  // allow for word breaks) so we translate those into normal spaces later if only one &nbsp; is surrounded by other
  // words.
  return [{ type: 'text', text: convertAirMarkTextToHtmlText(s) }];
}

function addStyleToInlineText(
  args: { before: string; styledText: string; after: string },
  annotations: InlineAnnotations,
): RichTextInline[] {
  const { before, styledText, after } = args;
  return [
    // Because we process the earliest-matching styles first, we know that any text that came before this style didn't
    // match any style, so it's plain text.
    { type: 'text', text: convertAirMarkTextToHtmlText(before) },
    { type: 'tag', annotations, children: renderRichTextInline(styledText) },
    ...renderRichTextInline(after),
  ];
}

type HeaderMatch = RegExpMatchArray & {
  groups: {
    // The '###' that starts a header (e.g. Header 3).
    hashes: string;
    text: string;
  };
};

function isHeaderMatch(match: unknown): match is HeaderMatch {
  if (match !== undefined && match !== null && typeof match === 'object') {
    const m = match as Record<string, unknown>;
    if (
      Object.prototype.hasOwnProperty.call(m, 'groups') &&
      m.groups !== undefined &&
      m.groups !== null &&
      typeof m.groups === 'object'
    ) {
      const g = m.groups as Record<string, unknown>;
      return typeof g.hashes === 'string' && typeof g.text === 'string';
    }
  }
  return false;
}

type StyledTextMatch = RegExpMatchArray & {
  groups: {
    before: string;
    styledText: string;
    after: string;
  };
};

function isStyledTextMatch(match: unknown): match is StyledTextMatch {
  if (match !== undefined && match !== null && typeof match === 'object') {
    const m = match as Record<string, unknown>;
    if (
      Object.prototype.hasOwnProperty.call(m, 'groups') &&
      m.groups !== undefined &&
      m.groups !== null &&
      typeof m.groups === 'object'
    ) {
      const g = m.groups as Record<string, unknown>;
      return typeof g.before === 'string' && typeof g.styledText === 'string' && typeof g.after === 'string';
    }
  }
  return false;
}

type ListItemMatch = RegExpMatchArray & {
  groups: {
    /**
     * The number of spaces before the list marker, divided by 4. For example, no spaces would be `indent=0`, 4 spaces
     * would be `indent=1`, 8 spaces would be `indent=2`, etc.
     */
    indent: string;
    /** The text within the list item. */
    item: string;
    /**
     * The token that indicated the list item:
     * - Unordered lists, either `-` or `*`
     * - Ordered lists, either `<number>.` or `<number>)`
     * - Checkboxes, either `[ ]` or `[x]`
     */
    marker: string;
  };
};

function isListItemMatch(match: unknown): match is ListItemMatch {
  if (match !== undefined && match !== null && typeof match === 'object') {
    const m = match as Record<string, unknown>;
    if (
      Object.prototype.hasOwnProperty.call(m, 'groups') &&
      m.groups !== undefined &&
      m.groups !== null &&
      typeof m.groups === 'object'
    ) {
      const g = m.groups as Record<string, unknown>;
      return typeof g.indent === 'string' && typeof g.item === 'string' && typeof g.marker === 'string';
    }
  }
  return false;
}

function getListItem(
  line: string,
):
  | { type: 'ordered'; level: number; item: string }
  | { type: 'unordered'; level: number; item: string }
  | { type: 'checkbox'; level: number; item: string; checked: boolean }
  | false {
  const unorderedListMatch = line.match(/^(?<indent>( {4})*)(?<marker>-|\*) (?<item>.*)$/);
  if (isListItemMatch(unorderedListMatch)) {
    return {
      type: 'unordered',
      level: Math.floor(unorderedListMatch.groups.indent.length / 4) + 1,
      item: unorderedListMatch.groups.item,
    };
  }

  const orderedListMatch = line.match(/^(?<indent>( {4})*)(?<marker>[0-9]+(\.|\))) (?<item>.*)$/);
  if (isListItemMatch(orderedListMatch)) {
    return {
      type: 'ordered',
      level: Math.floor(orderedListMatch.groups.indent.length / 4) + 1,
      item: orderedListMatch.groups.item,
    };
  }

  const checkboxListMatch = line.match(/^(?<indent>( {4})*)(?<marker>(\[ \])|(\[x\])) (?<item>.*)$/);
  if (isListItemMatch(checkboxListMatch)) {
    return {
      type: 'checkbox',
      level: Math.floor(checkboxListMatch.groups.indent.length / 4) + 1,
      item: checkboxListMatch.groups.item,
      checked: checkboxListMatch.groups.marker === '[x]',
    };
  }

  return false;
}

type HyperlinkMatch = RegExpMatchArray & {
  groups: {
    before: string;
    styledText: string;
    url: string;
    after: string;
  };
};

type AngleBracketHyperlinkMatch = RegExpMatchArray & {
  groups: {
    before: string;
    url: string;
    after: string;
  };
};

function isHyperlinkMatch(match: unknown): match is HyperlinkMatch {
  if (match !== undefined && match !== null && typeof match === 'object') {
    const m = match as Record<string, unknown>;
    if (
      Object.prototype.hasOwnProperty.call(m, 'groups') &&
      m.groups !== undefined &&
      m.groups !== null &&
      typeof m.groups === 'object'
    ) {
      const g = m.groups as Record<string, unknown>;
      return (
        typeof g.before === 'string' &&
        typeof g.styledText === 'string' &&
        typeof g.url === 'string' &&
        typeof g.after === 'string'
      );
    }
  }
  return false;
}

function isAngleBracketHyperlinkMatch(match: unknown): match is AngleBracketHyperlinkMatch {
  if (match !== undefined && match !== null && typeof match === 'object') {
    const m = match as Record<string, unknown>;
    if (
      Object.prototype.hasOwnProperty.call(m, 'groups') &&
      m.groups !== undefined &&
      m.groups !== null &&
      typeof m.groups === 'object'
    ) {
      const g = m.groups as Record<string, unknown>;
      if (typeof g.before === 'string' && typeof g.url === 'string' && typeof g.after === 'string') {
        return isUrlString(g.url);
      }
    }
  }
  return false;
}

function richTextLineToHtml(line: RichTextLine): string {
  if (line.annotations.header) {
    const headerHtml = line.text.map((i) => richTextInlineToHtml(i)).join('');
    const headerLevel = line.annotations.header;
    return `<h${headerLevel}>${headerHtml}</h${headerLevel}>`;
  }
  if (line.annotations.checkboxListItem) {
    const checked = line.annotations.checkboxListItem.checked;
    return (
      `<input type="checkbox"${checked ? ' checked' : ''}> ` + line.text.map((i) => richTextInlineToHtml(i)).join('')
    );
  }
  return '<p>' + line.text.map((i) => richTextInlineToHtml(i)).join('') + '</p>';
}

function listItemLineOutputToHtml(line: ListItemLineOutput): string {
  if (line.detail.type === 'unordered_blank') {
    return '';
  } else if (line.detail.type === 'checkbox') {
    const checked = line.detail.checked;
    return (
      `<input type="checkbox"${checked ? ' checked' : ''}> ` + line.text.map((i) => richTextInlineToHtml(i)).join('')
    );
  }
  return line.text.map((i) => richTextInlineToHtml(i)).join('');
}

function richTextInlineToHtml(inline: RichTextInline): string {
  if (inline.type === 'text') {
    return inline.text;
  } else {
    let text = inline.children.map((i) => richTextInlineToHtml(i)).join('');
    if (inline.annotations.link) {
      text = `<a href="${inline.annotations.link.url.replaceAll('"', '%22')}">${text}</a>`;
    }
    if (inline.annotations.bold) {
      text = `<strong>${text}</strong>`;
    }
    if (inline.annotations.code) {
      text = `<code>${text}</code>`;
    }
    if (inline.annotations.italic) {
      text = `<em>${text}</em>`;
    }
    if (inline.annotations.strikethrough) {
      text = `<del>${text}</del>`;
    }

    return text;
  }
}

function needToStartBlockquoteTag(args: { line: RichTextLine; prevLine: RichTextLine | undefined }): boolean {
  const { line, prevLine } = args;
  if (line.annotations.blockquoteLine) {
    if (prevLine === undefined || prevLine.annotations.blockquoteLine !== true) {
      return true;
    }
  }
  return false;
}

function needToEndBlockquoteTag(args: { line: RichTextLine; nextLine: RichTextLine | undefined }): boolean {
  const { line, nextLine } = args;
  // If this is a blockquote line and there is no line after it, we need to close the chunk.
  if (line.annotations.blockquoteLine && (nextLine === undefined || nextLine.annotations.blockquoteLine !== true)) {
    return true;
  }
  return false;
}

function isListItem(line: RichTextLine | undefined): boolean {
  if (!line) {
    return false;
  }
  return (
    line.annotations.checkboxListItem !== undefined ||
    line.annotations.unorderedListItem !== undefined ||
    line.annotations.orderedListItem !== undefined
  );
}

export type ListTreeNode = {
  type: 'ordered' | 'unordered' | 'unordered_blank' | 'checkbox';
  linChildren: ListItemNode[];
};

export type ListItemNode = {
  text: ListItemLineOutput;
  ltnChildren: ListTreeNode[];
};

export type ListItemLineOutput = Omit<ListItemLine, 'level'>;

/**
 * Convert a group of lines that are each a list item to an HTML-like tree of list items. List items start off with text
 * and then can contain child trees. It returns an array of list trees. For example, if you have:
 * ```
 * - List Item 1
 * - List Item 2
 *     [ ] Checkbox 1
 * 1. Ordered item 1
 * ```
 *
 * The return value would be (pseudocode):
 * ```
 * [
 *     ListTreeNode{type: 'unordered', linChildren: [
 *         {text: "List Item 1"},
 *         {text: "List Item 2", ltnChildren: [
 *             ListTreeNode{type: 'checkbox', linChildren: [{text: "Checkbox 1"}]}
 *         ]}
 *     ]},
 *     ListTreeNode{type: 'ordered', linChildren: [{text: "Ordered item 1"}]}]
 * ]
 * ```
 * @param lines a contiguous group of list items.
 */
export function richTextLinesToListTree(lines: ListItemLine[]): ListTreeNode[] {
  if (lines.length === 0) {
    return [];
  }
  const linesArray = cloneDeep(lines);

  // If the first line has a list level greater than 1, we need to make some adjustments. We need to insert some empty
  // list lines before the first line. That's because the HTML generated will be equivalent and it makes the logic
  // simpler.
  while (linesArray[0].level > 1) {
    // Even if the more indented item is a checkbox or an ordered list item, for simplicity we consider the blank line
    // to be an unordered list item. It's simpler that way.
    const blankItem: ListItemLine = {
      type: 'listItem',
      detail: { type: 'unordered_blank' },
      text: [],
      level: linesArray[0].level - 1,
    };
    linesArray.unshift(blankItem);
  }

  // Go through the array of lines. If we see lines that are more indented than the first line, those will be sub-lists.
  // If we see a line that is at the same list level as the first line but it's of a different type, we need to cut that
  // into a new array.
  const listTreeNodes: ListTreeNode[] = [];
  const firstLine = linesArray[0];
  const listTreeNode: ListTreeNode = {
    type:
      firstLine.detail.type === 'unordered_blank'
        ? 'unordered_blank'
        : firstLine.detail.type === 'ordered'
          ? 'ordered'
          : firstLine.detail.type === 'checkbox'
            ? 'checkbox'
            : 'unordered',
    linChildren: [],
  };
  listTreeNodes.push(listTreeNode);
  for (let i = 0; i < linesArray.length; ) {
    const line = linesArray[i];
    if (line.level === 1) {
      if (line.detail.type === firstLine.detail.type) {
        // We're processing a list item that is not indented and is of the same type as the previous items in the list.
        const listItemNode: ListItemNode = {
          text: { text: line.text, type: line.type, detail: line.detail },
          ltnChildren: [],
        };
        listTreeNode.linChildren.push(listItemNode);
      } else {
        // We've changed list types, so we need to cut off the current tree node.
        listTreeNodes.push(...richTextLinesToListTree(cloneDeep(linesArray.slice(i))));
        break;
      }
    } else {
      // The current line is indented, so it's the start of one or more sub-lists. We need to fast forward and find the
      // end of the sub-list lines.
      let j = i;
      let futureLine = linesArray[j];
      while (j < linesArray.length && futureLine.level > 1) {
        j++;
        futureLine = linesArray[j];
      }
      // We group all of the lines from i to j into a sub-list group. We reduce the indent because we're going to send
      // this sub-list to `richTextLinesToListTree` recursively.
      const indentedSublists = cloneDeep(linesArray.slice(i, j));
      indentedSublists.forEach((l) => (l.level = l.level - 1));
      listTreeNode.linChildren[listTreeNode.linChildren.length - 1].ltnChildren.push(
        ...richTextLinesToListTree(indentedSublists),
      );
      i = j;
      continue;
    }
    i++;
  }

  return listTreeNodes;
}

function listTreeToHtmlLines(tree: ListTreeNode[]): string[] {
  if (tree.length === 0) {
    return [];
  }
  const outputLines: string[] = [];

  for (const node of tree) {
    if (node.type === 'ordered') {
      outputLines.push('<ol>');
    } else if (node.type === 'unordered') {
      outputLines.push('<ul>');
    } else if (node.type === 'unordered_blank') {
      outputLines.push(
        '<ul style="list-style-type: none; list-style-image: none;" class="whalesync-placeholder-list">',
      );
    } else if (node.type === 'checkbox') {
      outputLines.push('<ul style="list-style-type: none; list-style-image: none;" class="whalesync-checkbox-list">');
    } else {
      assertUnreachableButStillReturn(node.type, undefined);
    }

    for (const li of node.linChildren) {
      outputLines.push('<li>');

      if (li.text.detail.type !== 'unordered_blank') {
        outputLines.push(listItemLineOutputToHtml(li.text));
      }
      outputLines.push(...listTreeToHtmlLines(li.ltnChildren));
      outputLines.push('</li>');
    }

    if (node.type === 'ordered') {
      outputLines.push('</ol>');
    } else if (node.type === 'unordered' || node.type === 'unordered_blank' || node.type === 'checkbox') {
      outputLines.push('</ul>');
    } else {
      assertUnreachableButStillReturn(node.type, undefined);
    }
  }

  return outputLines;
}

function convertRichTextLineToListItemLine(r: RichTextLine): ListItemLine | undefined {
  if (!isListItem(r)) {
    return;
  }

  if (r.annotations.orderedListItem) {
    return { type: 'listItem', detail: { type: 'ordered' }, level: r.annotations.orderedListItem.level, text: r.text };
  }
  if (r.annotations.unorderedListItem) {
    return {
      type: 'listItem',
      detail: { type: 'unordered' },
      level: r.annotations.unorderedListItem.level,
      text: r.text,
    };
  }
  if (r.annotations.checkboxListItem) {
    return {
      type: 'listItem',
      detail: { type: 'checkbox', checked: r.annotations.checkboxListItem.checked },
      level: r.annotations.checkboxListItem.level,
      text: r.text,
    };
  }
}

function convertAirMarkTextToHtmlText(s: string): string {
  return escapeHtmlAndSpaces(unescapeMarkdown(s));
}
