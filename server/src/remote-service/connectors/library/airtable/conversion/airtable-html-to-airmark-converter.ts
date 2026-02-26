import * as cheerio from 'cheerio';
import { ElementType } from 'domelementtype';
import { ChildNode } from 'domhandler';
import { minifyHtml } from '../../../../../wrappers/html-minify';
import { findTreeIndex, sliceTree } from './airmark-trees';
import {
  assertUnreachableButStillReturn,
  escapeMarkdown,
  isHtmlBlockLevelTag,
  replaceNewlines,
  unescapeHtml,
} from './airmark-utils';

export class AirmarkConversionError extends Error {
  constructor(
    message: string,
    public readonly debugInfo?: unknown,
  ) {
    super(message);
    this.name = 'AirmarkConversionError';
  }
}

function safeStringifyError(error: unknown): string {
  try {
    return JSON.stringify(error, Object.getOwnPropertyNames(error as object));
  } catch {
    return String(error);
  }
}

export async function htmlToAirMark(html: string): Promise<string | AirmarkConversionError> {
  const result1 = await pass1(html);
  if (result1 instanceof AirmarkConversionError) {
    return result1;
  }

  const result2 = pass2(result1);
  const result3 = pass3(result2);
  const result4 = pass4(result3);
  const result5 = pass5(result4);
  const result6 = pass6(result5);
  const result7 = pass7(result6);
  return result7;
}

// We need the following definitions:
// - Visual Element: An HTML node that will render something in the output, not counting its children. Examples: plain
//   text, `<br>` tags, `&nbsp;`, and empty `<li>` tags with no visual element children.
// - Structural Element: An HTML node that will **not** render something in the output on its own. It may contain
//   children that are structural and visual elements. Examples: `<div>`, `<p>`, `<span>`, `<li>` tags that have
//   visual element children.
// - Starts-New-Section Node: A structural or visual element that will render its **contents** on a new line compared to
//   any rendered items that came before this node in a depth-first, left-to-right tree traversal. A starts-new-section
//   node must contain at least one visual element or be a visual element on its own, otherwise it would not render by
//   definition.
// - Continue-Section Node: A structural or visual element that will **not** render its contents on a new line. If it is
//   rendered, its contents will be on the same line as any previously rendered continue-section nodes that came before
//   it, up until the previous starts-new-section node.
// - Block-Level HTML Element: HTML element as defined by
//   https://developer.mozilla.org/en-US/docs/Web/HTML/Block-level_elements.
// - Inline-Level HTML Element: HTML element as defined by
//   https://developer.mozilla.org/en-US/docs/Web/HTML/Inline_elements.
//
// Note that by the above definitions, every HTML node in the tree will either be a visual element or a structural
// element. Also, every HTML node will either be a starts-new-section node or a continue-section node.
//
// We traverse the tree in multiple passes:
// 1. The first pass will assign unique IDs to every node, which we will need later when determining starts-new-section
//    vs. continue-section nodes.
// 2. The second pass will be to categorize the nodes as visual vs. structural elements.
// 3. The third pass will categorize the nodes as starts-new-section vs. continue-section nodes.
// 4. The fourth pass will split the single HTML document tree into separate subtrees, divided along the
//    starts-new-section nodes. Each subtree will get a clone of all of the ancestor nodes for that tree.
// 5. The fifth pass will compile each subtree into an AirMark section, putting line breaks in the same section.
// 6. The sixth pass will break up sections into AirMark line data types.
// 7. The seventh pass will convert the AirMark line data types into the final AirMark string.

export type CommonNodeProps = {
  /** A UUID that is unique to this node in the entire HTML tree. */
  parseId: string;
};

type CommonPass1HtmlTagProps = {
  /** The child nodes of this node. */
  children: Pass1HtmlNode[];
};
export type Pass1HtmlTagNode = CommonNodeProps &
  CommonPass1HtmlTagProps & {
    type: 'tag';
    /** The name of the HTML tag, always lowercase. */
    tagName: string;
    /** Any attributes from the tag, e.g. `href` for links. */
    attributes: Record<string, string>;
  };

export type Pass1HtmlTextNode = CommonNodeProps & {
  type: 'text';
  /** The text in this text node. Note that this string is HTML-escaped. */
  value: string;
};

export type Pass1HtmlOtherNode = CommonNodeProps & {
  type: 'other';
};

/** A node from pass 1 of our compilation strategy. */
export type Pass1HtmlNode = Pass1HtmlTagNode | Pass1HtmlTextNode | Pass1HtmlOtherNode;

type CommonPass2Props = { parent: Pass2HtmlNode | null; index: number };
type CommonPass2HtmlTagProps = { children: Pass2HtmlNode[] };
export type Pass2HtmlTagVisualElementNode = Omit<Pass1HtmlTagNode, keyof CommonPass1HtmlTagProps> &
  CommonPass2Props &
  CommonPass2HtmlTagProps & {
    displayType: 'visual';
  };
export type Pass2HtmlTagStructuralNode = Omit<Pass1HtmlTagNode, keyof CommonPass1HtmlTagProps> &
  CommonPass2Props &
  CommonPass2HtmlTagProps & {
    displayType: 'structural';
  };
export type Pass2HtmlTagNode = Pass2HtmlTagVisualElementNode | Pass2HtmlTagStructuralNode;
export type Pass2HtmlTextStructuralNode = Pass1HtmlTextNode &
  CommonPass2Props & {
    displayType: 'structural';
  };
export type Pass2HtmlTextVisualElementNode = Pass1HtmlTextNode &
  CommonPass2Props & {
    displayType: 'visual';
  };
export type Pass2HtmlTextNode = Pass2HtmlTextStructuralNode | Pass2HtmlTextVisualElementNode;
export type Pass2HtmlOtherNode = Pass1HtmlOtherNode & CommonPass2Props;
export type Pass2HtmlVisualElementNode = Pass2HtmlTextVisualElementNode | Pass2HtmlTagVisualElementNode;

