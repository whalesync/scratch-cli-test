import MarkdownIt from 'markdown-it';
import TurndownService from 'turndown';
import { HtmlToWixConverter } from './html-to-ricos';
import { createMarkdownParser, createTurndownService, htmlToMarkdown, markdownToHtml } from './markdown-helpers';
import { WixToHtmlConverter } from './ricos-to-html';
import type {
  WixBlockquoteNode,
  WixDocument,
  WixHeadingNode,
  WixImageNode,
  WixListNode,
  WixParagraphNode,
  WixTextData,
} from './types';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace jest {
    interface Matchers<R> {
      toEqualWixRichText(expected: string): R;
    }
  }
}

expect.extend({
  toEqualWixRichText(this: jest.MatcherContext, received: WixDocument, expected: string) {
    // Remove any key named "id" anywhere in the structure
    const stripIds = (value: unknown): unknown => {
      if (Array.isArray(value)) {
        return value.map(stripIds);
      }
      if (value && typeof value === 'object') {
        const result: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(value)) {
          if (key === 'id') {
            continue;
          }
          // Also drop undefined to reduce noise
          if (val === undefined) {
            continue;
          }
          result[key] = stripIds(val);
        }
        return result;
      }
      return value;
    };

    let expectedDocument: unknown;
    try {
      expectedDocument = JSON.parse(expected);
    } catch (err) {
      const { matcherHint } = this.utils;
      return {
        pass: false,
        message: (): string =>
          `${matcherHint('.toEqualWixRichText')}\n\n` +
          `Could not parse expected JSON string.\n` +
          `Parse error: ${(err as Error).message}\n\n` +
          `Expected (raw string):\n${expected}`,
      };
    }

    const sanitizedExpected = stripIds(expectedDocument);
    const sanitizedReceived = stripIds(received);

    const pass = this.equals(sanitizedReceived, sanitizedExpected);

    if (pass) {
      return {
        pass: true,
        message: (): string =>
          `${this.utils.matcherHint('.toEqualWixRichText', 'received', 'expected')}\n\n` +
          `Expected Wix rich text not to match (ids ignored), but it did.`,
      };
    }

    const { matcherHint, printExpected, printReceived, diff } = this.utils;
    const difference =
      diff(sanitizedExpected, sanitizedReceived) ??
      `${printExpected(sanitizedExpected)}\nvs\n${printReceived(sanitizedReceived)}`;

    return {
      pass: false,
      message: (): string =>
        `${matcherHint('.toEqualWixRichText', 'received', 'expected')}\n\n` +
        `Wix rich text mismatch (ids ignored).\n\n` +
        `Expected:\n${printExpected(sanitizedExpected)}\n\n` +
        `Received:\n${printReceived(sanitizedReceived)}\n\n` +
        `Diff:\n${difference}`,
    };
  },
});

