import type {
  HtmlConversionOptions,
  WixBlockquoteNode,
  WixCodeBlockNode,
  WixDocument,
  WixHeadingNode,
  WixImageNode,
  WixListItemNode,
  WixListNode,
  WixNode,
  WixParagraphNode,
  WixTextDecoration,
  WixTextNode,
} from './types';
import { RICOS_LINK_TARGET_TO_HTML_TARGET } from './types';

class WixToHtmlConverter {
  private indentLevel = 0;
  private options: Required<HtmlConversionOptions>;

  constructor(options: HtmlConversionOptions = {}) {
    this.options = {
      prettify: options.prettify ?? true,
      indentSize: options.indentSize ?? 2,
    };
  }

  convert(wixDocument: WixDocument): string {
    this.indentLevel = 0;
    const htmlNodes = wixDocument.nodes.map((node) => this.convertNode(node));
    return htmlNodes.join(this.options.prettify ? '\n' : '');
  }

  private convertNode(node: WixNode): string {
    switch (node.type) {
      case 'PARAGRAPH':
        return this.convertParagraph(node);
      case 'HEADING':
        return this.convertHeading(node);
      case 'BULLETED_LIST':
      case 'ORDERED_LIST':
        return this.convertList(node);
      case 'DIVIDER':
        return this.convertDivider();
      case 'CODE_BLOCK':
        return this.convertCodeBlock(node);
      case 'BLOCKQUOTE':
        return this.convertBlockquote(node);
      case 'IMAGE':
        return this.convertImage(node);
      case 'LIST_ITEM':
        // This shouldn't happen at the root level, but handle it gracefully
        return this.convertListItem(node);
      default:
        return '';
    }
  }

  private convertParagraph(node: WixParagraphNode): string {
    // Handle empty paragraphs
    if (!node.nodes || node.nodes.length === 0) {
      return this.formatTag('br', '', true);
    }

    const content = this.convertTextNodes(node.nodes);
    const styles: string[] = [];
    const textStyle = this.buildTextStyle(node.paragraphData?.textStyle);
    if (textStyle) {
      styles.push(textStyle);
    }

    // Apply indentation if present
    const indentation = node.paragraphData?.indentation;
    if (indentation && indentation > 0) {
      styles.push(`margin-left: ${indentation * 20}px`);
    }

    if (!content.trim()) {
      return this.formatTag('br', '', true);
    }

    const attributes = styles.length > 0 ? ` style="${styles.join('; ')}"` : '';
    return this.formatTag('p', content, false, attributes);
  }

  private convertHeading(node: WixHeadingNode): string {
    const content = this.convertTextNodes(node.nodes);
    const styles: string[] = [];
    const textStyle = this.buildTextStyle(node.headingData?.textStyle);
    if (textStyle) {
      styles.push(textStyle);
    }

    // Apply indentation if present
    const indentation = node.headingData?.indentation;
    if (indentation && indentation > 0) {
      styles.push(`margin-left: ${indentation * 20}px`);
    }

    const tagName = `h${node.headingData.level}`;
    const attributes = styles.length > 0 ? ` style="${styles.join('; ')}"` : '';

    return this.formatTag(tagName, content, false, attributes);
  }

  private convertList(node: WixListNode): string {
    const tagName = node.type === 'BULLETED_LIST' ? 'ul' : 'ol';

    this.indentLevel++;
    const listItems = node.nodes.map((item) => this.convertListItem(item));
    const content = this.options.prettify ? '\n' + listItems.join('\n') + '\n' + this.getIndent() : listItems.join('');
    this.indentLevel--;

    // Apply indentation if present
    const listData = node.bulletedListData || node.numberedListData;
    const indentation = listData?.indentation;
    let attributes = '';
    if (indentation && indentation > 0) {
      attributes = ` style="margin-left: ${indentation * 20}px"`;
    }

    return this.formatTag(tagName, content, false, attributes);
  }

  private convertListItem(node: WixListItemNode): string {
    // Handle list items that contain paragraph nodes (real Wix format)
    if (node.nodes && node.nodes.length > 0) {
      const content = node.nodes
        .map((childNode) => {
          if (childNode.type === 'PARAGRAPH') {
            // For paragraphs in list items, just return the text content without <p> tags
            return this.convertTextNodes(childNode.nodes);
          }
          return this.convertNode(childNode);
        })
        .filter((content) => content.trim() !== '')
        .join(' ');

      return this.formatTag('li', content);
    }

    return this.formatTag('li', '');
  }

  private convertDivider(): string {
    return this.formatTag('hr', '', true);
  }

  private convertCodeBlock(node: WixCodeBlockNode): string {
    // For code blocks, escape HTML so code is displayed literally
    const content = node.nodes.map((textNode) => this.escapeHtml(textNode.textData?.text || '')).join('');
    const style = this.buildTextStyle(node.codeBlockData?.textStyle);
    const attributes = style ? ` style="${style}"` : '';

    return this.formatTag('pre', content, false, attributes);
  }

  private convertBlockquote(node: WixBlockquoteNode): string {
    this.indentLevel++;
    const childNodes = node.nodes.map((childNode) => this.convertNode(childNode));
    const content = this.options.prettify
      ? '\n' + childNodes.join('\n') + '\n' + this.getIndent()
      : childNodes.join('');
    this.indentLevel--;

    return this.formatTag('blockquote', content);
  }