/** A node from pass 2 of our compilation strategy. */
export type Pass2HtmlNode =
  | Pass2HtmlTagVisualElementNode
  | Pass2HtmlTagStructuralNode
  | Pass2HtmlTextNode
  | Pass2HtmlOtherNode;

type CommonPass3Props = { parent: Pass3HtmlNode | null };
type CommonPass3HtmlTagProps = { children: Pass3HtmlNode[] };
export type Pass3HtmlTagVisualElementNode = Omit<
  Omit<Pass2HtmlTagVisualElementNode, keyof CommonPass2HtmlTagProps>,
  keyof CommonPass3Props
> &
  CommonPass3Props &
  CommonPass3HtmlTagProps & {
    renderType: 'starts_new_section' | 'continue_section';
  };
export type Pass3HtmlTagStructuralNode = Omit<
  Omit<Pass2HtmlTagStructuralNode, keyof CommonPass2HtmlTagProps>,
  keyof CommonPass3Props
> &
  CommonPass3Props &
  CommonPass3HtmlTagProps & {
    // A structural node will never start a new section.
    renderType: 'continue_section';
  };
export type Pass3HtmlTagNode = Pass3HtmlTagVisualElementNode | Pass3HtmlTagStructuralNode;
export type Pass3HtmlTextStructuralNode = Pass2HtmlTextStructuralNode &
  CommonPass3Props & {
    // A structural node will never start a new section.
    renderType: 'continue_section';
  };
export type Pass3HtmlTextVisualElementNode = Pass2HtmlTextVisualElementNode &
  CommonPass3Props & {
    renderType: 'starts_new_section' | 'continue_section';
  };
export type Pass3HtmlTextNode = Pass3HtmlTextStructuralNode | Pass3HtmlTextVisualElementNode;
export type Pass3HtmlOtherNode = Pass2HtmlOtherNode & CommonPass3Props;
export type Pass3HtmlVisualElementNode = Pass3HtmlTextVisualElementNode | Pass3HtmlTagVisualElementNode;

/** A node from pass 3 of our compilation strategy. */
export type Pass3HtmlNode = Pass3HtmlTagNode | Pass3HtmlTextNode | Pass3HtmlOtherNode;

// We remove the parent fields so we can easily clone and test the object.
export type CommonPass4Props = {
  /** The index in the full list of nodes of the parent of this node. */
  parentIndex: number | null;
};
export type Pass4HtmlTagNode = Omit<Omit<Pass3HtmlTagNode, 'parent'>, 'children'> & {
  children: Pass4HtmlNode[];
} & CommonPass4Props;
export type Pass4HtmlTextNode = Omit<Pass3HtmlTextNode, 'parent'> & CommonPass4Props;
export type Pass4HtmlOtherNode = Omit<Pass3HtmlOtherNode, 'parent'> & CommonPass4Props;
/** A node from pass 4 of our compilation strategy. */
export type Pass4HtmlNode = Pass4HtmlTagNode | Pass4HtmlTextNode | Pass4HtmlOtherNode;

/** The result of pass 4. */
export type Pass4Subtrees = { subtrees: Pass4HtmlNode[] };

export type Pass5Text = {
  type: 'text';
  value: string;
};

export type Pass5HardBreak = {
  type: 'hard_break';
};

export type Pass5Ignore = {
  type: 'ignore';
};

export type Pass5UnstyledTag = {
  type: 'unstyled_tag';
  children: Pass5Inline[];
};

export type Pass5Bold = {
  type: 'bold';
  children: Pass5Inline[];
};

export type Pass5Italic = {
  type: 'italic';
  children: Pass5Inline[];
};

export type Pass5Strikethrough = {
  type: 'strikethrough';
  children: Pass5Inline[];
};

export type Pass5Code = {
  type: 'code';
  children: Pass5Inline[];
};

export type Pass5Link = {
  type: 'link';
  url: string;
  children: Pass5Inline[];
};

export type Pass5UnstyledInline = Pass5Text | Pass5HardBreak | Pass5Ignore | Pass5UnstyledTag;
export type Pass5Inline = Pass5UnstyledInline | Pass5Bold | Pass5Italic | Pass5Strikethrough | Pass5Code | Pass5Link;

export type Pass5NormalLineType = { type: 'normal_line' };
export type Pass5HeaderType = { type: 'header'; level: number };
export type Pass5CheckboxListItemType = { type: 'cl_item'; level: number; checked: boolean };
export type Pass5OrderedListItemType = { type: 'ol_item'; level: number };
export type Pass5UnorderedListItemType = { type: 'ul_item'; level: number };
export type Pass5BlockquoteType = { type: 'blockquote' };
export type Pass5CodeBlockType = { type: 'code_block' };

export type Pass5SectionType =
  | Pass5NormalLineType
  | Pass5HeaderType
  | Pass5CheckboxListItemType
  | Pass5OrderedListItemType
  | Pass5UnorderedListItemType
  | Pass5BlockquoteType
  | Pass5CodeBlockType;

/** A section from pass 4 of our compilation strategy. */
export type Pass5Section = { type: Pass5SectionType; children: Pass5Inline[] };

export type Pass5Sections = {
  sections: Pass5Section[];
};

export type Pass6Section = { type: Pass5SectionType; children: Exclude<Pass5Inline, Pass5HardBreak>[] };

export type Pass6Text = {
  type: 'text';
  value: string;
};

// NOTE: Only valid in code blocks.
export type Pass6HardBreak = {
  type: 'hard_break';
};

export type Pass6Ignore = {
  type: 'ignore';
};

export type Pass6UnstyledTag = {
  type: 'unstyled_tag';
  children: Pass6Inline[];
};

export type Pass6Bold = {
  type: 'bold';
  children: Pass6Inline[];
};

export type Pass6Italic = {
  type: 'italic';
  children: Pass6Inline[];
};

export type Pass6Strikethrough = {
  type: 'strikethrough';
  children: Pass6Inline[];
};