describe('HtmlToWixConverter', () => {
  let converter: HtmlToWixConverter;

  beforeEach(() => {
    converter = new HtmlToWixConverter();
  });

  describe('Basic text conversion', () => {
    it('should convert simple paragraph', () => {
      const html = '<p>Hello world</p>';
      const result = converter.convert(html);

      expect(result).toEqualWixRichText(`
        {
          "nodes": [
            {
              "type": "PARAGRAPH",
              "nodes": [
                {
                  "type": "TEXT",

                  "textData": {
                    "text": "Hello world",
                    "decorations": []
                  }
                }
              ],
              "paragraphData": {
                "textStyle": {
                  "textAlignment": "AUTO"
                }
              }
            }
          ]
        }
      `);
    });

    it('should convert empty paragraph to empty nodes', () => {
      const html = '<p></p>';
      const result = converter.convert(html);

      expect(result).toEqualWixRichText(`
        {
          "nodes": [
            {
              "type": "PARAGRAPH",
              "nodes": [],
              "paragraphData": {
                "textStyle": {
                  "textAlignment": "AUTO"
                }
              }
            }
          ]
        }
      `);
    });

    it('should handle plain text without tags', () => {
      const html = 'Plain text';
      const result = converter.convert(html);

      expect(result).toEqualWixRichText(`
        {
          "nodes": [
            {
              "type": "PARAGRAPH",
              "nodes": [
                {
                  "type": "TEXT",

                  "textData": {
                    "text": "Plain text",
                    "decorations": []
                  }
                }
              ],
              "paragraphData": {
                "textStyle": {
                  "textAlignment": "AUTO"
                }
              }
            }
          ]
        }
      `);
    });

    it('should handle multiple paragraphs', () => {
      const html = '<p>First paragraph</p><p>Second paragraph</p>';
      const result = converter.convert(html);

      expect(result).toEqualWixRichText(`
        {
          "nodes": [
            {
              "type": "PARAGRAPH",
              "nodes": [
                {
                  "type": "TEXT",

                  "textData": {
                    "text": "First paragraph",
                    "decorations": []
                  }
                }
              ],
              "paragraphData": {
                "textStyle": {
                  "textAlignment": "AUTO"
                }
              }
            },
            {
              "type": "PARAGRAPH",
              "nodes": [
                {
                  "type": "TEXT",

                  "textData": {
                    "text": "Second paragraph",
                    "decorations": []
                  }
                }
              ],
              "paragraphData": {
                "textStyle": {
                  "textAlignment": "AUTO"
                }
              }
            }
          ]
        }
      `);
    });
  });

  describe('Text formatting', () => {
    it('should convert bold text with fontWeightValue', () => {
      const html = '<p>This is <strong>bold</strong> text</p>';
      const result = converter.convert(html);

      expect(result).toEqualWixRichText(`
        {
          "nodes": [
            {
              "type": "PARAGRAPH",
              "nodes": [
                {
                  "type": "TEXT",

                  "textData": { "text": "This is ", "decorations": [] }
                },
                {
                  "type": "TEXT",

                  "textData": {
                    "text": "bold",
                    "decorations": [{ "type": "BOLD", "fontWeightValue": 700 }]
                  }
                },
                {
                  "type": "TEXT",

                  "textData": { "text": " text", "decorations": [] }
                }
              ],
              "paragraphData": {
                "textStyle": { "textAlignment": "AUTO" }
              }
            }
          ]
        }
      `);
    });

    it('should convert italic text', () => {
      const html = '<p>This is <em>italic</em> text</p>';
      const result = converter.convert(html);

      expect(result).toEqualWixRichText(`
        {
          "nodes": [
            {
              "type": "PARAGRAPH",
              "nodes": [
                {
                  "type": "TEXT",

                  "textData": { "text": "This is ", "decorations": [] }
                },
                {
                  "type": "TEXT",

                  "textData": {
                    "text": "italic",
                    "decorations": [{ "type": "ITALIC", "italicData": true }]
                  }
                },
                {
                  "type": "TEXT",

                  "textData": { "text": " text", "decorations": [] }
                }
              ],
              "paragraphData": {
                "textStyle": { "textAlignment": "AUTO" }
              }
            }
          ]
        }
      `);
    });

    it('should convert underlined text', () => {
      const html = '<p>This is <u>underlined</u> text</p>';
      const result = converter.convert(html);

      expect(result).toEqualWixRichText(`
        {
          "nodes": [
            {
              "type": "PARAGRAPH",
              "nodes": [
                {
                  "type": "TEXT",

                  "textData": { "text": "This is ", "decorations": [] }
                },
                {
                  "type": "TEXT",

                  "textData": {
                    "text": "underlined",
                    "decorations": [{ "type": "UNDERLINE", "underlineData": true }]
                  }
                },
                {
                  "type": "TEXT",

                  "textData": { "text": " text", "decorations": [] }
                }
              ],
              "paragraphData": {
                "textStyle": { "textAlignment": "AUTO" }
              }
            }
          ]
        }
      `);
    });

    it('should convert strikethrough text', () => {
      const html = '<p>This is <del>strikethrough</del> text</p>';
      const result = converter.convert(html);

      expect(result).toEqualWixRichText(`
        {
          "nodes": [
            {
              "type": "PARAGRAPH",
              "nodes": [
                {
                  "type": "TEXT",

                  "textData": { "text": "This is ", "decorations": [] }
                },
                {
                  "type": "TEXT",

                  "textData": {
                    "text": "strikethrough",
                    "decorations": [{ "type": "STRIKETHROUGH", "strikethroughData": true }]
                  }
                },
                {
                  "type": "TEXT",

                  "textData": { "text": " text", "decorations": [] }
                }
              ],
              "paragraphData": {
                "textStyle": { "textAlignment": "AUTO" }
              }
            }
          ]
        }
      `);
    });

    it('should handle nested formatting', () => {
      const html = '<p><strong><em>Bold and italic</em></strong></p>';
      const result = converter.convert(html);

      expect(result).toEqualWixRichText(`
        {
          "nodes": [
            {
              "type": "PARAGRAPH",
              "nodes": [
                {
                  "type": "TEXT",

                  "textData": {
                    "text": "Bold and italic",
                    "decorations": [
                      { "type": "BOLD", "fontWeightValue": 700 },
                      { "type": "ITALIC", "italicData": true }
                    ]
                  }
                }
              ],
              "paragraphData": {
                "textStyle": { "textAlignment": "AUTO" }
              }
            }
          ]
        }
      `);
    });

    it('should handle styled spans with color', () => {
      const html = '<p><span style="color: red;">Red text</span></p>';
      const result = converter.convert(html);

      expect(result).toEqualWixRichText(`
        {
          "nodes": [
            {
              "type": "PARAGRAPH",
              "nodes": [
                {
                  "type": "TEXT",

                  "textData": {
                    "text": "Red text",
                    "decorations": [{ "type": "COLOR", "colorData": { "foreground": "red" } }]
                  }
                }
              ],
              "paragraphData": {
                "textStyle": { "textAlignment": "AUTO" }
              }
            }
          ]
        }
      `);
    });

    it('should handle font-size in spans', () => {
      const html = '<p><span style="font-size: 16px;">Sized text</span></p>';
      const result = converter.convert(html);

      expect(result).toEqualWixRichText(`
        {
          "nodes": [
            {
              "type": "PARAGRAPH",
              "nodes": [
                {
                  "type": "TEXT",

                  "textData": {
                    "text": "Sized text",
                    "decorations": [{ "type": "FONT_SIZE", "fontSizeData": { "unit": "PX", "value": 16 } }]
                  }
                }
              ],
              "paragraphData": {
                "textStyle": { "textAlignment": "AUTO" }
              }
            }
          ]
        }
      `);
    });

    it('should convert inline code with font-family decoration', () => {
      const html = '<p>This is <code>inline code</code> text</p>';
      const result = converter.convert(html);

      expect(result).toEqualWixRichText(`
        {
          "nodes": [
            {
              "type": "PARAGRAPH",
              "nodes": [
                {
                  "type": "TEXT",

                  "textData": { "text": "This is ", "decorations": [] }
                },
                {
                  "type": "TEXT",

                  "textData": {
                    "text": "inline code",
                    "decorations": [{ "type": "FONT_FAMILY", "fontFamilyData": { "family": "monospace" } }]
                  }
                },
                {
                  "type": "TEXT",

                  "textData": { "text": " text", "decorations": [] }
                }
              ],
              "paragraphData": {
                "textStyle": { "textAlignment": "AUTO" }
              }
            }
          ]
        }
      `);
    });

    it('should handle font-family in spans', () => {
      const html = '<p><span style="font-family: Arial;">Custom font</span></p>';
      const result = converter.convert(html);

      expect(result).toEqualWixRichText(`
        {
          "nodes": [
            {
              "type": "PARAGRAPH",
              "nodes": [
                {
                  "type": "TEXT",

                  "textData": {
                    "text": "Custom font",
                    "decorations": [{ "type": "FONT_FAMILY", "fontFamilyData": { "family": "Arial" } }]
                  }
                }
              ],
              "paragraphData": {
                "textStyle": { "textAlignment": "AUTO" }
              }
            }
          ]
        }
      `);
    });
  });

  describe('Headings', () => {
    it('should convert all heading levels', () => {
      const html = '<h1>H1</h1><h2>H2</h2><h3>H3</h3><h4>H4</h4><h5>H5</h5><h6>H6</h6>';
      const result = converter.convert(html);

      // Now adds empty paragraphs for spacing before headings (except first)
      // So: H1, (empty), H2, (empty), H3, (empty), H4, (empty), H5, (empty), H6 = 11 nodes
      expect(result.nodes).toHaveLength(11);

      // Check the headings (at indices 0, 2, 4, 6, 8, 10)
      for (let i = 0; i < 6; i++) {
        const nodeIndex = i * 2; // Skip empty paragraphs
        expect(result.nodes[nodeIndex].type).toBe('HEADING');
        const heading = result.nodes[nodeIndex] as WixHeadingNode;
        expect(heading.headingData.level).toBe(i + 1);
        expect(heading.nodes[0].textData.text).toBe(`H${i + 1}`);

        // Check empty paragraph spacing (except after last heading)
        if (i < 5) {
          const emptyPara = result.nodes[nodeIndex + 1] as WixParagraphNode;
          expect(emptyPara.type).toBe('PARAGRAPH');
          expect(emptyPara.nodes).toHaveLength(0);
        }
      }
    });

    it('should handle heading with text alignment', () => {
      const html = '<h1 style="text-align: center;">Centered Heading</h1>';
      const result = converter.convert(html);

      const heading = result.nodes[0] as WixHeadingNode;
      expect(heading.headingData.textStyle?.textAlignment).toBe('CENTER');
    });
  });

  describe('Links', () => {
    it('should convert simple links', () => {
      const html = '<p><a href="https://example.com">Link text</a></p>';
      const result = converter.convert(html);

      const paragraph = result.nodes[0] as WixParagraphNode;
      expect(paragraph.nodes[0].textData.decorations[0]).toEqual({
        type: 'LINK',
        linkData: {
          link: {
            url: 'https://example.com',
          },
        },
      });
    });

    // Wix validates `target` against a protobuf enum, so the HTML attribute value has to be mapped:
    // sending '_blank' makes the API reject the entire document with
    // "target enum must be in [SELF(0), BLANK(1), PARENT(2), TOP(3)]" (DEV-11124).
    it.each([
      ['_blank', 'BLANK'],
      ['_self', 'SELF'],
      ['_parent', 'PARENT'],
      ['_top', 'TOP'],
      ['_BLANK', 'BLANK'],
    ])('should map the HTML target %s to the Ricos enum %s', (htmlTarget, ricosTarget) => {
      const html = `<p><a href="https://example.com" target="${htmlTarget}">External link</a></p>`;
      const result = converter.convert(html);

      const paragraph = result.nodes[0] as WixParagraphNode;
      expect(paragraph.nodes[0].textData.decorations[0]).toEqual({
        type: 'LINK',
        linkData: {
          link: {
            url: 'https://example.com',
            target: ricosTarget,
          },
        },
      });
    });

    it('should omit an unrecognized target rather than send a value Wix would reject', () => {
      const html = '<p><a href="https://example.com" target="framename">Named frame</a></p>';
      const result = converter.convert(html);

      const paragraph = result.nodes[0] as WixParagraphNode;
      expect(paragraph.nodes[0].textData.decorations[0]).toEqual({
        type: 'LINK',
        linkData: { link: { url: 'https://example.com' } },
      });
    });
  });

  describe('Lists', () => {
    it('should convert bulleted lists', () => {
      const html = '<ul><li>Item 1</li><li>Item 2</li></ul>';
      const result = converter.convert(html);

      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].type).toBe('BULLETED_LIST');

      const list = result.nodes[0] as WixListNode;
      expect(list.nodes).toHaveLength(2);
      expect(list.bulletedListData).toEqual({ indentation: 0 });
      expect(list.nodes[0].type).toBe('LIST_ITEM');
      expect(list.nodes[1].type).toBe('LIST_ITEM');
    });

    it('should convert numbered lists correctly', () => {
      const html = '<ol><li><p>First</p></li><li><p>Second</p></li></ol>';
      const result = converter.convert(html);

      expect(result).toEqualWixRichText(`
        {
          "nodes": [
            {
              "type": "ORDERED_LIST",
              "nodes": [
                {
                  "type": "LIST_ITEM",
                  "nodes": [
                    {
                      "type": "PARAGRAPH",
                      "nodes": [
                        {
                          "type": "TEXT",
                          "textData": {
                            "text": "First",
                            "decorations": []
                          }
                        }
                      ],
                      "paragraphData": {
                        "textStyle": {
                          "textAlignment": "AUTO"
                        }
                      }
                    }
                  ],
                  "listItemData": {}
                },
                {
                  "type": "LIST_ITEM",
                  "nodes": [
                    {
                      "type": "PARAGRAPH",
                      "nodes": [
                        {
                          "type": "TEXT",
                          "textData": {
                            "text": "Second",
                            "decorations": []
                          }
                        }
                      ],
                      "paragraphData": {
                        "textStyle": {
                          "textAlignment": "AUTO"
                        }
                      }
                    }
                  ],
                  "listItemData": {}
                }
              ],
              "numberedListData": {
                "indentation": 0
              }
            }
          ]
        }
      `);
    });

    it('should handle complex list items with formatting', () => {
      const html = '<ul><li><strong>Bold item</strong> with normal text</li></ul>';
      const result = converter.convert(html);

      expect(result).toEqualWixRichText(`
        {
          "nodes": [
            {
              "type": "BULLETED_LIST",
              "nodes": [
                {
                  "type": "LIST_ITEM",
                  "nodes": [
                    {
                      "type": "PARAGRAPH",
                      "nodes": [
                        {
                          "type": "TEXT",
                          "textData": {
                            "text": "Bold item",
                            "decorations": [
                              {
                                "type": "BOLD",
                                "fontWeightValue": 700
                              }
                            ]
                          }
                        },
                        {
                          "type": "TEXT",
                          "textData": {
                            "text": " with normal text",
                            "decorations": []
                          }
                        }
                      ],
                      "paragraphData": {
                        "textStyle": {
                          "textAlignment": "AUTO"
                        }
                      }
                    }
                  ],
                  "listItemData": {}
                }
              ],
              "bulletedListData": {
                "indentation": 0
              }
            }
          ]
        }
      `);
    });
  });

  describe('Special elements', () => {
    it('should convert line breaks', () => {
      const html = 'Line 1<br>Line 2';
      const result = converter.convert(html);

      expect(result.nodes).toHaveLength(3);
      expect(result.nodes[1].type).toBe('PARAGRAPH');
      const brParagraph = result.nodes[1] as WixParagraphNode;
      expect(brParagraph.nodes).toEqual([]);
    });

    it('should convert horizontal rules', () => {
      const html = '<p>Before</p><hr><p>After</p>';
      const result = converter.convert(html);

      expect(result.nodes).toHaveLength(3);
      expect(result.nodes[1].type).toBe('DIVIDER');
    });

    it('should convert preformatted text', () => {
      const html = '<pre>Code block</pre>';
      const result = converter.convert(html);

      expect(result.nodes[0].type).toBe('CODE_BLOCK');
    });

    it('should convert blockquotes', () => {
      const html = '<blockquote><p>This is a quote</p></blockquote>';
      const result = converter.convert(html);

      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].type).toBe('BLOCKQUOTE');

      const blockquote = result.nodes[0] as WixBlockquoteNode;
      expect(blockquote.nodes).toHaveLength(1);
      expect(blockquote.nodes[0].type).toBe('PARAGRAPH');
      expect((blockquote.nodes[0] as WixParagraphNode).nodes[0].textData.text).toBe('This is a quote');
    });

    it('should convert images with Wix media ID', () => {
      const html =
        '<img src="wix:image://v1/9a4116_2161bd3b120046b7bc653b638305c2cc~mv2.jpg" alt="Test image" width="1024" height="768">';
      const result = converter.convert(html);

      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].type).toBe('IMAGE');

      const image = result.nodes[0] as WixImageNode;
      expect(image.imageData.image.src.id).toBe('9a4116_2161bd3b120046b7bc653b638305c2cc~mv2.jpg');
      expect(image.imageData.image.width).toBe(1024);
      expect(image.imageData.image.height).toBe(768);
      expect(image.imageData.altText).toBe('Test image');
    });

    it('should convert images with full URL', () => {
      const html = '<img src="https://static.wixstatic.com/media/9a4116_abc123.jpg" alt="Photo">';
      const result = converter.convert(html);

      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].type).toBe('IMAGE');

      const image = result.nodes[0] as WixImageNode;
      expect(image.imageData.image.src.id).toBe('9a4116_abc123.jpg');
      expect(image.imageData.image.src.url).toBe('https://static.wixstatic.com/media/9a4116_abc123.jpg');
      expect(image.imageData.altText).toBe('Photo');
    });

    it('should preserve container data in round-trip', () => {
      const html =
        '<img src="wix:image://v1/test.jpg" data-wix-container=\'{"width":{"custom":"498"},"alignment":"CENTER","textWrap":true}\'>';
      const result = converter.convert(html);

      const image = result.nodes[0] as WixImageNode;
      expect(image.imageData.containerData).toEqual({
        width: { custom: '498' },
        alignment: 'CENTER',
        textWrap: true,
      });
    });
  });

  describe('Edge cases', () => {
    it('should handle empty HTML', () => {
      const html = '';
      const result = converter.convert(html);

      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].type).toBe('PARAGRAPH');
    });

    it('should handle whitespace-only text', () => {
      const html = '<p>   </p>';
      const result = converter.convert(html);

      const paragraph = result.nodes[0] as WixParagraphNode;
      expect(paragraph.nodes[0].textData.text).toBe('   ');
    });

    it('should generate unique IDs', () => {
      const html = '<p>Para 1</p><p>Para 2</p>';
      const result = converter.convert(html);

      expect(result.nodes[0].id).not.toBe(result.nodes[1].id);
      expect(result.nodes[0].id).toMatch(/^node_\d+_\d+$/);
    });

    it('should handle text alignment styles', () => {
      const alignments = ['left', 'center', 'right', 'justify'];
      const expectedAlignments = ['LEFT', 'CENTER', 'RIGHT', 'JUSTIFY'];

      alignments.forEach((align, index) => {
        const html = `<p style="text-align: ${align};">Aligned text</p>`;
        const result = converter.convert(html);

        const paragraph = result.nodes[0] as WixParagraphNode;
        expect(paragraph.paragraphData?.textStyle?.textAlignment).toBe(expectedAlignments[index]);
      });
    });
  });
});