  private convertImage(node: WixImageNode): string {
    const { imageData } = node;
    const attributes: string[] = [];

    // Build the image URL from Wix media ID
    // If a full URL is provided, use it; otherwise construct from ID
    const imageUrl = imageData.image.src.url || `wix:image://v1/${imageData.image.src.id}`;
    attributes.push(`src="${this.escapeAttribute(imageUrl)}"`);

    // Add alt text only if available (to match Wix format exactly)
    if (imageData.altText) {
      attributes.push(`alt="${this.escapeAttribute(imageData.altText)}"`);
    }

    // Add width and height if available
    if (imageData.image.width) {
      attributes.push(`width="${imageData.image.width}"`);
    }
    if (imageData.image.height) {
      attributes.push(`height="${imageData.image.height}"`);
    }

    // Store Wix-specific data in data attributes for round-trip conversion
    if (imageData.containerData) {
      attributes.push(`data-wix-container="${this.escapeAttribute(JSON.stringify(imageData.containerData))}"`);
    }

    const indent = this.options.prettify ? this.getIndent() : '';
    return `${indent}<img ${attributes.join(' ')}>`;
  }

  private convertTextNodes(textNodes: WixTextNode[]): string {
    return textNodes.map((textNode) => this.convertTextNode(textNode)).join('');
  }

  private convertTextNode(textNode: WixTextNode): string {
    // Handle missing textData
    if (!textNode.textData) {
      return '';
    }

    let content = this.escapeHtml(textNode.textData.text);

    // Convert newline characters to <br> tags for line breaks within paragraphs
    content = content.replace(/\n/g, '<br>');

    // Apply decorations in the order they appear (first decoration becomes innermost)
    const decorations = textNode.textData.decorations;

    for (const decoration of decorations) {
      content = this.applyDecoration(content, decoration);
    }

    return content;
  }

  private applyDecoration(content: string, decoration: WixTextDecoration): string {
    switch (decoration.type) {
      case 'BOLD': {
        // Handle both formats: fontWeightValue and boldData
        const isBold = decoration.fontWeightValue === 700 || decoration.boldData === true;
        return isBold ? `<strong>${content}</strong>` : content;
      }

      case 'ITALIC':
        return `<em>${content}</em>`;

      case 'UNDERLINE':
        return `<u>${content}</u>`;

      case 'STRIKETHROUGH':
        return `<del>${content}</del>`;

      case 'COLOR': {
        const styles: string[] = [];
        if (decoration.colorData.foreground) {
          styles.push(`color: ${decoration.colorData.foreground}`);
        }
        if (decoration.colorData.background) {
          styles.push(`background-color: ${decoration.colorData.background}`);
        }
        if (styles.length === 0) {
          return content;
        }
        return `<span style="${styles.join('; ')}">${content}</span>`;
      }

      case 'FONT_SIZE': {
        const unit = decoration.fontSizeData.unit.toLowerCase();
        return `<span style="font-size: ${decoration.fontSizeData.value}${unit}">${content}</span>`;
      }

      case 'FONT_FAMILY': {
        const family = decoration.fontFamilyData.family;
        // Use <code> tag for monospace fonts, otherwise use span with style
        if (family === 'monospace' || family.toLowerCase().includes('mono')) {
          return `<code>${content}</code>`;
        }
        return `<span style="font-family: ${this.escapeAttribute(family)}">${content}</span>`;
      }

      case 'LINK': {
        const href = decoration.linkData.link.url;
        // Ricos stores the target as an enum (BLANK/SELF/…); HTML wants the attribute form
        // (_blank/_self/…). Tolerate a value that is already in attribute form so a hand-written or
        // legacy document still round-trips.
        const ricosTarget = decoration.linkData.link.target;
        const htmlTarget = ricosTarget
          ? (RICOS_LINK_TARGET_TO_HTML_TARGET[ricosTarget] ?? (ricosTarget.startsWith('_') ? ricosTarget : undefined))
          : undefined;
        const targetAttr = htmlTarget ? ` target="${this.escapeAttribute(htmlTarget)}"` : '';
        return `<a href="${this.escapeAttribute(href)}"${targetAttr}>${content}</a>`;
      }

      default:
        return content;
    }
  }

  private buildTextStyle(textStyle?: { textAlignment?: 'AUTO' | 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFY' }): string {
    if (!textStyle?.textAlignment || textStyle.textAlignment === 'AUTO' || textStyle.textAlignment === 'LEFT') {
      return '';
    }

    const alignment = textStyle.textAlignment.toLowerCase();
    return `text-align: ${alignment}`;
  }

  private formatTag(tagName: string, content: string, selfClosing: boolean = false, attributes: string = ''): string {
    const indent = this.options.prettify ? this.getIndent() : '';

    if (selfClosing) {
      return `${indent}<${tagName}${attributes}>`;
    }

    if (this.options.prettify && this.isBlockElement(tagName)) {
      return `${indent}<${tagName}${attributes}>${content}</${tagName}>`;
    }

    return `${indent}<${tagName}${attributes}>${content}</${tagName}>`;
  }

  private isBlockElement(tagName: string): boolean {
    const blockElements = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'ul', 'ol', 'li', 'pre'];
    return blockElements.includes(tagName);
  }

  private getIndent(): string {
    return this.options.prettify ? ' '.repeat(this.indentLevel * this.options.indentSize) : '';
  }

  private escapeHtml(text: string): string {
    const htmlEscapes: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
    };

    return text.replace(/[&<>]/g, (match) => htmlEscapes[match] || match);
  }

  private escapeAttribute(text: string): string {
    const htmlEscapes: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };

    return text.replace(/[&<>"']/g, (match) => htmlEscapes[match] || match);
  }
}

export { WixToHtmlConverter };