export type Pass6Code = {
  type: 'code';
  children: Pass6Inline[];
};

export type Pass6Link = {
  type: 'link';
  url: string;
  children: Pass6Inline[];
};

export type Pass6Inline =
  | Pass6Text
  | Pass6HardBreak
  | Pass6Ignore
  | Pass6UnstyledTag
  | Pass6Bold
  | Pass6Italic
  | Pass6Strikethrough
  | Pass6Code
  | Pass6Link;

export type Pass6NormalLine = {
  type: 'normal_line';
  children: Pass6Inline[];
};

export type Pass6Header = {
  type: 'header';
  level: number;
  children: Pass6Inline[];
};

export type Pass6CheckboxListItem = {
  type: 'cl_item';
  level: number;
  checked: boolean;
  children: Pass6Inline[];
};

export type Pass6OrderedListItem = {
  type: 'ol_item';
  level: number;
  children: Pass6Inline[];
};

export type Pass6UnorderedListItem = {
  type: 'ul_item';
  level: number;
  children: Pass6Inline[];
};

export type Pass6Blockquote = {
  type: 'blockquote';
  children: Pass6Inline[];
};

export type Pass6CodeBlock = {
  type: 'code_block';
  children: Pass6Inline[];
};

/** A data structure that represents an AirMark line. */
export type Pass6AirMarkLine =
  | Pass6NormalLine
  | Pass6Header
  | Pass6CheckboxListItem
  | Pass6OrderedListItem
  | Pass6UnorderedListItem
  | Pass6Blockquote
  | Pass6CodeBlock;

export type Pass6AirMarkDocument = {
  children: Pass6AirMarkLine[];
};

export async function pass1(html: string): Promise<Pass1HtmlNode | AirmarkConversionError> {
  let minified: string;
  try {
    minified = await minifyHtml(html);
  } catch (error) {
    return new AirmarkConversionError(
      `There was an error parsing HTML rich text that was about to be sent to an Airtable rich text field.`,
      {
        badHtml: html,
        error: safeStringifyError(error),
      },
    );
  }
  const $ = cheerio.load(minified);
  const rootNode = $('body')[0];
  if (!rootNode) {
    return new AirmarkConversionError(`Could not parse the HTML document`);
  }

  return createPass1HtmlNode(rootNode);
}

export type Pass2Result = { result: Pass2HtmlNode; nodeList: Pass2HtmlNode[] };
export function pass2(pass1Node: Pass1HtmlNode): Pass2Result {
  const nodeList: Pass2HtmlNode[] = [];
  return { result: createPass2HtmlNode(pass1Node, null, nodeList), nodeList };
}

export function pass3(pass2Result: Pass2Result): Pass3HtmlNode {
  return createPass3HtmlNode(pass2Result.result, null, null, pass2Result.nodeList).result;
}

export function pass4(pass3Result: Pass3HtmlNode): Pass4Subtrees {
  const returnResult: Pass4Subtrees = { subtrees: [] };

  // Split up our big HTML tree into cloned subtrees. Each subtree will start at a 'starts_new_section' node and will
  // end at the last 'visual' element before the next 'starts_new_section' node (or the end of the tree).
  let lastStartsNewSectionNode: Pass4HtmlNode | null = null;
  let lastVeSeen: Pass4HtmlNode | null = null;

  const tempResult = convertPass3FormatToPass4Format(pass3Result, []);
  const rootNode = tempResult.result;
  const pass4List = tempResult.fullList;

  for (let i = 0; i < pass4List.length; i++) {
    const node = pass4List[i];

    if (node.type === 'other') {
      // Skip these.
      continue;
    }

    if (node.renderType === 'starts_new_section') {
      if (lastStartsNewSectionNode !== null) {
        // We're at a new 'starts_new_section' node, so we need a subtree with the previous nodes we've seen.
        const subtree = sliceTree(
          rootNode,
          lastStartsNewSectionNode.index,
          lastVeSeen === null ? node.index : lastVeSeen.index + 1,
        );
        if (subtree !== null) {
          returnResult.subtrees.push(subtree);
        }
      }

      // Now that we've (maybe) created a subtree with our old value of `startNode`, we can reset it to be this one.
      lastStartsNewSectionNode = node;
    }

    if (node.displayType === 'visual') {
      lastVeSeen = node;
    }
  }

  if (lastStartsNewSectionNode !== null && lastVeSeen !== null && lastStartsNewSectionNode.index <= lastVeSeen.index) {
    // The above loop misses the last part of the tree, the last 'starts_new_section' node until the end.
    const subtree = sliceTree(rootNode, lastStartsNewSectionNode.index, lastVeSeen.index + 1);
    if (subtree !== null) {
      returnResult.subtrees.push(subtree);
    }
  }

  return returnResult;
}

export function pass5(pass4Node: Pass4Subtrees): Pass5Sections {
  const sections: Pass5Sections = { sections: [] };

  // Take each subtree from pass 4 and determine: (a) the section type, and (b) the section contents. Put that into a
  // section.
  for (const subtree of pass4Node.subtrees) {
    const sectionType = getPass5SectionType({ pass4Subtree: subtree, listType: 'none', listLevel: 0 });
    const sectionContents = getPass5SectionContents({ pass4Subtree: subtree, insideCodeBlock: false });
    const section: Pass5Section = { type: sectionType, children: [sectionContents] };
    sections.sections.push(section);
  }

  return sections;
}