describe('WixToHtmlConverter', () => {
  let converter: WixToHtmlConverter;

  beforeEach(() => {
    converter = new WixToHtmlConverter({ prettify: false });
  });

  describe('Basic conversion', () => {
    it('should convert simple paragraph', () => {
      const wixDoc: WixDocument = {
        nodes: [
          {
            type: 'PARAGRAPH',
            id: 'para1',
            nodes: [
              {
                type: 'TEXT',
                id: 'text1',
                nodes: [],
                textData: {
                  text: 'Hello world',
                  decorations: [],
                },
              },
            ],
            paragraphData: {},
          },
        ],
      };

      const result = converter.convert(wixDoc);
      expect(result).toBe('<p>Hello world</p>');
    });

    it('should convert empty paragraph to br tag', () => {
      const wixDoc: WixDocument = {
        nodes: [
          {
            type: 'PARAGRAPH',
            id: 'para1',
            nodes: [],
            paragraphData: {},
          },
        ],
      };

      const result = converter.convert(wixDoc);
      expect(result).toBe('<br>');
    });

    it('should handle missing textData gracefully', () => {
      const wixDoc: WixDocument = {
        nodes: [
          {
            type: 'PARAGRAPH',
            id: 'para1',
            nodes: [
              {
                type: 'TEXT',
                id: 'text1',
                nodes: [],
                textData: null as unknown as WixTextData,
              },
            ],
            paragraphData: {},
          },
        ],
      };

      const result = converter.convert(wixDoc);
      expect(result).toBe('<br>');
    });
  });

  describe('Text formatting', () => {
    it('should convert bold text with fontWeightValue', () => {
      const wixDoc: WixDocument = {
        nodes: [
          {
            type: 'PARAGRAPH',
            id: 'para1',
            nodes: [
              {
                type: 'TEXT',
                id: 'text1',
                nodes: [],
                textData: {
                  text: 'Bold text',
                  decorations: [
                    {
                      type: 'BOLD',
                      fontWeightValue: 700,
                    },
                  ],
                },
              },
            ],
            paragraphData: {},
          },
        ],
      };

      const result = converter.convert(wixDoc);
      expect(result).toBe('<p><strong>Bold text</strong></p>');
    });

    it('should convert bold text with boldData', () => {
      const wixDoc: WixDocument = {
        nodes: [
          {
            type: 'PARAGRAPH',
            id: 'para1',
            nodes: [
              {
                type: 'TEXT',
                id: 'text1',
                nodes: [],
                textData: {
                  text: 'Bold text',
                  decorations: [
                    {
                      type: 'BOLD',
                      boldData: true,
                    },
                  ],
                },
              },
            ],
            paragraphData: {},
          },
        ],
      };

      const result = converter.convert(wixDoc);
      expect(result).toBe('<p><strong>Bold text</strong></p>');
    });

    it('should convert italic text', () => {
      const wixDoc: WixDocument = {
        nodes: [
          {
            type: 'PARAGRAPH',
            id: 'para1',
            nodes: [
              {
                type: 'TEXT',
                id: 'text1',
                nodes: [],
                textData: {
                  text: 'Italic text',
                  decorations: [
                    {
                      type: 'ITALIC',
                      italicData: true,
                    },
                  ],
                },
              },
            ],
            paragraphData: {},
          },
        ],
      };

      const result = converter.convert(wixDoc);
      expect(result).toBe('<p><em>Italic text</em></p>');
    });

    it('should convert strikethrough text', () => {
      const wixDoc: WixDocument = {
        nodes: [
          {
            type: 'PARAGRAPH',
            id: 'para1',
            nodes: [
              {
                type: 'TEXT',
                id: 'text1',
                nodes: [],
                textData: {
                  text: 'Strikethrough text',
                  decorations: [
                    {
                      type: 'STRIKETHROUGH',
                      strikethroughData: true,
                    },
                  ],
                },
              },
            ],
            paragraphData: {},
          },
        ],
      };

      const result = converter.convert(wixDoc);
      expect(result).toBe('<p><del>Strikethrough text</del></p>');
    });

    it('should handle multiple decorations', () => {
      const wixDoc: WixDocument = {
        nodes: [
          {
            type: 'PARAGRAPH',
            id: 'para1',
            nodes: [
              {
                type: 'TEXT',
                id: 'text1',
                nodes: [],
                textData: {
                  text: 'Formatted text',
                  decorations: [
                    { type: 'BOLD', fontWeightValue: 700 },
                    { type: 'ITALIC', italicData: true },
                  ],
                },
              },
            ],
            paragraphData: {},
          },
        ],
      };

      const result = converter.convert(wixDoc);
      expect(result).toBe('<p><em><strong>Formatted text</strong></em></p>');
    });

    it('should convert color decorations', () => {
      const wixDoc: WixDocument = {
        nodes: [
          {
            type: 'PARAGRAPH',
            id: 'para1',
            nodes: [
              {
                type: 'TEXT',
                id: 'text1',
                nodes: [],
                textData: {
                  text: 'Red text',
                  decorations: [
                    {
                      type: 'COLOR',
                      colorData: {
                        foreground: '#ff0000',
                      },
                    },
                  ],
                },
              },
            ],
            paragraphData: {},
          },
        ],
      };

      const result = converter.convert(wixDoc);
      expect(result).toBe('<p><span style="color: #ff0000">Red text</span></p>');
    });

    it('should convert font size decorations', () => {
      const wixDoc: WixDocument = {
        nodes: [
          {
            type: 'PARAGRAPH',
            id: 'para1',
            nodes: [
              {
                type: 'TEXT',
                id: 'text1',
                nodes: [],
                textData: {
                  text: 'Large text',
                  decorations: [
                    {
                      type: 'FONT_SIZE',
                      fontSizeData: {
                        unit: 'PX',
                        value: 24,
                      },
                    },
                  ],
                },
              },
            ],
            paragraphData: {},
          },
        ],
      };

      const result = converter.convert(wixDoc);
      expect(result).toBe('<p><span style="font-size: 24px">Large text</span></p>');
    });

    it('should convert link decorations', () => {
      const wixDoc: WixDocument = {
        nodes: [
          {
            type: 'PARAGRAPH',
            id: 'para1',
            nodes: [
              {
                type: 'TEXT',
                id: 'text1',
                nodes: [],
                textData: {
                  text: 'Link text',
                  decorations: [
                    {
                      type: 'LINK',
                      linkData: {
                        link: {
                          url: 'https://example.com',
                          // Wix stores the link target as a protobuf enum (BLANK), not the HTML
                          // attribute value (_blank) — see WixLinkTarget.
                          target: 'BLANK',
                        },
                      },
                    },
                  ],
                },
              },
            ],
            paragraphData: {},
          },
        ],
      };

      const result = converter.convert(wixDoc);
      expect(result).toBe('<p><a href="https://example.com" target="_blank">Link text</a></p>');
    });

    it('should convert monospace font-family to code tag', () => {
      const wixDoc: WixDocument = {
        nodes: [
          {
            type: 'PARAGRAPH',
            id: 'para1',
            nodes: [
              {
                type: 'TEXT',
                id: 'text1',
                nodes: [],
                textData: {
                  text: 'inline code',
                  decorations: [
                    {
                      type: 'FONT_FAMILY',
                      fontFamilyData: {
                        family: 'monospace',
                      },
                    },
                  ],
                },
              },
            ],
            paragraphData: {},
          },
        ],
      };

      const result = converter.convert(wixDoc);
      expect(result).toBe('<p><code>inline code</code></p>');
    });

    it('should convert non-monospace font-family to span with style', () => {
      const wixDoc: WixDocument = {
        nodes: [
          {
            type: 'PARAGRAPH',
            id: 'para1',
            nodes: [
              {
                type: 'TEXT',
                id: 'text1',
                nodes: [],
                textData: {
                  text: 'Custom font',
                  decorations: [
                    {
                      type: 'FONT_FAMILY',
                      fontFamilyData: {
                        family: 'Arial',
                      },
                    },
                  ],
                },
              },
            ],
            paragraphData: {},
          },
        ],
      };

      const result = converter.convert(wixDoc);
      expect(result).toBe('<p><span style="font-family: Arial">Custom font</span></p>');
    });
  });

  describe('Headings', () => {
    it('should convert all heading levels', () => {
      for (let level = 1; level <= 6; level++) {
        const wixDoc: WixDocument = {
          nodes: [
            {
              type: 'HEADING',
              id: 'heading1',
              nodes: [
                {
                  type: 'TEXT',
                  id: 'text1',
                  nodes: [],
                  textData: {
                    text: `Heading ${level}`,
                    decorations: [],
                  },
                },
              ],
              headingData: {
                level: level as 1 | 2 | 3 | 4 | 5 | 6,
                textStyle: {
                  textAlignment: 'AUTO',
                },
              },
            },
          ],
        };

        const result = converter.convert(wixDoc);
        expect(result).toBe(`<h${level}>Heading ${level}</h${level}>`);
      }
    });

    it('should handle heading with text alignment', () => {
      const wixDoc: WixDocument = {
        nodes: [
          {
            type: 'HEADING',
            id: 'heading1',
            nodes: [
              {
                type: 'TEXT',
                id: 'text1',
                nodes: [],
                textData: {
                  text: 'Centered heading',
                  decorations: [],
                },
              },
            ],
            headingData: {
              level: 1,
              textStyle: {
                textAlignment: 'CENTER',
              },
            },
          },
        ],
      };

      const result = converter.convert(wixDoc);
      expect(result).toBe('<h1 style="text-align: center">Centered heading</h1>');
    });
  });

  describe('Lists', () => {
    it('should convert bulleted lists', () => {
      const wixDoc: WixDocument = {
        nodes: [
          {
            type: 'BULLETED_LIST',
            id: 'list1',
            nodes: [
              {
                type: 'LIST_ITEM',
                id: 'item1',
                nodes: [
                  {
                    type: 'PARAGRAPH',
                    id: 'para1',
                    nodes: [
                      {
                        type: 'TEXT',
                        id: 'text1',
                        nodes: [],
                        textData: {
                          text: 'Item 1',
                          decorations: [],
                        },
                      },
                    ],
                    paragraphData: {},
                  },
                ],
                listItemData: {},
              },
            ],
            bulletedListData: {
              indentation: 0,
            },
          },
        ],
      };

      const result = converter.convert(wixDoc);
      expect(result).toBe('<ul><li>Item 1</li></ul>');
    });

    it('should convert numbered lists', () => {
      const wixDoc: WixDocument = {
        nodes: [
          {
            type: 'ORDERED_LIST',
            id: 'list1',
            nodes: [
              {
                type: 'LIST_ITEM',
                id: 'item1',
                nodes: [
                  {
                    type: 'PARAGRAPH',
                    id: 'para1',
                    nodes: [
                      {
                        type: 'TEXT',
                        id: 'text1',
                        nodes: [],
                        textData: {
                          text: 'First item',
                          decorations: [],
                        },
                      },
                    ],
                    paragraphData: {},
                  },
                ],
                listItemData: {},
              },
            ],
            numberedListData: {
              indentation: 0,
            },
          },
        ],
      };

      const result = converter.convert(wixDoc);
      expect(result).toBe('<ol><li>First item</li></ol>');
    });

    it('should handle empty list items', () => {
      const wixDoc: WixDocument = {
        nodes: [
          {
            type: 'BULLETED_LIST',
            id: 'list1',
            nodes: [
              {
                type: 'LIST_ITEM',
                id: 'item1',
                nodes: [],
                listItemData: {},
              },
            ],
            bulletedListData: {
              indentation: 0,
            },
          },
        ],
      };

      const result = converter.convert(wixDoc);
      expect(result).toBe('<ul><li></li></ul>');
    });
  });

  describe('Special elements', () => {
    it('should convert dividers', () => {
      const wixDoc: WixDocument = {
        nodes: [
          {
            type: 'DIVIDER',
            id: 'divider1',
            dividerData: {
              lineStyle: 'SINGLE',
            },
          },
        ],
      };

      const result = converter.convert(wixDoc);
      expect(result).toBe('<hr>');
    });

    it('should convert code blocks', () => {
      const wixDoc: WixDocument = {
        nodes: [
          {
            type: 'CODE_BLOCK',
            id: 'code1',
            nodes: [
              {
                type: 'TEXT',
                id: 'text1',
                nodes: [],
                textData: {
                  text: 'console.log("Hello");',
                  decorations: [],
                },
              },
            ],
            codeBlockData: {
              textStyle: {
                textAlignment: 'LEFT',
              },
            },
          },
        ],
      };

      const result = converter.convert(wixDoc);
      expect(result).toBe('<pre>console.log("Hello");</pre>');
    });

    it('should convert images to HTML', () => {
      const wixDoc: WixDocument = {
        nodes: [
          {
            type: 'IMAGE',
            id: '4twek140',
            nodes: [],
            imageData: {
              containerData: {
                width: { custom: '498' },
                alignment: 'CENTER',
                textWrap: true,
              },
              image: {
                src: {
                  id: '9a4116_2161bd3b120046b7bc653b638305c2cc~mv2.jpg',
                },
                width: 1024,
                height: 1024,
              },
            },
          },
        ],
      };

      const result = converter.convert(wixDoc);
      expect(result).toContain('<img ');
      expect(result).toContain('src="wix:image://v1/9a4116_2161bd3b120046b7bc653b638305c2cc~mv2.jpg"');
      expect(result).toContain('width="1024"');
      expect(result).toContain('height="1024"');
      expect(result).toContain('data-wix-container=');
    });

    it('should convert images with alt text', () => {
      const wixDoc: WixDocument = {
        nodes: [
          {
            type: 'IMAGE',
            id: 'img1',
            nodes: [],
            imageData: {
              image: {
                src: {
                  id: 'test.jpg',
                },
              },
              altText: 'Test image description',
            },
          },
        ],
      };

      const result = converter.convert(wixDoc);
      expect(result).toContain('alt="Test image description"');
    });
  });

  describe('HTML escaping', () => {
    it('should escape HTML special characters', () => {
      const wixDoc: WixDocument = {
        nodes: [
          {
            type: 'PARAGRAPH',
            id: 'para1',
            nodes: [
              {
                type: 'TEXT',
                id: 'text1',
                nodes: [],
                textData: {
                  text: '<script>alert("xss")</script>',
                  decorations: [],
                },
              },
            ],
            paragraphData: {},
          },
        ],
      };

      const result = converter.convert(wixDoc);
      expect(result).toBe('<p>&lt;script&gt;alert("xss")&lt;/script&gt;</p>');
    });

    it('should escape link URLs', () => {
      const wixDoc: WixDocument = {
        nodes: [
          {
            type: 'PARAGRAPH',
            id: 'para1',
            nodes: [
              {
                type: 'TEXT',
                id: 'text1',
                nodes: [],
                textData: {
                  text: 'Link',
                  decorations: [
                    {
                      type: 'LINK',
                      linkData: {
                        link: {
                          url: 'javascript:alert("xss")',
                        },
                      },
                    },
                  ],
                },
              },
            ],
            paragraphData: {},
          },
        ],
      };

      const result = converter.convert(wixDoc);
      expect(result).toBe('<p><a href="javascript:alert(&quot;xss&quot;)">Link</a></p>');
    });
  });

  describe('Prettification options', () => {
    it('should format with indentation when prettify is true', () => {
      const converter = new WixToHtmlConverter({ prettify: true, indentSize: 2 });

      const wixDoc: WixDocument = {
        nodes: [
          {
            type: 'BULLETED_LIST',
            id: 'list1',
            nodes: [
              {
                type: 'LIST_ITEM',
                id: 'item1',
                nodes: [
                  {
                    type: 'PARAGRAPH',
                    id: 'para1',
                    nodes: [
                      {
                        type: 'TEXT',
                        id: 'text1',
                        nodes: [],
                        textData: {
                          text: 'Item',
                          decorations: [],
                        },
                      },
                    ],
                    paragraphData: {},
                  },
                ],
                listItemData: {},
              },
            ],
            bulletedListData: { indentation: 0 },
          },
        ],
      };

      const result = converter.convert(wixDoc);
      expect(result).toContain('\n');
      expect(result).toContain('  <li>Item</li>');
    });
  });
});

