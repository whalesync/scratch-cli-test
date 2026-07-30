// Wix Rich Content Type Definitions

import { JsonSafeValue } from 'src/utils/objects';

export type WixRichContentValue = {
  object: 'VALUE';
  document: WixDocument;
};

export type WixDocument = {
  nodes: WixNode[];
  documentStyle?: WixDocumentStyle;
};

export function isWixDocument(data: JsonSafeValue): data is WixDocument {
  // Pretty weak check.
  return !!data && typeof data === 'object' && 'nodes' in data && Array.isArray(data.nodes);
}

export type WixDocumentStyle = {
  [key: string]: JsonSafeValue;
};

export type WixNode =
  | WixParagraphNode
  | WixHeadingNode
  | WixListNode
  | WixDividerNode
  | WixCodeBlockNode
  | WixListItemNode
  | WixBlockquoteNode
  | WixImageNode;

export type WixBaseNode = {
  id: string;
  type: string;
};

export type WixParagraphNode = WixBaseNode & {
  type: 'PARAGRAPH';
  nodes: WixTextNode[];
  paragraphData?: WixParagraphData;
};

export type WixHeadingNode = WixBaseNode & {
  type: 'HEADING';
  nodes: WixTextNode[];
  headingData: WixHeadingData;
};

export type WixListNode = WixBaseNode & {
  type: 'BULLETED_LIST' | 'ORDERED_LIST';
  nodes: WixListItemNode[];
  listData?: WixListData;
  bulletedListData?: WixBulletedListData;
  numberedListData?: WixNumberedListData;
};

export type WixListItemNode = WixBaseNode & {
  type: 'LIST_ITEM';
  nodes: WixNode[]; // Can contain paragraphs or text nodes
  listItemData?: WixListItemData;
};

export type WixDividerNode = WixBaseNode & {
  type: 'DIVIDER';
  dividerData: WixDividerData;
};

export type WixCodeBlockNode = WixBaseNode & {
  type: 'CODE_BLOCK';
  nodes: WixTextNode[];
  codeBlockData: WixCodeBlockData;
};

export type WixBlockquoteNode = WixBaseNode & {
  type: 'BLOCKQUOTE';
  nodes: WixNode[];
  quoteData: {
    indentation: number;
  };
};

export type WixImageNode = WixBaseNode & {
  type: 'IMAGE';
  nodes?: []; // Always empty for IMAGE nodes
  imageData: WixImageData;
};

export type WixImageContainerData = {
  width?: {
    size?: 'SMALL' | 'ORIGINAL' | 'FULL_WIDTH';
    custom?: string; // Custom width in pixels
  };
  alignment?: 'LEFT' | 'CENTER' | 'RIGHT';
  textWrap?: boolean;
};

export type WixImageSrc = {
  id: string; // Wix media ID (e.g., "9a4116_2161bd3b120046b7bc653b638305c2cc~mv2.jpg")
  url?: string; // Full URL if available
};

export type WixImageData = {
  containerData?: WixImageContainerData;
  image: {
    src: WixImageSrc;
    width?: number; // Original width
    height?: number; // Original height
  };
  altText?: string; // Alt text for accessibility
};

export type WixTextNode = {
  type: 'TEXT';
  id: string;
  nodes?: WixNode[]; // This can be empty in real Wix data
  textData: WixTextData;
};

export type WixTextData = {
  text: string;
  decorations: WixTextDecoration[];
};

export type WixTextDecoration =
  | WixBoldDecoration
  | WixItalicDecoration
  | WixUnderlineDecoration
  | WixColorDecoration
  | WixFontSizeDecoration
  | WixFontFamilyDecoration
  | WixLinkDecoration
  | WixStrikethroughDecoration;

export type WixBoldDecoration = {
  type: 'BOLD';
  fontWeightValue?: number; // Real Wix format uses this
  // The docs say there is a boolean here, but I don't see it, we only set it.
  boldData?: boolean;
};

export type WixItalicDecoration = {
  type: 'ITALIC';
  italicData: boolean;
};

export type WixUnderlineDecoration = {
  type: 'UNDERLINE';
  underlineData: boolean;
};

export type WixStrikethroughDecoration = {
  type: 'STRIKETHROUGH';
  strikethroughData: boolean;
};

export type WixColorDecoration = {
  type: 'COLOR';
  colorData: {
    foreground?: string;
    background?: string;
  };
};

export type WixFontSizeDecoration = {
  type: 'FONT_SIZE';
  fontSizeData: {
    unit: 'PX' | 'EM';
    value: number;
  };
};

export type WixFontFamilyDecoration = {
  type: 'FONT_FAMILY';
  fontFamilyData: {
    family: string;
  };
};

/**
 * Wix validates `target` against a protobuf enum, NOT the HTML attribute values: sending `'_blank'`
 * makes the API reject the whole document with
 * `target enum must be in [SELF(0), BLANK(1), PARENT(2), TOP(3)]` (DEV-11124). Use
 * {@link HTML_TARGET_TO_RICOS_LINK_TARGET} / {@link RICOS_LINK_TARGET_TO_HTML_TARGET} to cross the
 * boundary in either direction.
 */
export type WixLinkTarget = 'SELF' | 'BLANK' | 'PARENT' | 'TOP';

export type WixLinkDecoration = {
  type: 'LINK';
  linkData: {
    link: {
      url: string;
      target?: WixLinkTarget;
    };
  };
};

/** HTML `target` attribute → Wix's Ricos link-target enum. */
export const HTML_TARGET_TO_RICOS_LINK_TARGET: Record<string, WixLinkTarget> = {
  _self: 'SELF',
  _blank: 'BLANK',
  _parent: 'PARENT',
  _top: 'TOP',
};

/** Wix's Ricos link-target enum → HTML `target` attribute. */
export const RICOS_LINK_TARGET_TO_HTML_TARGET: Record<WixLinkTarget, string> = {
  SELF: '_self',
  BLANK: '_blank',
  PARENT: '_parent',
  TOP: '_top',
};

export type WixParagraphData = {
  textStyle?: {
    textAlignment?: 'AUTO' | 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFY';
  };
  indentation?: number;
};

export type WixHeadingData = {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  textStyle?: {
    textAlignment?: 'AUTO' | 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFY';
  };
  indentation?: number;
};

export type WixListData = {
  indentation?: number;
};

export type WixBulletedListData = {
  indentation?: number;
};

export type WixNumberedListData = {
  indentation?: number;
};

export type WixListItemData = {
  indentation?: number;
};

export type WixDividerData = {
  lineStyle?: 'SINGLE' | 'DOUBLE' | 'DASHED' | 'DOTTED';
  width?: 'LARGE' | 'MEDIUM' | 'SMALL';
  alignment?: 'LEFT' | 'CENTER' | 'RIGHT';
};

export type WixCodeBlockData = {
  textStyle?: {
    textAlignment?: 'AUTO' | 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFY';
  };
};

// HTML Parser Configuration (for html-to-ricos.ts)
export type ParseContext = {
  decorations: WixTextDecoration[];
  inList: boolean;
  listType: 'BULLETED_LIST' | 'ORDERED_LIST' | null;
  listIndentation: number; // Track nesting level for lists
};

// HTML Conversion Options (for ricos-to-html.ts)
export type HtmlConversionOptions = {
  prettify?: boolean;
  indentSize?: number;
};