export function pass6(pass5Sections: Pass5Sections): Pass6AirMarkDocument {
  const doc: Pass6AirMarkDocument = { children: [] };

  for (const pass5Section of pass5Sections.sections) {
    if (pass5Section.type.type === 'code_block') {
      // This is the only type of section where we allow 'hard_break's, but they become new lines.
      doc.children.push({
        type: 'code_block',
        children: replaceHardBreaksWithNewLines(removeAllStyling(pass5Section.children)),
      });
    } else {
      const sectionsWithoutHardBreaks: Pass6Section[] = splitPass5SectionByHardBreaks(pass5Section);

      for (const section of sectionsWithoutHardBreaks) {
        // This cast is safe because we already handled code blocks above.
        const sectionType: Exclude<Pass5SectionType, Pass5CodeBlockType> = section.type as Exclude<
          Pass5SectionType,
          Pass5CodeBlockType
        >;
        if (sectionType.type === 'blockquote') {
          doc.children.push({ type: 'blockquote', children: section.children });
        } else if (sectionType.type === 'cl_item') {
          doc.children.push({
            type: 'cl_item',
            level: sectionType.level,
            checked: sectionType.checked,
            children: section.children,
          });
        } else if (sectionType.type === 'header') {
          doc.children.push({ type: 'header', level: sectionType.level, children: section.children });
        } else if (sectionType.type === 'normal_line') {
          doc.children.push({ type: 'normal_line', children: section.children });
        } else if (sectionType.type === 'ol_item') {
          doc.children.push({ type: 'ol_item', level: sectionType.level, children: section.children });
        } else if (sectionType.type === 'ul_item') {
          doc.children.push({ type: 'ul_item', level: sectionType.level, children: section.children });
        } else {
          assertUnreachableButStillReturn(sectionType, undefined);
        }
      }
    }
  }

  return doc;
}

export function pass7(doc: Pass6AirMarkDocument): string {
  const lines: string[] = [];

  for (const airMarkLine of doc.children) {
    lines.push(airMarkLineToStringLine(airMarkLine));
  }

  const linesCombined = lines.join('\n');

  // As the very final step, replace any non-breaking spaces (char code 160) with normal spaces (char code 32).
  return linesCombined.replaceAll(String.fromCharCode(160), String.fromCharCode(32));
}

function createPass1HtmlNode(htmlNode: ChildNode): Pass1HtmlNode {
  if (htmlNode.type === ElementType.Text) {
    return { type: 'text', parseId: crypto.randomUUID(), value: unescapeHtml(htmlNode.nodeValue) };
  } else if (htmlNode.type === ElementType.Tag) {
    const tagNode: Pass1HtmlTagNode = {
      type: 'tag',
      parseId: crypto.randomUUID(),
      tagName: htmlNode.tagName.trim().toLowerCase(),
      children: [],
      attributes: htmlNode.attribs,
    };
    tagNode.children = [];
    for (const n of htmlNode.children) {
      const pass1ChildResult = createPass1HtmlNode(n);
      tagNode.children.push(pass1ChildResult);
    }
    return tagNode;
  } else {
    return { type: 'other', parseId: crypto.randomUUID() };
  }
}

export function createPass2HtmlNode(
  pass1Node: Pass1HtmlNode,
  parent: Pass2HtmlNode | null,
  /**
   * A flat list of all of the nodes in order of depth-first, left-to-right tree traversal. Begins empty and is filled
   * as we visit nodes in the tree.
   */
  listOfVisitedNodes: Pass2HtmlNode[],
): Pass2HtmlNode {
  if (pass1Node.type === 'text') {
    const textNode: Pass2HtmlTextNode = {
      type: 'text',
      parseId: pass1Node.parseId,
      value: pass1Node.value,
      displayType: pass1Node.value.length > 0 ? 'visual' : 'structural',
      parent,
      index: listOfVisitedNodes.length,
    };
    listOfVisitedNodes.push(textNode);
    return textNode;
  } else if (pass1Node.type === 'tag') {
    const maybeFirstVeInTag = findFirstVisualElement(pass1Node);
    const pass2Children: Pass2HtmlNode[] = [];
    const isVisualElement = maybeFirstVeInTag !== null && maybeFirstVeInTag.parseId === pass1Node.parseId;
    const pass2Node: Pass2HtmlNode = {
      type: 'tag',
      parseId: pass1Node.parseId,
      tagName: pass1Node.tagName,
      attributes: pass1Node.attributes,
      displayType: isVisualElement ? 'visual' : 'structural',
      parent,
      index: listOfVisitedNodes.length,
      children: pass2Children,
    };
    listOfVisitedNodes.push(pass2Node);
    for (const child of pass1Node.children) {
      pass2Children.push(createPass2HtmlNode(child, pass2Node, listOfVisitedNodes));
    }
    return pass2Node;
  } else {
    const otherNode: Pass2HtmlOtherNode = {
      type: 'other',
      parseId: pass1Node.parseId,
      parent,
      index: listOfVisitedNodes.length,
    };
    listOfVisitedNodes.push(otherNode);
    return otherNode;
  }
}