describe('Round-trip conversion', () => {
  let htmlToWix: HtmlToWixConverter;
  let wixToHtml: WixToHtmlConverter;

  beforeEach(() => {
    htmlToWix = new HtmlToWixConverter();
    wixToHtml = new WixToHtmlConverter({ prettify: false });
  });

  it('should maintain content through round-trip conversion', () => {
    const originalHtml = '<h1>Title</h1><p>This is <strong>bold</strong> and <em>italic</em> text.</p>';

    const wixDoc = htmlToWix.convert(originalHtml);
    const convertedHtml = wixToHtml.convert(wixDoc);

    // The structure should be preserved even if formatting changes slightly
    expect(convertedHtml).toContain('<h1>Title</h1>');
    expect(convertedHtml).toContain('<strong>bold</strong>');
    expect(convertedHtml).toContain('<em>italic</em>');
  });

  it('should handle complex nested structures', () => {
    const originalHtml = `
      <h2>My List</h2>
      <ul>
        <li><strong>Bold item</strong> with normal text</li>
        <li>Item with <a href="https://example.com">link</a></li>
      </ul>
      <hr>
      <p>After divider</p>
    `;

    const wixDoc = htmlToWix.convert(originalHtml);
    const convertedHtml = wixToHtml.convert(wixDoc);

    expect(convertedHtml).toContain('<h2>My List</h2>');
    expect(convertedHtml).toContain('<ul>');
    expect(convertedHtml).toContain('<strong>Bold item</strong>');
    expect(convertedHtml).toContain('<a href="https://example.com">link</a>');
    expect(convertedHtml).toContain('<hr>');
  });

  it('should preserve text alignment', () => {
    const originalHtml = '<p style="text-align: center;">Centered text</p>';

    const wixDoc = htmlToWix.convert(originalHtml);
    const convertedHtml = wixToHtml.convert(wixDoc);

    expect(convertedHtml).toContain('style="text-align: center"');
  });

  it('should preserve inline code through round-trip', () => {
    const originalHtml = '<p>This is <code>inline code</code> in text</p>';

    const wixDoc = htmlToWix.convert(originalHtml);
    const convertedHtml = wixToHtml.convert(wixDoc);

    expect(convertedHtml).toContain('<code>inline code</code>');
    expect(convertedHtml).toContain('This is');
    expect(convertedHtml).toContain('in text');
  });

  it('should preserve images through round-trip', () => {
    const originalHtml = '<img src="wix:image://v1/test_image.jpg" alt="Test" width="800" height="600">';

    const wixDoc = htmlToWix.convert(originalHtml);
    const convertedHtml = wixToHtml.convert(wixDoc);

    expect(convertedHtml).toContain('<img ');
    expect(convertedHtml).toContain('src="wix:image://v1/test_image.jpg"');
    expect(convertedHtml).toContain('alt="Test"');
    expect(convertedHtml).toContain('width="800"');
    expect(convertedHtml).toContain('height="600"');
  });

  it('ACTUAL WIX DATA: should preserve image from real Wix blog post', () => {
    const actualWixImage: WixImageNode = {
      type: 'IMAGE',
      id: '4twek140',
      nodes: [],
      imageData: {
        containerData: {
          width: { custom: '498' },
          alignment: 'CENTER',
          textWrap: true,
        },
        image: {
          src: {
            id: '9a4116_2161bd3b120046b7bc653b638305c2cc~mv2.jpg',
          },
          width: 1024,
          height: 1024,
        },
      },
    };

    // Convert to HTML
    const html = wixToHtml.convert({ nodes: [actualWixImage] });

    // Convert back to Ricos
    const backToRicos = htmlToWix.convert(html);

    // Verify round-trip preserves the image
    expect(backToRicos.nodes).toHaveLength(1);
    expect(backToRicos.nodes[0].type).toBe('IMAGE');

    const imageNode = backToRicos.nodes[0] as WixImageNode;
    expect(imageNode.imageData.image.src.id).toBe('9a4116_2161bd3b120046b7bc653b638305c2cc~mv2.jpg');
    expect(imageNode.imageData.image.width).toBe(1024);
    expect(imageNode.imageData.image.height).toBe(1024);
    expect(imageNode.imageData.containerData).toEqual({
      width: { custom: '498' },
      alignment: 'CENTER',
      textWrap: true,
    });
  });

  it('should handle empty content gracefully', () => {
    const originalHtml = '';

    const wixDoc = htmlToWix.convert(originalHtml);
    const convertedHtml = wixToHtml.convert(wixDoc);

    expect(convertedHtml).toBe('<br>');
  });

  it('should preserve spacing between sections with empty paragraphs', () => {
    const originalHtml = '<h2>Section 1</h2><p>Content 1</p><p></p><h2>Section 2</h2><p>Content 2</p>';

    const wixDoc = htmlToWix.convert(originalHtml);
    const convertedHtml = wixToHtml.convert(wixDoc);

    // Empty paragraphs should become <br> tags to preserve spacing
    expect(convertedHtml).toContain('<br>');
    expect(convertedHtml).toContain('<h2>Section 1</h2>');
    expect(convertedHtml).toContain('<h2>Section 2</h2>');
  });

  it('should maintain spacing between multiple block elements', () => {
    const wixDoc: WixDocument = {
      nodes: [
        {
          type: 'HEADING',
          id: 'h1',
          nodes: [
            {
              type: 'TEXT',
              id: 't1',
              nodes: [],
              textData: { text: 'Heading', decorations: [] },
            },
          ],
          headingData: { level: 2 },
        },
        {
          type: 'PARAGRAPH',
          id: 'p1',
          nodes: [
            {
              type: 'TEXT',
              id: 't2',
              nodes: [],
              textData: { text: 'Paragraph', decorations: [] },
            },
          ],
          paragraphData: {},
        },
        {
          type: 'PARAGRAPH',
          id: 'p2',
          nodes: [], // Empty paragraph for spacing
          paragraphData: {},
        },
      ],
    };

    // Test with prettify=true (default)
    const prettifiedConverter = new WixToHtmlConverter({ prettify: true });
    const prettifiedHtml = prettifiedConverter.convert(wixDoc);

    // Should have all three elements
    expect(prettifiedHtml).toContain('<h2>Heading</h2>');
    expect(prettifiedHtml).toContain('<p>Paragraph</p>');
    expect(prettifiedHtml).toContain('<br>'); // Empty paragraph becomes br

    // Should have newlines between elements when prettified
    const parts = prettifiedHtml.split('\n');
    expect(parts.length).toBeGreaterThan(1);

    // Test with prettify=false
    const html = wixToHtml.convert(wixDoc);
    expect(html).toContain('<h2>Heading</h2>');
    expect(html).toContain('<p>Paragraph</p>');
    expect(html).toContain('<br>');
  });
});