type Pass3Return = { result: Pass3HtmlNode; lastSeenVisualElementNode: Pass3HtmlVisualElementNode | null };
export function createPass3HtmlNode(
  node: Pass2HtmlNode,
  parent: Pass3HtmlNode | null,
  lastSeenVisualElementNode: Pass3HtmlVisualElementNode | null,
  nodeList: Pass2HtmlNode[],
): Pass3Return {
  if (node.type === 'other') {
    // We don't know what to do with this kind of node, so just return it.
    return { result: { type: 'other', parseId: node.parseId, parent, index: node.index }, lastSeenVisualElementNode };
  }

  let startsNewSection = false;
  if (node.displayType === 'visual') {
    // Given the flat list of nodes, this element will start a new section if either:
    // 1. the closest block-level ancestor of this node is not the same as the closest block-level ancestor of the
    //    last seen visual element
    // 2. there is a block level element between this node and the last seen visual element in the flat list of nodes.
    const nearestBlockLevelAncestor = getNearestBlockLevelAncestorOrSelf(node);
    const nearestBlockLevelAncestorOfLastVe = getNearestBlockLevelAncestorOrSelf(lastSeenVisualElementNode);

    // In any of the below cases, the closest block-level ancestor of this node is not the same as the closest
    // block-level ancestor of the last seen visual element.
    if (
      nearestBlockLevelAncestor !== null &&
      nearestBlockLevelAncestorOfLastVe !== null &&
      nearestBlockLevelAncestor.parseId !== nearestBlockLevelAncestorOfLastVe.parseId
    ) {
      startsNewSection = true;
    } else if (nearestBlockLevelAncestor === null && nearestBlockLevelAncestorOfLastVe !== null) {
      startsNewSection = true;
    } else if (nearestBlockLevelAncestor !== null && nearestBlockLevelAncestorOfLastVe === null) {
      startsNewSection = true;
    }

    if (
      lastSeenVisualElementNode !== null &&
      isThereABlockLevelElementBetweenTwoItems(nodeList, lastSeenVisualElementNode.index, node.index)
    ) {
      startsNewSection = true;
    }
  }
  if (node.type === 'text') {
    const textNode: Pass3HtmlTextNode =
      node.displayType === 'visual'
        ? {
            type: 'text',
            value: node.value,
            parseId: node.parseId,
            parent,
            index: node.index,
            displayType: 'visual',
            renderType: startsNewSection ? 'starts_new_section' : 'continue_section',
          }
        : {
            type: 'text',
            value: node.value,
            parseId: node.parseId,
            parent,
            index: node.index,
            displayType: 'structural',
            renderType: 'continue_section',
          };
    return {
      result: textNode,
      lastSeenVisualElementNode: textNode.displayType === 'visual' ? textNode : lastSeenVisualElementNode,
    };
  } else {
    const pass3Children: Pass3HtmlNode[] = [];
    const pass3TagNode: Pass3HtmlTagNode =
      node.displayType === 'visual'
        ? {
            type: 'tag',
            parseId: node.parseId,
            tagName: node.tagName,
            attributes: node.attributes,
            parent,
            index: node.index,
            displayType: 'visual',
            renderType: startsNewSection ? 'starts_new_section' : 'continue_section',
            children: pass3Children,
          }
        : {
            type: 'tag',
            parseId: node.parseId,
            tagName: node.tagName,
            attributes: node.attributes,
            parent,
            index: node.index,
            displayType: 'structural',
            renderType: 'continue_section',
            children: pass3Children,
          };
    let lastVe: Pass3HtmlVisualElementNode | null =
      pass3TagNode.displayType === 'visual' ? pass3TagNode : lastSeenVisualElementNode;
    for (const child of node.children) {
      const pass3ChildResult = createPass3HtmlNode(child, pass3TagNode, lastVe, nodeList);
      pass3Children.push(pass3ChildResult.result);
      lastVe = pass3ChildResult.lastSeenVisualElementNode;
    }
    return { result: pass3TagNode, lastSeenVisualElementNode: lastVe };
  }
}

function findFirstSublist(pass1HtmlNode: Pass1HtmlNode): Pass1HtmlNode | null {
  if (pass1HtmlNode.type === 'text' || pass1HtmlNode.type === 'other') {
    return null;
  }

  if (pass1HtmlNode.tagName === 'ul' || pass1HtmlNode.tagName === 'ol') {
    // A list opening element is only going to show up if it has child `<li>` elements.
    for (const child of pass1HtmlNode.children) {
      if (doesContainLi(child)) {
        return pass1HtmlNode;
      }
    }
  }

  for (const child of pass1HtmlNode.children) {
    const firstSublist = findFirstSublist(child);
    if (firstSublist !== null) {
      return firstSublist;
    }
  }

  return null;
}

function doesContainLi(pass1HtmlNode: Pass1HtmlNode): boolean {
  if (pass1HtmlNode.type === 'text' || pass1HtmlNode.type === 'other') {
    return false;
  }
  if (pass1HtmlNode.tagName === 'li') {
    return true;
  }
  for (const child of pass1HtmlNode.children) {
    if (doesContainLi(child)) {
      return true;
    }
  }
  return false;
}

function findFirstVisualElement(pass1Node: Pass1HtmlNode): Pass1HtmlNode | null {
  if (pass1Node.type === 'text') {
    if (pass1Node.value.length > 0) {
      return pass1Node;
    } else {
      return null;
    }
  }

  if (pass1Node.type === 'other') {
    return null;
  }

  if (pass1Node.tagName === 'br') {
    return pass1Node;
  }

  if (pass1Node.tagName === 'li') {
    // Lists are weird. A list item can contain other lists. If the list item contains other lists, whether this
    // `<li>` item is a visual element depends on what its children are. If it contains other visual elements in the
    // tree **before** the beginning of the sublists, then it will render and be a visual element. If it doesn't
    // contain any VEs before its sublists, then it will collapse with its sublists.
    //
    // On the other hand, if this `<li>` does not contain any sublists, then it will be a VE no matter what, even if
    // it's empty.
    const firstSublist = findFirstSublist(pass1Node);
    if (firstSublist === null) {
      // This list contains no sublists, so it's a VE no matter what.
      return pass1Node;
    }

    // This list contains sublists, so simply recurse down and find the first VE.
    let firstVeInListItem: Pass1HtmlNode | null = null;
    for (const childInsideLi of pass1Node.children) {
      const maybeVe = findFirstVisualElement(childInsideLi);
      if (maybeVe !== null) {
        firstVeInListItem = maybeVe;
        break;
      }
    }
    if (firstVeInListItem !== null) {
      // There's a VE inside this `<li>`, so that's the first VE (the `<li>` collapses down).
      return firstVeInListItem;
    }

    // We found no VEs inside this list item (not even inside the sublists, which is strange), so this `<li>` won't
    // collapse down and is therefore a VE.
    return pass1Node;
  }

  for (const child of pass1Node.children) {
    const maybeVe = findFirstVisualElement(child);
    if (maybeVe !== null) {
      return maybeVe;
    }
  }

  return null;
}

/**
 * Get the nearest block-level element (or `<body>` element) in the ancestor chain of `pass2HtmlNode`, including the
 * node itself. If `pass2HtmlNode` is `null` or if there are no block-level elements as ancestors, the result will be
 * `null`.
 */
function getNearestBlockLevelAncestorOrSelf(pass2HtmlNode: Pass2HtmlNode | null): Pass2HtmlNode | null {
  if (pass2HtmlNode === null) {
    return null;
  }
  if (
    pass2HtmlNode.type === 'tag' &&
    (isHtmlBlockLevelTag(pass2HtmlNode.tagName) || pass2HtmlNode.tagName === 'body')
  ) {
    return pass2HtmlNode;
  }
  return getNearestBlockLevelAncestorOrSelf(pass2HtmlNode.parent);
}

/**
 * Returns true if there is a block-level element between the nodes located at `nodeList[start]` and `nodeList[end]`,
 * excluding the start and end nodes.
 */
function isThereABlockLevelElementBetweenTwoItems(nodeList: Pass2HtmlNode[], start: number, end: number): boolean {
  if (start >= end) {
    // The indices are invalid.
    return false;
  }
  start = Math.max(start, 0);
  end = Math.min(end, nodeList.length - 1);

  for (let i = start + 1; i < end; i++) {
    const node = nodeList[i];
    if (node.type === 'tag' && isHtmlBlockLevelTag(node.tagName)) {
      return true;
    }
  }

  return false;
}

export function convertPass3FormatToPass4Format(
  pass3Node: Pass3HtmlNode,
  fullList: Pass4HtmlNode[],
): {
  result: Pass4HtmlNode;
  fullList: Pass4HtmlNode[];
} {
  if (pass3Node.type === 'text') {
    const textNode: Pass4HtmlTextNode = {
      type: 'text',
      parseId: pass3Node.parseId,
      index: pass3Node.index,
      displayType: pass3Node.displayType,
      renderType: pass3Node.renderType,
      value: pass3Node.value,
      parentIndex: pass3Node.parent !== null ? pass3Node.parent.index : null,
    };
    fullList.push(textNode);
    return { result: textNode, fullList };
  } else if (pass3Node.type === 'tag') {
    const pass4Children: Pass4HtmlNode[] = [];
    const tagNode: Pass4HtmlTagNode = {
      type: 'tag',
      parseId: pass3Node.parseId,
      tagName: pass3Node.tagName,
      attributes: pass3Node.attributes,
      index: pass3Node.index,
      displayType: pass3Node.displayType,
      renderType: pass3Node.renderType,
      children: pass4Children,
      parentIndex: pass3Node.parent !== null ? pass3Node.parent.index : null,
    };
    fullList.push(tagNode);
    pass3Node.children.forEach((n) => pass4Children.push(convertPass3FormatToPass4Format(n, fullList).result));
    return { result: tagNode, fullList };
  } else {
    const otherNode: Pass4HtmlOtherNode = {
      type: 'other',
      parseId: pass3Node.parseId,
      index: pass3Node.index,
      parentIndex: pass3Node.parent !== null ? pass3Node.parent.index : null,
    };
    fullList.push(otherNode);
    return { result: otherNode, fullList };
  }
}

/**
 * Look inside the subtree section and find the type of section that pass 5 will be. HTML allows us to embed multiple
 * tags inside each other, like headers, lists, blockquotes, etc., whereas AirMark only allows one of those types on a
 * single line. Because of this we have to choose one to win. Therefore we choose the deepest element, so if we have
 * `<h1><blockquote>Text</blockquote></h1>`, the blockquote will win.
 */
function getPass5SectionType(args: {
  pass4Subtree: Pass4HtmlNode;
  listType: 'ul' | 'ol' | 'none';
  listLevel: number;
}): Pass5SectionType {
  const { pass4Subtree, listType, listLevel } = args;
  if (pass4Subtree.type === 'text' || pass4Subtree.type === 'other') {
    return { type: 'normal_line' };
  }

  // If we're in a list, update those values.
  let newListType = listType;
  let newListLevel = listLevel;
  if (pass4Subtree.tagName === 'ul') {
    newListType = 'ul';
  } else if (pass4Subtree.tagName === 'ol') {
    newListType = 'ol';
  }

  if (pass4Subtree.tagName === 'li') {
    newListLevel++;
  }

  let newSectionType: Pass5SectionType = { type: 'normal_line' };

  // Find the types of the children. If any of them are something other than 'normal_line', that wins.
  const childTypes = pass4Subtree.children.map((n) =>
    getPass5SectionType({ pass4Subtree: n, listType: newListType, listLevel: newListLevel }),
  );
  for (const t of childTypes) {
    if (t.type !== 'normal_line') {
      // Take the first one. There shouldn't be multiple anyway.
      newSectionType = t;
      break;
    }
  }

  if (newSectionType.type === 'normal_line') {
    // None of the children said they had a section line type, so now we look at this tag alone. If it has a special
    // section type, it wins.
    if (
      pass4Subtree.tagName === 'h1' ||
      pass4Subtree.tagName === 'h2' ||
      pass4Subtree.tagName === 'h3' ||
      pass4Subtree.tagName === 'h4' ||
      pass4Subtree.tagName === 'h5' ||
      pass4Subtree.tagName === 'h6'
    ) {
      newSectionType = { type: 'header', level: parseInt(pass4Subtree.tagName.charAt(1), 10) };
    } else if (pass4Subtree.tagName === 'li') {
      // We're in a list. We need to look at the first child node to see if it's a checkbox list or not.
      if (
        listType === 'ul' &&
        pass4Subtree.children.length > 0 &&
        pass4Subtree.children[0].type === 'tag' &&
        pass4Subtree.children[0].tagName === 'input' &&
        pass4Subtree.children[0].attributes['type'] === 'checkbox'
      ) {
        newSectionType = {
          type: 'cl_item',
          level: newListLevel,
          checked: pass4Subtree.children[0].attributes['checked'] !== undefined ? true : false,
        };
      } else if (listType === 'ul') {
        newSectionType = { type: 'ul_item', level: newListLevel };
      } else if (listType === 'ol') {
        newSectionType = { type: 'ol_item', level: newListLevel };
      }
    } else if (pass4Subtree.tagName === 'blockquote') {
      newSectionType = { type: 'blockquote' };
    } else if (pass4Subtree.tagName === 'pre') {
      newSectionType = { type: 'code_block' };
    }
  }

  return newSectionType;
}