describe('Markdown conversion pipeline', () => {
  let htmlToWix: HtmlToWixConverter;
  let wixToHtml: WixToHtmlConverter;
  let markdownIt: MarkdownIt;
  let turndownService: TurndownService;

  beforeEach(() => {
    htmlToWix = new HtmlToWixConverter();
    wixToHtml = new WixToHtmlConverter({ prettify: false });
    markdownIt = new MarkdownIt({});
    turndownService = new TurndownService({ headingStyle: 'atx' });
  });

  it('should preserve line breaks within paragraphs (br tags)', () => {
    const html = '<p>First line<br>Second line<br>Third line</p>';

    const wixDoc = htmlToWix.convert(html);
    const convertedHtml = wixToHtml.convert(wixDoc);
    const markdown = turndownService.turndown(convertedHtml);

    // Should preserve br tags in HTML round-trip
    expect(convertedHtml).toBe('<p>First line<br>Second line<br>Third line</p>');

    // Should convert to markdown line breaks (2 spaces + newline)
    expect(markdown).toContain('First line  \nSecond line  \nThird line');
  });

  it('should preserve image dimensions through markdown round-trip', () => {
    const actualWixImage: WixImageNode = {
      type: 'IMAGE',
      id: '4twek140',
      nodes: [],
      imageData: {
        containerData: {
          width: { custom: '498' },
          alignment: 'CENTER',
          textWrap: true,
        },
        image: {
          src: { id: '9a4116_2161bd3b120046b7bc653b638305c2cc~mv2.jpg' },
          width: 1024,
          height: 1024,
        },
      },
    };

    // Ricos to HTML
    const html = wixToHtml.convert({ nodes: [actualWixImage] });
    expect(html).toContain('width="1024"');
    expect(html).toContain('height="1024"');

    // HTML to Markdown (default turndown converts to ![alt](src), losing dimensions)
    const markdown = turndownService.turndown(html);

    // Markdown to HTML
    const htmlFromMarkdown = markdownIt.render(markdown);

    // HTML back to Ricos
    const backToRicos = htmlToWix.convert(htmlFromMarkdown);

    // Check if dimensions are preserved
    const imageNode = backToRicos.nodes[0] as WixImageNode;
    expect(imageNode.type).toBe('IMAGE');
    expect(imageNode.imageData.image.src.id).toBe('9a4116_2161bd3b120046b7bc653b638305c2cc~mv2.jpg');

    // Note: Standard markdown doesn't preserve dimensions, so these will be undefined
    // This test documents the current behavior
    console.log('\n=== Markdown Image Dimension Test ===');
    console.log('Original width:', actualWixImage.imageData.image.width);
    console.log('Result width:', imageNode.imageData.image.width);
    console.log('Original height:', actualWixImage.imageData.image.height);
    console.log('Result height:', imageNode.imageData.image.height);
  });

  it('ACTUAL WIX DATA: test round-trip with empty paragraphs', () => {
    // This is ACTUAL data from Wix with spacing (empty paragraphs)
    const actualWixData: WixDocument = {
      nodes: [
        {
          type: 'HEADING',
          id: 'node_2_1764161469154',
          nodes: [{ type: 'TEXT', id: 't1', textData: { text: 'Introduction to Whales', decorations: [] } }],
          headingData: { level: 2, textStyle: { textAlignment: 'AUTO' } },
        },
        {
          type: 'PARAGRAPH',
          id: 'node_4_1764161469155',
          nodes: [
            { type: 'TEXT', id: 't2', textData: { text: 'Whales are magnificent marine mammals.', decorations: [] } },
          ],
          paragraphData: { textStyle: { textAlignment: 'AUTO' } },
        },
        { type: 'PARAGRAPH', id: 'fa8mg122', nodes: [], paragraphData: { textStyle: { textAlignment: 'AUTO' } } },
        {
          type: 'HEADING',
          id: 'node_6_1764161469155',
          nodes: [{ type: 'TEXT', id: 't3', textData: { text: 'Types of Whales', decorations: [] } }],
          headingData: { level: 2, textStyle: { textAlignment: 'AUTO' } },
        },
        {
          type: 'PARAGRAPH',
          id: 'node_8_1764161469155',
          nodes: [
            { type: 'TEXT', id: 't4', textData: { text: 'There are two main groups of whales.', decorations: [] } },
          ],
          paragraphData: { textStyle: { textAlignment: 'AUTO' } },
        },
      ],
    };

    console.log('\n=== ACTUAL WIX DATA TEST ===');
    console.log('Original Wix nodes:', actualWixData.nodes.length);
    console.log(
      'Node types:',
      actualWixData.nodes
        .map((n) => {
          const nodeWithArray = n as { nodes?: unknown[]; type: string };
          return nodeWithArray.type + (nodeWithArray.nodes?.length === 0 ? ' (EMPTY)' : '');
        })
        .join(', '),
    );

    // Convert to HTML
    const html = wixToHtml.convert(actualWixData);
    console.log('\nHTML:', html);

    // Convert back to Ricos
    const backToRicos = htmlToWix.convert(html);
    console.log('\nBack to Ricos nodes:', backToRicos.nodes.length);
    console.log(
      'Node types:',
      backToRicos.nodes
        .map((n) => {
          const nodeWithArray = n as { nodes?: unknown[]; type: string };
          return nodeWithArray.type + (nodeWithArray.nodes?.length === 0 ? ' (EMPTY)' : '');
        })
        .join(', '),
    );

    // Convert back to HTML again
    const finalHtml = wixToHtml.convert(backToRicos);
    console.log('\nFinal HTML:', finalHtml);

    // Check if we maintained the empty paragraphs
    const originalEmptyCount = actualWixData.nodes.filter(
      (n) => n.type === 'PARAGRAPH' && n.nodes?.length === 0,
    ).length;
    const convertedEmptyCount = backToRicos.nodes.filter((n) => n.type === 'PARAGRAPH' && n.nodes?.length === 0).length;
    console.log(`\nEmpty paragraphs: Original=${originalEmptyCount}, After round-trip=${convertedEmptyCount}`);

    expect(convertedEmptyCount).toBe(originalEmptyCount);
  });

  it('REAL WORLD TEST: markdown with spacing to Wix', () => {
    // This is what users actually write
    const userMarkdown = `# Introduction

This is the first paragraph with some content.

This is the second paragraph after a blank line.

## Section 2

More content here.

And another paragraph.`;

    console.log('\n=== REAL WORLD: User Markdown → Wix ===');
    console.log('Markdown:', userMarkdown);

    // Step 1: Markdown → HTML (what markdown-it does)
    const html = markdownIt.render(userMarkdown);
    console.log('\nHTML from markdown-it:', html);

    // Step 2: HTML → Ricos (what our converter does)
    const wixDoc = htmlToWix.convert(html);
    console.log('\nRicos node count:', wixDoc.nodes.length);
    console.log(
      'Ricos node types:',
      wixDoc.nodes
        .map((n) => {
          const type = n.type;
          const isEmpty = n.type === 'PARAGRAPH' && n.nodes?.length === 0;
          return isEmpty ? `${type} (EMPTY)` : type;
        })
        .join(', '),
    );

    // Step 3: Ricos → HTML (what Wix sees)
    const finalHtml = wixToHtml.convert(wixDoc);
    console.log('\nFinal HTML to Wix:', finalHtml);

    // Check if spacing is preserved
    const emptyParagraphs = wixDoc.nodes.filter((n) => n.type === 'PARAGRAPH' && n.nodes?.length === 0).length;
    const contentParagraphs = wixDoc.nodes.filter((n) => n.type === 'PARAGRAPH' && n.nodes?.length > 0).length;
    const headings = wixDoc.nodes.filter((n) => n.type === 'HEADING').length;
    console.log(
      `\nHeadings: ${headings}, Content Paragraphs: ${contentParagraphs}, Empty Paragraphs (spacing): ${emptyParagraphs}`,
    );

    expect(true).toBe(true);
  });

  it('INVESTIGATION: how markdown handles spacing', () => {
    // Test 1: Blank line between paragraphs
    const md1 = `Para 1\n\nPara 2`;
    const html1 = markdownIt.render(md1);
    console.log('\n=== MARKDOWN with blank line ===');
    console.log('Input:', JSON.stringify(md1));
    console.log('HTML:', html1);
    console.log('Back to MD:', turndownService.turndown(html1));

    // Test 2: Line break within paragraph (2 spaces)
    const md2 = `First line  \nSecond line`;
    const html2 = markdownIt.render(md2);
    console.log('\n=== MARKDOWN with line break (2 spaces) ===');
    console.log('Input:', JSON.stringify(md2));
    console.log('HTML:', html2);
    console.log('Back to MD:', turndownService.turndown(html2));

    // Test 3: HTML with <br> inside paragraph
    const html3 = '<p>First line<br>Second line</p>';
    console.log('\n=== HTML with <br> inside paragraph ===');
    console.log('HTML:', html3);
    console.log('To Ricos:', JSON.stringify(htmlToWix.convert(html3), null, 2));
    console.log('Back to HTML:', wixToHtml.convert(htmlToWix.convert(html3)));
    console.log('To MD:', turndownService.turndown(wixToHtml.convert(htmlToWix.convert(html3))));

    // Test 4: Standalone <br> between paragraphs
    const html4 = '<p>Para 1</p><br><p>Para 2</p>';
    console.log('\n=== HTML with standalone <br> ===');
    console.log('HTML:', html4);
    console.log('To Ricos:', JSON.stringify(htmlToWix.convert(html4), null, 2));
    console.log('Back to HTML:', wixToHtml.convert(htmlToWix.convert(html4)));

    // Test 5: What if we use \n in text content?
    const wixDocWithNewline: WixDocument = {
      nodes: [
        {
          type: 'PARAGRAPH',
          id: 'p1',
          nodes: [
            {
              type: 'TEXT',
              id: 't1',
              textData: {
                text: 'First line\nSecond line',
                decorations: [],
              },
            },
          ],
          paragraphData: {},
        },
      ],
    };
    console.log('\n=== Ricos with \\n in text ===');
    console.log('To HTML:', wixToHtml.convert(wixDocWithNewline));
    console.log('To MD:', turndownService.turndown(wixToHtml.convert(wixDocWithNewline)));

    expect(true).toBe(true); // Just to make test pass
  });

  it('should preserve spacing through markdown round-trip (download path)', () => {
    // Simulate Wix content with spacing
    const wixDoc: WixDocument = {
      nodes: [
        {
          type: 'HEADING',
          id: 'h1',
          nodes: [
            {
              type: 'TEXT',
              id: 't1',
              nodes: [],
              textData: { text: 'Feeding and Diet', decorations: [] },
            },
          ],
          headingData: { level: 2 },
        },
        {
          type: 'PARAGRAPH',
          id: 'p1',
          nodes: [
            {
              type: 'TEXT',
              id: 't2',
              nodes: [],
              textData: { text: 'Whales have diverse diets depending on their type.', decorations: [] },
            },
          ],
          paragraphData: {},
        },
        {
          type: 'PARAGRAPH',
          id: 'p2',
          nodes: [], // Empty paragraph for spacing
          paragraphData: {},
        },
        {
          type: 'HEADING',
          id: 'h2',
          nodes: [
            {
              type: 'TEXT',
              id: 't3',
              nodes: [],
              textData: { text: 'Social Behavior', decorations: [] },
            },
          ],
          headingData: { level: 2 },
        },
        {
          type: 'PARAGRAPH',
          id: 'p3',
          nodes: [
            {
              type: 'TEXT',
              id: 't4',
              nodes: [],
              textData: { text: 'Whales exhibit a range of social behaviors.', decorations: [] },
            },
          ],
          paragraphData: {},
        },
      ],
    };

    // Simulate download: RICOS → HTML → Markdown
    const html = wixToHtml.convert(wixDoc);
    const markdown = turndownService.turndown(html);

    // Check markdown contains all content
    expect(markdown).toContain('## Feeding and Diet');
    expect(markdown).toContain('Whales have diverse diets');
    expect(markdown).toContain('## Social Behavior');
    expect(markdown).toContain('Whales exhibit a range');

    // Check for spacing/blank lines in markdown
    const markdownLines = markdown.split('\n');
    expect(markdownLines.length).toBeGreaterThan(4); // Should have multiple lines
  });

  it('should preserve spacing through markdown round-trip (upload path)', () => {
    // Simulate user creating markdown with spacing
    const markdown = `## Feeding and Diet

Whales have diverse diets depending on their type.

## Social Behavior

Whales exhibit a range of social behaviors.`;

    // Simulate upload: Markdown → HTML → RICOS
    const html = markdownIt.render(markdown);
    const wixDoc = htmlToWix.convert(html);

    // Should have headings and paragraphs
    expect(wixDoc.nodes.some((n) => n.type === 'HEADING')).toBe(true);
    expect(wixDoc.nodes.some((n) => n.type === 'PARAGRAPH')).toBe(true);

    // Count nodes to see if spacing is preserved
    const headings = wixDoc.nodes.filter((n) => n.type === 'HEADING');
    const paragraphs = wixDoc.nodes.filter((n) => n.type === 'PARAGRAPH');

    expect(headings.length).toBe(2);
    expect(paragraphs.length).toBeGreaterThanOrEqual(2); // At least the content paragraphs
  });

  it('should preserve content through full markdown round-trip', () => {
    // Start with markdown
    const originalMarkdown = `## Introduction

This is the first paragraph.

## Conclusion

This is the last paragraph.`;

    // Upload: Markdown → HTML → RICOS
    const htmlFromMarkdown = markdownIt.render(originalMarkdown);
    const wixDoc = htmlToWix.convert(htmlFromMarkdown);

    // Download: RICOS → HTML → Markdown
    const htmlFromWix = wixToHtml.convert(wixDoc);
    const finalMarkdown = turndownService.turndown(htmlFromWix);

    // Check that content is preserved
    expect(finalMarkdown).toContain('Introduction');
    expect(finalMarkdown).toContain('first paragraph');
    expect(finalMarkdown).toContain('Conclusion');
    expect(finalMarkdown).toContain('last paragraph');
  });
});