function getPass5SectionContents(args: { pass4Subtree: Pass4HtmlNode; insideCodeBlock: boolean }): Pass5Inline {
  const { pass4Subtree, insideCodeBlock } = args;
  // NOTE: If this is called with block-level elements, we'll drop them and only consider the contents.
  if (pass4Subtree.type === 'other') {
    // At this point, drop any 'other's.
    return { type: 'ignore' };
  }

  if (pass4Subtree.type === 'text') {
    if (insideCodeBlock) {
      // New lines are kept inside code blocks, so translate them to hard breaks.
      const strings = pass4Subtree.value.split('\n');
      const unstyled: Pass5UnstyledTag = { type: 'unstyled_tag', children: [] };
      for (let i = 0; i < strings.length; i++) {
        const str = strings[i];
        unstyled.children.push({ type: 'text', value: str });
        if (i < strings.length - 1) {
          // If this is before the last element, add a break.
          unstyled.children.push({ type: 'hard_break' });
        }
      }
      return unstyled;
    }

    return { type: 'text', value: pass4Subtree.value };
  }

  // For tags, we look for styling. We ignore any section-type tags (like `<blockquote>` or list tags) because we handle
  // those in `getPass5SectionType()`.
  if (pass4Subtree.tagName === 'pre') {
    return {
      type: 'unstyled_tag',
      children: pass4Subtree.children.map((n) => getPass5SectionContents({ pass4Subtree: n, insideCodeBlock: true })),
    };
  }
  if (pass4Subtree.tagName === 'strong' || pass4Subtree.tagName === 'b') {
    return {
      type: 'bold',
      children: pass4Subtree.children.map((n) => getPass5SectionContents({ pass4Subtree: n, insideCodeBlock })),
    };
  }
  if (pass4Subtree.tagName === 'em' || pass4Subtree.tagName === 'i') {
    return {
      type: 'italic',
      children: pass4Subtree.children.map((n) => getPass5SectionContents({ pass4Subtree: n, insideCodeBlock })),
    };
  }
  if (pass4Subtree.tagName === 'del' || pass4Subtree.tagName === 's') {
    return {
      type: 'strikethrough',
      children: pass4Subtree.children.map((n) => getPass5SectionContents({ pass4Subtree: n, insideCodeBlock })),
    };
  }
  if (pass4Subtree.tagName === 'code') {
    return {
      type: 'code',
      children: pass4Subtree.children.map((n) => getPass5SectionContents({ pass4Subtree: n, insideCodeBlock })),
    };
  }
  if (pass4Subtree.tagName === 'a') {
    return {
      type: 'link',
      url: pass4Subtree.attributes['href'] ?? '',
      children: pass4Subtree.children.map((n) => getPass5SectionContents({ pass4Subtree: n, insideCodeBlock })),
    };
  }
  if (pass4Subtree.tagName === 'br') {
    return { type: 'hard_break' };
  }

  // All other tags are unknown. Just consider them to be an unstyled tag.
  return {
    type: 'unstyled_tag',
    children: pass4Subtree.children.map((n) => getPass5SectionContents({ pass4Subtree: n, insideCodeBlock })),
  };
}

function splitPass5SectionByHardBreaks(pass5Section: Pass5Section): Pass6Section[] {
  // Split each section at each 'hard_break' so that we have a section before it and a section after it. Continue this
  // until there are no more 'hard_break's.
  const sections: Pass6Section[] = [];
  // const sectionChildren = pass5Section.children;
  let sectionToSlice: Pass5Section | null = pass5Section;
  while (sectionToSlice !== null) {
    // We're cheating here a bit since a section only has inlines as children, but this cast is safe.
    const hardBreakIndex: number = findTreeIndex(
      sectionToSlice,
      (i) => (i as unknown as Pass5Inline).type === 'hard_break',
    );

    if (hardBreakIndex !== -1) {
      // We found a 'hard_break', so split it into two sections.
      const leftSection = sliceTree(sectionToSlice, 0, hardBreakIndex) as Pass6Section | null;
      // leftSection should never be null, but still gotta check for type safety.
      if (leftSection !== null) {
        sections.push(leftSection);
      }
      sectionToSlice = sliceTree(sectionToSlice, hardBreakIndex + 1);
    } else {
      sections.push(sectionToSlice as Pass6Section);
      sectionToSlice = null;
    }
  }
  return sections;
}

function airMarkLineToStringLine(line: Pass6AirMarkLine): string {
  if (line.type === 'code_block') {
    // We've already removed styling and replaced 'hard_break's with new lines.
    return '```\n' + pass6InlinesToAirMarkStringLinePart(line.children, false) + '\n```';
  } else if (line.type === 'blockquote') {
    return '> ' + replaceNewlines(pass6InlinesToAirMarkStringLinePart(line.children, true));
  } else if (line.type === 'header') {
    return '#'.repeat(line.level) + ' ' + replaceNewlines(pass6InlinesToAirMarkStringLinePart(line.children, true));
  } else if (line.type === 'ol_item') {
    return (
      ' '.repeat(4 * (line.level - 1)) +
      '1. ' +
      replaceNewlines(pass6InlinesToAirMarkStringLinePart(line.children, true))
    );
  } else if (line.type === 'ul_item') {
    return (
      ' '.repeat(4 * (line.level - 1)) +
      '- ' +
      replaceNewlines(pass6InlinesToAirMarkStringLinePart(line.children, true))
    );
  } else if (line.type === 'cl_item') {
    // If the line contents starts with a space, we remove it.
    let lineContents = replaceNewlines(pass6InlinesToAirMarkStringLinePart(line.children, true));
    if (lineContents.startsWith(' ')) {
      lineContents = lineContents.slice(1);
    }
    return ' '.repeat(4 * (line.level - 1)) + '[' + (line.checked ? 'x' : ' ') + '] ' + lineContents;
  } else if (line.type === 'normal_line') {
    return replaceNewlines(pass6InlinesToAirMarkStringLinePart(line.children, true));
  } else {
    return assertUnreachableButStillReturn(line, '');
  }
}

function pass6InlinesToAirMarkStringLinePart(inlines: Pass6Inline[], escapeMarkdownChars: boolean): string {
  return inlines.map((i) => pass6InlineToString(i, escapeMarkdownChars)).join('');
}

function pass6InlineToString(inline: Pass6Inline, escapeMarkdownChars: boolean): string {
  if (inline.type === 'text') {
    if (escapeMarkdownChars) {
      return escapeMarkdown(inline.value);
    } else {
      return inline.value;
    }
  } else if (inline.type === 'hard_break' || inline.type === 'ignore') {
    // At this point we should have already replaced all of our hard breaks.
    return '';
  }

  if (inline.type === 'bold') {
    return createStyledElement(inline.children, escapeMarkdownChars, '**', '**');
  } else if (inline.type === 'code') {
    // Code is special because we can't escape Markdown characters inside it. We won't escape anything, but if there is
    // one backtick, we surround it with two.
    const testContents = pass6InlinesToAirMarkStringLinePart(inline.children, false);
    if (testContents.match(/^(?<before>[^`]*)`(?!`)(?<after>.*)$/)) {
      // There is a single backtick inside the code section, so we need to surround it with two backticks.
      return createStyledElement(inline.children, false, '``', '``');
    } else {
      return createStyledElement(inline.children, false, '`', '`');
    }
  } else if (inline.type === 'italic') {
    return createStyledElement(inline.children, escapeMarkdownChars, '_', '_');
  } else if (inline.type === 'link') {
    const linkTitle = createStyledElement(inline.children, escapeMarkdownChars, '[', ']');
    return linkTitle.trim().length > 0 ? `${linkTitle}(${inline.url})` : linkTitle;
  } else if (inline.type === 'strikethrough') {
    return createStyledElement(inline.children, escapeMarkdownChars, '~~', '~~');
  } else if (inline.type === 'unstyled_tag') {
    return pass6InlinesToAirMarkStringLinePart(inline.children, escapeMarkdownChars);
  } else {
    return assertUnreachableButStillReturn(inline, '');
  }
}

function createStyledElement(
  inlines: Pass6Inline[],
  escapeMarkdownChars: boolean,
  leftSurroundWith: '**' | '`' | '``' | '_' | '~~' | '[',
  rightSurroundWith: '**' | '`' | '``' | '_' | '~~' | ']',
): string {
  const contents = pass6InlinesToAirMarkStringLinePart(inlines, escapeMarkdownChars);
  if (contents.trim().length > 0) {
    // Any whitespace at the beginning or end will mess up the string. We'll need to store it, surround the string with
    // the markers, then put it back.
    const leftWhitespaceMatch = contents.match(/^(?<leftWhitespace>[\s]+)(?<body>[^\s].*)$/);
    const rightWhitespaceMatch = contents.match(/^(?<body>.*[^\s])(?<rightWhitespace>[\s]+)$/);
    let leftWhitespace = '';
    if (
      leftWhitespaceMatch &&
      leftWhitespaceMatch.groups &&
      leftWhitespaceMatch.groups['leftWhitespace'] !== undefined
    ) {
      leftWhitespace = leftWhitespaceMatch.groups['leftWhitespace'];
    }

    let rightWhitespace = '';
    if (
      rightWhitespaceMatch &&
      rightWhitespaceMatch.groups &&
      rightWhitespaceMatch.groups['rightWhitespace'] !== undefined
    ) {
      rightWhitespace = rightWhitespaceMatch.groups['rightWhitespace'];
    }
    return leftWhitespace + leftSurroundWith + contents.trim() + rightSurroundWith + rightWhitespace;
  } else {
    return contents;
  }
}

function removeAllStyling(inlines: Pass5Inline[]): Pass6Inline[] {
  const unstyledInlines: Pass6Inline[] = [];
  if (inlines.length === 0) {
    return [];
  }

  for (const inline of inlines) {
    if (
      inline.type === 'bold' ||
      inline.type === 'code' ||
      inline.type === 'italic' ||
      inline.type === 'link' ||
      inline.type === 'strikethrough' ||
      inline.type === 'unstyled_tag'
    ) {
      unstyledInlines.push({ type: 'unstyled_tag', children: removeAllStyling(inline.children) });
    } else if (inline.type === 'hard_break' || inline.type === 'text' || inline.type === 'ignore') {
      unstyledInlines.push(inline);
    } else {
      assertUnreachableButStillReturn(inline, undefined);
    }
  }
  return unstyledInlines;
}

function replaceHardBreaksWithNewLines(inlines: Pass6Inline[]): Pass6Inline[] {
  const noHardBreaks: Pass6Inline[] = [];
  if (inlines.length === 0) {
    return [];
  }

  for (const inline of inlines) {
    if (
      inline.type === 'bold' ||
      inline.type === 'code' ||
      inline.type === 'italic' ||
      inline.type === 'strikethrough' ||
      inline.type === 'unstyled_tag'
    ) {
      noHardBreaks.push({ type: inline.type, children: replaceHardBreaksWithNewLines(inline.children) });
    } else if (inline.type === 'hard_break') {
      noHardBreaks.push({ type: 'text', value: '\n' });
    } else if (inline.type === 'link') {
      noHardBreaks.push({ type: 'link', url: inline.url, children: replaceHardBreaksWithNewLines(inline.children) });
    } else if (inline.type === 'text' || inline.type === 'ignore') {
      noHardBreaks.push(inline);
    } else {
      assertUnreachableButStillReturn(inline, undefined);
    }
  }
  return noHardBreaks;
}