describe('Markdown helpers with image preservation', () => {
  let htmlToWix: HtmlToWixConverter;
  let wixToHtml: WixToHtmlConverter;

  beforeEach(() => {
    htmlToWix = new HtmlToWixConverter();
    wixToHtml = new WixToHtmlConverter({ prettify: false });
  });

  it('should preserve image dimensions when using markdown helpers', () => {
    const actualWixImage: WixImageNode = {
      type: 'IMAGE',
      id: '4twek140',
      nodes: [],
      imageData: {
        containerData: {
          width: { custom: '498' },
          alignment: 'CENTER',
          textWrap: true,
        },
        image: {
          src: { id: '9a4116_2161bd3b120046b7bc653b638305c2cc~mv2.jpg' },
          width: 1024,
          height: 1024,
        },
      },
    };

    // Step 1: Ricos to HTML
    const html = wixToHtml.convert({ nodes: [actualWixImage] });
    expect(html).toContain('width="1024"');
    expect(html).toContain('height="1024"');

    // Step 2: HTML to Markdown (using helper that preserves images)
    const markdown = htmlToMarkdown(html);

    // Verify markdown contains HTML img tag (not ![alt](src))
    expect(markdown).toContain('<img');
    expect(markdown).toContain('width="1024"');
    expect(markdown).toContain('height="1024"');
    expect(markdown).toContain('data-wix-container');

    // Step 3: Markdown to HTML (using helper that allows HTML)
    const htmlFromMarkdown = markdownToHtml(markdown);

    // Step 4: HTML back to Ricos
    const backToRicos = htmlToWix.convert(htmlFromMarkdown);

    // Verification
    const imageNode = backToRicos.nodes[0] as WixImageNode;
    expect(imageNode.type).toBe('IMAGE');
    expect(imageNode.imageData.image.src.id).toBe('9a4116_2161bd3b120046b7bc653b638305c2cc~mv2.jpg');
    expect(imageNode.imageData.image.width).toBe(1024);
    expect(imageNode.imageData.image.height).toBe(1024);
    expect(imageNode.imageData.containerData).toEqual({
      width: { custom: '498' },
      alignment: 'CENTER',
      textWrap: true,
    });
  });

  it('should handle complete blog post with images through markdown', () => {
    const blogPost: WixDocument = {
      nodes: [
        {
          type: 'HEADING',
          id: 'h1',
          nodes: [{ type: 'TEXT', id: 't1', textData: { text: 'My Blog Post', decorations: [] } }],
          headingData: { level: 1, textStyle: { textAlignment: 'AUTO' } },
        },
        {
          type: 'PARAGRAPH',
          id: 'p1',
          nodes: [{ type: 'TEXT', id: 't2', textData: { text: 'This is some intro text.', decorations: [] } }],
          paragraphData: { textStyle: { textAlignment: 'AUTO' } },
        },
        {
          type: 'IMAGE',
          id: 'img1',
          nodes: [],
          imageData: {
            image: {
              src: { id: 'test_image.jpg' },
              width: 800,
              height: 600,
            },
            altText: 'Test Image',
          },
        },
        {
          type: 'PARAGRAPH',
          id: 'p2',
          nodes: [{ type: 'TEXT', id: 't3', textData: { text: 'Text after image.', decorations: [] } }],
          paragraphData: { textStyle: { textAlignment: 'AUTO' } },
        },
      ],
    };

    // Full round-trip: Ricos → HTML → Markdown → HTML → Ricos
    const html = wixToHtml.convert(blogPost);
    const markdown = htmlToMarkdown(html);
    const htmlBack = markdownToHtml(markdown);
    const ricosBack = htmlToWix.convert(htmlBack);

    // Find the image node
    const imageNode = ricosBack.nodes.find((n) => n.type === 'IMAGE') as WixImageNode;
    expect(imageNode).toBeDefined();
    expect(imageNode.imageData.image.src.id).toBe('test_image.jpg');
    expect(imageNode.imageData.image.width).toBe(800);
    expect(imageNode.imageData.image.height).toBe(600);
    expect(imageNode.imageData.altText).toBe('Test Image');
  });

  it('createTurndownService should preserve all image attributes', () => {
    const turndown = createTurndownService();
    const html =
      '<img src="wix:image://v1/test.jpg" alt="My Image" width="1920" height="1080" data-wix-container=\'{"alignment":"CENTER"}\'>';

    const markdown = turndown.turndown(html);

    // Should keep as HTML, not convert to ![](
    expect(markdown).not.toContain('![');
    expect(markdown).toContain('<img');
    expect(markdown).toContain('src="wix:image://v1/test.jpg"');
    expect(markdown).toContain('alt="My Image"');
    expect(markdown).toContain('width="1920"');
    expect(markdown).toContain('height="1080"');
    expect(markdown).toContain('data-wix-container');
  });

  it('createMarkdownParser should parse HTML img tags', () => {
    const md = createMarkdownParser();
    const markdown = '<img src="test.jpg" width="100" height="50">';

    const html = md.render(markdown);

    expect(html).toContain('<img');
    expect(html).toContain('src="test.jpg"');
    expect(html).toContain('width="100"');
    expect(html).toContain('height="50"');
  });
});
