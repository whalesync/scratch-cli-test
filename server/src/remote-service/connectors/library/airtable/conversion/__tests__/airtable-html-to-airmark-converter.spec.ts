import { escapeHtml, replaceNewlines } from '../airmark-utils';
import { airMarkToHtml } from '../airtable-airmark-to-html-converter';
import {
  AirmarkConversionError,
  Pass1HtmlNode,
  Pass2HtmlNode,
  Pass3HtmlNode,
  Pass4Subtrees,
  Pass5Sections,
  htmlToAirMark,
  pass1,
  pass2,
  pass3,
  pass4,
  pass5,
  pass6,
  pass7,
} from '../airtable-html-to-airmark-converter';

function expectString(value: unknown): string {
  expect(typeof value).toBe('string');
  return value as string;
}

function plainTextToHtml(plainText: string): string {
  return replaceNewlines(escapeHtml(plainText), '<br>');
}

function htmlToPlainText(html: string): string {
  // Simple implementation for the round-trip test
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#8203;/g, '')
    .replace(/&nbsp;/g, ' ');
}

//#region ------- test helpers -----------

function clearParseIds(pass1Node: Pass1HtmlNode): Pass1HtmlNode {
  pass1Node.parseId = '';
  if (pass1Node.type === 'tag') {
    pass1Node.children.forEach((n) => clearParseIds(n));
  }
  return pass1Node;
}

function clearParents(pass2Node: Pass2HtmlNode): Pass2HtmlNode {
  pass2Node.parent = null;
  if (pass2Node.type === 'tag') {
    pass2Node.children.forEach((n) => clearParents(n));
  }
  return pass2Node;
}

//#endregion ------- test helpers -----------

describe('HtmlToAirMarkConverter', () => {
  it('pass 1', async () => {
    const html = '<p>Something</p>';
    const result = await pass1(html);

    if (result instanceof AirmarkConversionError) {
      throw new Error('Pass 1 of HTML conversion failed');
    }

    // We expect the result to be a `<body>` tag with a child `<p>` tag with a child `Something` text element.
    expect(result).toHaveProperty('type');
    expect(result.type).toEqual('tag');

    const uuidv4RegEx = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(result.parseId).toMatch(uuidv4RegEx);

    clearParseIds(result);
    const expected: Pass1HtmlNode = {
      type: 'tag',
      parseId: '',
      tagName: 'body',
      attributes: {},
      children: [
        {
          type: 'tag',
          parseId: '',
          tagName: 'p',
          attributes: {},
          children: [
            {
              type: 'text',
              parseId: '',
              value: 'Something',
            },
          ],
        },
      ],
    };
    expect(result).toEqual(expected);
  });

  it('pass 2', async () => {
    const html = `
      <p>Something</p>
      <div>
        <ul>
          <li>
            <ul>
              <li></li>
            </ul>
          </li>
        </ul>
      </div>
      <ul>
        <li>Hi
          <ul>
            <li></li>
          </ul>
        </li>
      </ul>`;
    const result1 = await pass1(html);
    if (result1 instanceof AirmarkConversionError) {
      throw new Error('Pass 1 of HTML conversion failed');
    }

    const result2 = pass2(result1).result;
    clearParseIds(result2);
    clearParents(result2);
    const expected: Pass2HtmlNode = {
      type: 'tag',
      parseId: '',
      tagName: 'body',
      attributes: {},
      displayType: 'structural',
      parent: null,
      index: 0,
      children: [
        {
          type: 'tag',
          parseId: '',
          tagName: 'p',
          attributes: {},
          displayType: 'structural',
          parent: null,
          index: 1,
          children: [
            {
              type: 'text',
              parseId: '',
              value: 'Something',
              displayType: 'visual',
              parent: null,
              index: 2,
            },
          ],
        },
        {
          type: 'tag',
          parseId: '',
          tagName: 'div',
          attributes: {},
          displayType: 'structural',
          parent: null,
          index: 3,
          children: [
            {
              type: 'tag',
              parseId: '',
              tagName: 'ul',
              attributes: {},
              displayType: 'structural',
              parent: null,
              index: 4,
              children: [
                {
                  type: 'tag',
                  parseId: '',
                  tagName: 'li',
                  attributes: {},
                  displayType: 'structural',
                  parent: null,
                  index: 5,
                  children: [
                    {
                      type: 'tag',
                      parseId: '',
                      tagName: 'ul',
                      attributes: {},
                      displayType: 'structural',
                      parent: null,
                      index: 6,
                      children: [
                        {
                          type: 'tag',
                          parseId: '',
                          tagName: 'li',
                          attributes: {},
                          displayType: 'visual',
                          parent: null,
                          index: 7,
                          children: [],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: 'tag',
          parseId: '',
          tagName: 'ul',
          attributes: {},
          displayType: 'structural',
          parent: null,
          index: 8,
          children: [
            {
              type: 'tag',
              parseId: '',
              tagName: 'li',
              attributes: {},
              displayType: 'structural',
              parent: null,
              index: 9,
              children: [
                {
                  type: 'text',
                  parseId: '',
                  value: 'Hi',
                  displayType: 'visual',
                  parent: null,
                  index: 10,
                },
                {
                  type: 'tag',
                  parseId: '',
                  tagName: 'ul',
                  attributes: {},
                  displayType: 'structural',
                  parent: null,
                  index: 11,
                  children: [
                    {
                      type: 'tag',
                      parseId: '',
                      tagName: 'li',
                      attributes: {},
                      displayType: 'visual',
                      parent: null,
                      index: 12,
                      children: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(result2).toEqual(expected);
  });

  it('pass 3', async () => {
    const html = `
      <p>Something <strong><span><span>bold!</span></span></strong></p>
      <div>
        <ul>
          <li>
            <ul>
              <li></li>
            </ul>
          </li>
        </ul>
      </div>
      <ul>
        <li>Hi
          <ul>
            <li></li>
          </ul>
        </li>
      </ul>
      <div>
        This is
        <div></div>
        some broken up text.
      </div>`;
    const result1 = await pass1(html);
    if (result1 instanceof AirmarkConversionError) {
      throw new Error('Pass 1 of HTML conversion failed');
    }

    const result2 = pass2(result1);
    const result3 = pass3(result2);
    clearParseIds(result3);
    clearParents(result3);
    const expected: Pass3HtmlNode = {
      type: 'tag',
      parseId: '',
      tagName: 'body',
      attributes: {},
      parent: null,
      index: 0,
      displayType: 'structural',
      renderType: 'continue_section',
      children: [
        {
          type: 'tag',
          parseId: '',
          tagName: 'p',
          attributes: {},
          parent: null,
          index: 1,
          displayType: 'structural',
          renderType: 'continue_section',
          children: [
            {
              type: 'text',
              value: 'Something ',
              parseId: '',
              parent: null,
              index: 2,
              displayType: 'visual',
              renderType: 'starts_new_section',
            },
            {
              type: 'tag',
              parseId: '',
              tagName: 'strong',
              attributes: {},
              parent: null,
              index: 3,
              displayType: 'structural',
              renderType: 'continue_section',
              children: [
                {
                  type: 'tag',
                  parseId: '',
                  tagName: 'span',
                  attributes: {},
                  parent: null,
                  index: 4,
                  displayType: 'structural',
                  renderType: 'continue_section',
                  children: [
                    {
                      type: 'tag',
                      parseId: '',
                      tagName: 'span',
                      attributes: {},
                      parent: null,
                      index: 5,
                      displayType: 'structural',
                      renderType: 'continue_section',
                      children: [
                        {
                          type: 'text',
                          value: 'bold!',
                          parseId: '',
                          parent: null,
                          index: 6,
                          displayType: 'visual',
                          renderType: 'continue_section',
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: 'tag',
          parseId: '',
          tagName: 'div',
          attributes: {},
          parent: null,
          index: 7,
          displayType: 'structural',
          renderType: 'continue_section',
          children: [
            {
              type: 'tag',
              parseId: '',
              tagName: 'ul',
              attributes: {},
              parent: null,
              index: 8,
              displayType: 'structural',
              renderType: 'continue_section',
              children: [
                {
                  type: 'tag',
                  parseId: '',
                  tagName: 'li',
                  attributes: {},
                  parent: null,
                  index: 9,
                  displayType: 'structural',
                  renderType: 'continue_section',
                  children: [
                    {
                      type: 'tag',
                      parseId: '',
                      tagName: 'ul',
                      attributes: {},
                      parent: null,
                      index: 10,
                      displayType: 'structural',
                      renderType: 'continue_section',
                      children: [
                        {
                          type: 'tag',
                          parseId: '',
                          tagName: 'li',
                          attributes: {},
                          parent: null,
                          index: 11,
                          displayType: 'visual',
                          renderType: 'starts_new_section',
                          children: [],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: 'tag',
          parseId: '',
          tagName: 'ul',
          attributes: {},
          parent: null,
          index: 12,
          displayType: 'structural',
          renderType: 'continue_section',
          children: [
            {
              type: 'tag',
              parseId: '',
              tagName: 'li',
              attributes: {},
              parent: null,
              index: 13,
              displayType: 'structural',
              renderType: 'continue_section',
              children: [
                {
                  type: 'text',
                  value: 'Hi',
                  parseId: '',
                  parent: null,
                  index: 14,
                  displayType: 'visual',
                  renderType: 'starts_new_section',
                },
                {
                  type: 'tag',
                  parseId: '',
                  tagName: 'ul',
                  attributes: {},
                  parent: null,
                  index: 15,
                  displayType: 'structural',
                  renderType: 'continue_section',
                  children: [
                    {
                      type: 'tag',
                      parseId: '',
                      tagName: 'li',
                      attributes: {},
                      parent: null,
                      index: 16,
                      displayType: 'visual',
                      renderType: 'starts_new_section',
                      children: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: 'tag',
          parseId: '',
          tagName: 'div',
          attributes: {},
          parent: null,
          index: 17,
          displayType: 'structural',
          renderType: 'continue_section',
          children: [
            {
              type: 'text',
              value: 'This is',
              parseId: '',
              parent: null,
              index: 18,
              displayType: 'visual',
              renderType: 'starts_new_section',
            },
            {
              type: 'tag',
              parseId: '',
              tagName: 'div',
              attributes: {},
              parent: null,
              index: 19,
              displayType: 'structural',
              renderType: 'continue_section',
              children: [],
            },
            {
              type: 'text',
              value: 'some broken up text.',
              parseId: '',
              parent: null,
              index: 20,
              displayType: 'visual',
              renderType: 'starts_new_section',
            },
          ],
        },
      ],
    };
    expect(result3).toEqual(expected);
  });

  it('pass 4', async () => {
    const html = `
      <p>Something <strong><span><span>bold!</span></span></strong></p>
      <div>
        <ul>
          <li>
            <ul>
              <li></li>
            </ul>
          </li>
        </ul>
      </div>
      <ul>
        <li>Hi
          <ul>
            <li></li>
          </ul>
        </li>
      </ul>
      <div>
        This is
        <div></div>
        some broken up text.
      </div>`;
    const result1 = await pass1(html);
    if (result1 instanceof AirmarkConversionError) {
      throw new Error('Pass 1 of HTML conversion failed');
    }

    const result2 = pass2(result1);
    const result3 = pass3(result2);
    const result4 = pass4(result3);
    result4.subtrees.forEach((n) => clearParseIds(n));

    const expected: Pass4Subtrees = {
      subtrees: [
        {
          type: 'tag',
          parseId: '',
          tagName: 'body',
          attributes: {},
          index: 0,
          displayType: 'structural',
          renderType: 'continue_section',
          children: [
            {
              type: 'tag',
              parseId: '',
              tagName: 'p',
              attributes: {},
              index: 1,
              displayType: 'structural',
              renderType: 'continue_section',
              children: [
                {
                  type: 'text',
                  parseId: '',
                  index: 2,
                  displayType: 'visual',
                  renderType: 'starts_new_section',
                  value: 'Something ',
                  parentIndex: 1,
                },
                {
                  type: 'tag',
                  parseId: '',
                  tagName: 'strong',
                  attributes: {},
                  index: 3,
                  displayType: 'structural',
                  renderType: 'continue_section',
                  children: [
                    {
                      type: 'tag',
                      parseId: '',
                      tagName: 'span',
                      attributes: {},
                      index: 4,
                      displayType: 'structural',
                      renderType: 'continue_section',
                      children: [
                        {
                          type: 'tag',
                          parseId: '',
                          tagName: 'span',
                          attributes: {},
                          index: 5,
                          displayType: 'structural',
                          renderType: 'continue_section',
                          children: [
                            {
                              type: 'text',
                              parseId: '',
                              index: 6,
                              displayType: 'visual',
                              renderType: 'continue_section',
                              value: 'bold!',
                              parentIndex: 5,
                            },
                          ],
                          parentIndex: 4,
                        },
                      ],
                      parentIndex: 3,
                    },
                  ],
                  parentIndex: 1,
                },
              ],
              parentIndex: 0,
            },
          ],
          parentIndex: null,
        },
        {
          type: 'tag',
          parseId: '',
          tagName: 'body',
          attributes: {},
          index: 0,
          displayType: 'structural',
          renderType: 'continue_section',
          children: [
            {
              type: 'tag',
              parseId: '',
              tagName: 'div',
              attributes: {},
              index: 7,
              displayType: 'structural',
              renderType: 'continue_section',
              children: [
                {
                  type: 'tag',
                  parseId: '',
                  tagName: 'ul',
                  attributes: {},
                  index: 8,
                  displayType: 'structural',
                  renderType: 'continue_section',
                  children: [
                    {
                      type: 'tag',
                      parseId: '',
                      tagName: 'li',
                      attributes: {},
                      index: 9,
                      displayType: 'structural',
                      renderType: 'continue_section',
                      children: [
                        {
                          type: 'tag',
                          parseId: '',
                          tagName: 'ul',
                          attributes: {},
                          index: 10,
                          displayType: 'structural',
                          renderType: 'continue_section',
                          children: [
                            {
                              type: 'tag',
                              parseId: '',
                              tagName: 'li',
                              attributes: {},
                              index: 11,
                              displayType: 'visual',
                              renderType: 'starts_new_section',
                              children: [],
                              parentIndex: 10,
                            },
                          ],
                          parentIndex: 9,
                        },
                      ],
                      parentIndex: 8,
                    },
                  ],
                  parentIndex: 7,
                },
              ],
              parentIndex: 0,
            },
          ],
          parentIndex: null,
        },
        {
          type: 'tag',
          parseId: '',
          tagName: 'body',
          attributes: {},
          index: 0,
          displayType: 'structural',
          renderType: 'continue_section',
          children: [
            {
              type: 'tag',
              parseId: '',
              tagName: 'ul',
              attributes: {},
              index: 12,
              displayType: 'structural',
              renderType: 'continue_section',
              children: [
                {
                  type: 'tag',
                  parseId: '',
                  tagName: 'li',
                  attributes: {},
                  index: 13,
                  displayType: 'structural',
                  renderType: 'continue_section',
                  children: [
                    {
                      type: 'text',
                      parseId: '',
                      index: 14,
                      displayType: 'visual',
                      renderType: 'starts_new_section',
                      value: 'Hi',
                      parentIndex: 13,
                    },
                  ],
                  parentIndex: 12,
                },
              ],
              parentIndex: 0,
            },
          ],
          parentIndex: null,
        },
        {
          type: 'tag',
          parseId: '',
          tagName: 'body',
          attributes: {},
          index: 0,
          displayType: 'structural',
          renderType: 'continue_section',
          children: [
            {
              type: 'tag',
              parseId: '',
              tagName: 'ul',
              attributes: {},
              index: 12,
              displayType: 'structural',
              renderType: 'continue_section',
              children: [
                {
                  type: 'tag',
                  parseId: '',
                  tagName: 'li',
                  attributes: {},
                  index: 13,
                  displayType: 'structural',
                  renderType: 'continue_section',
                  children: [
                    {
                      type: 'tag',
                      parseId: '',
                      tagName: 'ul',
                      attributes: {},
                      index: 15,
                      displayType: 'structural',
                      renderType: 'continue_section',
                      children: [
                        {
                          type: 'tag',
                          parseId: '',
                          tagName: 'li',
                          attributes: {},
                          index: 16,
                          displayType: 'visual',
                          renderType: 'starts_new_section',
                          children: [],
                          parentIndex: 15,
                        },
                      ],
                      parentIndex: 13,
                    },
                  ],
                  parentIndex: 12,
                },
              ],
              parentIndex: 0,
            },
          ],
          parentIndex: null,
        },
        {
          type: 'tag',
          parseId: '',
          tagName: 'body',
          attributes: {},
          index: 0,
          displayType: 'structural',
          renderType: 'continue_section',
          children: [
            {
              type: 'tag',
              parseId: '',
              tagName: 'div',
              attributes: {},
              index: 17,
              displayType: 'structural',
              renderType: 'continue_section',
              children: [
                {
                  type: 'text',
                  parseId: '',
                  index: 18,
                  displayType: 'visual',
                  renderType: 'starts_new_section',
                  value: 'This is',
                  parentIndex: 17,
                },
              ],
              parentIndex: 0,
            },
          ],
          parentIndex: null,
        },
        {
          type: 'tag',
          parseId: '',
          tagName: 'body',
          attributes: {},
          index: 0,
          displayType: 'structural',
          renderType: 'continue_section',
          children: [
            {
              type: 'tag',
              parseId: '',
              tagName: 'div',
              attributes: {},
              index: 17,
              displayType: 'structural',
              renderType: 'continue_section',
              children: [
                {
                  type: 'text',
                  parseId: '',
                  index: 20,
                  displayType: 'visual',
                  renderType: 'starts_new_section',
                  value: 'some broken up text.',
                  parentIndex: 17,
                },
              ],
              parentIndex: 0,
            },
          ],
          parentIndex: null,
        },
      ],
    };

    expect(result4).toEqual(expected);
  });

  it('pass 5', async () => {
    const html = `
      <p>Something <strong><span><span>bold!</span></span></strong></p>
      <div>
        <ul>
          <li>
            <ul>
              <li></li>
            </ul>
          </li>
        </ul>
      </div>
      <ul>
        <li>Hi
          <ul>
            <li><input type="checkbox" checked> I am a checkbox!</li>
          </ul>
        </li>
      </ul>
      <div>
        This is
        <div></div>
        some broken up text.
      </div>
      <pre><code>Some
  code</code></pre>`;
    const result1 = await pass1(html);
    if (result1 instanceof AirmarkConversionError) {
      throw new Error('Pass 1 of HTML conversion failed');
    }

    const result2 = pass2(result1);
    const result3 = pass3(result2);
    const result4 = pass4(result3);
    const result5 = pass5(result4);

    const expected: Pass5Sections = {
      sections: [
        {
          type: { type: 'normal_line' },
          children: [
            {
              type: 'unstyled_tag',
              children: [
                {
                  type: 'unstyled_tag',
                  children: [
                    { type: 'text', value: 'Something ' },
                    {
                      type: 'bold',
                      children: [
                        {
                          type: 'unstyled_tag',
                          children: [{ type: 'unstyled_tag', children: [{ type: 'text', value: 'bold!' }] }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: { type: 'ul_item', level: 2 },
          children: [
            {
              type: 'unstyled_tag',
              children: [
                {
                  type: 'unstyled_tag',
                  children: [
                    {
                      type: 'unstyled_tag',
                      children: [
                        {
                          type: 'unstyled_tag',
                          children: [{ type: 'unstyled_tag', children: [{ type: 'unstyled_tag', children: [] }] }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: { type: 'ul_item', level: 1 },
          children: [
            {
              type: 'unstyled_tag',
              children: [
                {
                  type: 'unstyled_tag',
                  children: [{ type: 'unstyled_tag', children: [{ type: 'text', value: 'Hi' }] }],
                },
              ],
            },
          ],
        },
        {
          type: { type: 'cl_item', level: 2, checked: true },
          children: [
            {
              type: 'unstyled_tag',
              children: [
                {
                  type: 'unstyled_tag',
                  children: [
                    {
                      type: 'unstyled_tag',
                      children: [
                        {
                          type: 'unstyled_tag',
                          children: [
                            {
                              type: 'unstyled_tag',
                              children: [
                                { type: 'unstyled_tag', children: [] },
                                { type: 'text', value: ' I am a checkbox!' },
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: { type: 'normal_line' },
          children: [
            {
              type: 'unstyled_tag',
              children: [{ type: 'unstyled_tag', children: [{ type: 'text', value: 'This is' }] }],
            },
          ],
        },
        {
          type: { type: 'normal_line' },
          children: [
            {
              type: 'unstyled_tag',
              children: [{ type: 'unstyled_tag', children: [{ type: 'text', value: 'some broken up text.' }] }],
            },
          ],
        },
        {
          type: { type: 'code_block' },
          children: [
            {
              type: 'unstyled_tag',
              children: [
                {
                  type: 'unstyled_tag',
                  children: [
                    {
                      type: 'code',
                      children: [
                        {
                          type: 'unstyled_tag',
                          children: [
                            { type: 'text', value: 'Some' },
                            { type: 'hard_break' },
                            { type: 'text', value: '  code' },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    expect(result5).toEqual(expected);
  });

  it('pass 6', async () => {
    const html = `
    <p>Something <strong><span><span>bold!</span></span></strong></p>
    <div>
      <ul>
        <li>
          <ul>
            <li></li>
          </ul>
        </li>
      </ul>
    </div>
    <ul>
      <li>Hi
        <ul>
          <li><input type="checkbox" checked> I am a checkbox!</li>
        </ul>
      </li>
    </ul>
    <div>
      This is
      <div></div>
      some broken up text.
    </div>
    <pre><code>Some
code</code></pre>`;

    const expected = {
      children: [
        {
          type: 'normal_line',
          children: [
            {
              type: 'unstyled_tag',
              children: [
                {
                  type: 'unstyled_tag',
                  children: [
                    {
                      type: 'text',
                      value: 'Something ',
                    },
                    {
                      type: 'bold',
                      children: [
                        {
                          type: 'unstyled_tag',
                          children: [
                            {
                              type: 'unstyled_tag',
                              children: [
                                {
                                  type: 'text',
                                  value: 'bold!',
                                },
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: 'ul_item',
          level: 2,
          children: [
            {
              type: 'unstyled_tag',
              children: [
                {
                  type: 'unstyled_tag',
                  children: [
                    {
                      type: 'unstyled_tag',
                      children: [
                        {
                          type: 'unstyled_tag',
                          children: [
                            {
                              type: 'unstyled_tag',
                              children: [
                                {
                                  type: 'unstyled_tag',
                                  children: [],
                                },
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: 'ul_item',
          level: 1,
          children: [
            {
              type: 'unstyled_tag',
              children: [
                {
                  type: 'unstyled_tag',
                  children: [
                    {
                      type: 'unstyled_tag',
                      children: [
                        {
                          type: 'text',
                          value: 'Hi',
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: 'cl_item',
          level: 2,
          checked: true,
          children: [
            {
              type: 'unstyled_tag',
              children: [
                {
                  type: 'unstyled_tag',
                  children: [
                    {
                      type: 'unstyled_tag',
                      children: [
                        {
                          type: 'unstyled_tag',
                          children: [
                            {
                              type: 'unstyled_tag',
                              children: [
                                {
                                  type: 'unstyled_tag',
                                  children: [],
                                },
                                {
                                  type: 'text',
                                  value: ' I am a checkbox!',
                                },
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: 'normal_line',
          children: [
            {
              type: 'unstyled_tag',
              children: [
                {
                  type: 'unstyled_tag',
                  children: [
                    {
                      type: 'text',
                      value: 'This is',
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: 'normal_line',
          children: [
            {
              type: 'unstyled_tag',
              children: [
                {
                  type: 'unstyled_tag',
                  children: [
                    {
                      type: 'text',
                      value: 'some broken up text.',
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: 'code_block',
          children: [
            {
              type: 'unstyled_tag',
              children: [
                {
                  type: 'unstyled_tag',
                  children: [
                    {
                      type: 'unstyled_tag',
                      children: [
                        {
                          type: 'unstyled_tag',
                          children: [
                            {
                              type: 'text',
                              value: 'Some',
                            },
                            {
                              type: 'text',
                              value: '\n',
                            },
                            {
                              type: 'text',
                              value: 'code',
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const result1 = await pass1(html);
    if (result1 instanceof AirmarkConversionError) {
      throw new Error('Pass 1 of HTML conversion failed');
    }

    const result2 = pass2(result1);
    const result3 = pass3(result2);
    const result4 = pass4(result3);
    const result5 = pass5(result4);
    const result6 = pass6(result5);
    expect(result6).toEqual(expected);
  });

  it('pass 7', async () => {
    const html = `
    <p>Something <strong><span><span>bold!</span></span></strong></p>
    <div>
      <ul>
        <li>
          <ul>
            <li></li>
          </ul>
        </li>
      </ul>
    </div>
    <ul>
      <li>Hi
        <ul>
          <li><input type="checkbox" checked> I am a checkbox!</li>
        </ul>
      </li>
    </ul>
    <div>
      This is
      <div></div>
      some broken up text.
    </div>
    <pre><code>Some
code</code></pre>`;
    const result1 = await pass1(html);
    if (result1 instanceof AirmarkConversionError) {
      throw new Error('Pass 1 of HTML conversion failed');
    }

    const result2 = pass2(result1);
    const result3 = pass3(result2);
    const result4 = pass4(result3);
    const result5 = pass5(result4);
    const result6 = pass6(result5);
    const result7 = pass7(result6);
    const expected = [
      'Something **bold!**',
      '    - ',
      '- Hi',
      '    [x] I am a checkbox!',
      'This is',
      'some broken up text.',
      '```',
      'Some',
      'code',
      '```',
    ].join('\n');
    expect(result7).toEqual(expected);
  });

  it('HTML to AirMark: code block', async () => {
    const html = '<pre><code>function helloWorld() {\n  console.log("Hello World");\n}</code><pre>';
    const expected = '```\nfunction helloWorld() {\n  console.log("Hello World");\n}\n```';
    const result = await htmlToAirMark(html);
    expect(result).toEqual(expected);
  });

  it('HTML to AirMark: bold', async () => {
    const html = '<strong>This is bold</strong>';
    const expected = '**This is bold**';
    const result = await htmlToAirMark(html);
    expect(result).toEqual(expected);
  });

  it('HTML to AirMark: code', async () => {
    const html = '<code>This is code</code>';
    const expected = '`This is code`';
    const result = await htmlToAirMark(html);
    expect(result).toEqual(expected);
  });

  it('HTML to AirMark: code with a backtick', async () => {
    const html = '<code>This is code &grave; with one backtick</code>';
    const expected = '``This is code ` with one backtick``';
    const result = await htmlToAirMark(html);
    expect(result).toEqual(expected);
  });

  it('HTML to AirMark: code with two backticks', async () => {
    const html = '<code>This is code &grave;&grave; with two backticks</code>';
    const expected = '`This is code `` with two backticks`';
    const result = await htmlToAirMark(html);
    expect(result).toEqual(expected);
  });

  it('HTML to AirMark: italic', async () => {
    const html = '<em>This is italic</em>';
    const expected = '_This is italic_';
    const result = await htmlToAirMark(html);
    expect(result).toEqual(expected);
  });

  it('HTML to AirMark: link', async () => {
    const html = '<a href="https://www.whalesync.com">This... is... Whalesync!</a>';
    const expected = '[This... is... Whalesync!](https://www.whalesync.com)';
    const result = await htmlToAirMark(html);
    expect(result).toEqual(expected);
  });

  it('HTML to AirMark: strikethrough', async () => {
    const html = '<del>This is strikethrough</del>';
    const expected = '~~This is strikethrough~~';
    const result = await htmlToAirMark(html);
    expect(result).toEqual(expected);
  });

  it('HTML to AirMark: whitespace within style tag', async () => {
    // Whitespace inside a style tag is moved outside of the tag.
    const html = '<del>&nbsp;This is strikethrough&#9;&#9;&#9;</del>';
    const expected = ' ~~This is strikethrough~~\t\t\t';
    const result = await htmlToAirMark(html);
    expect(result).toEqual(expected);
  });

  it('HTML to AirMark: styles with no contents get stripped', async () => {
    const html = '<del>This is strikethrough</del>. This is <strong></strong>normal.';
    const expected = '~~This is strikethrough~~. This is normal.';
    const result = await htmlToAirMark(html);
    expect(result).toEqual(expected);
  });

  it('HTML to AirMark: styles with only whitespace keep only the whitespace', async () => {
    const html = '<del>This is strikethrough</del>. This is<strong>&nbsp;</strong>normal.';
    const expected = '~~This is strikethrough~~. This is normal.';
    const result = await htmlToAirMark(html);
    expect(result).toEqual(expected);
  });

  it('HTML to AirMark: with `<p>` tags', async () => {
    const html =
      '<h2 id="">Et nulla repellat.</h2><p id="">This came from Webflow and is <strong id=""><em id="">bold n\' italic</em></strong>!</p>';
    const expected = "## Et nulla repellat.\nThis came from Webflow and is **_bold n' italic_**!";
    const result = await htmlToAirMark(html);
    expect(result).toEqual(expected);
  });

  it('HTML to AirMark: mixed styles', async () => {
    const html =
      'Hi! This is <strong>bold</strong>. This is <em>italic</em>. This is <em><code><strong>bold and italic code</strong></code></em>. This is <a href="https://www.whalesync.com"><del>strikethrough inside a link</del></a>.';
    const expected =
      'Hi! This is **bold**. This is _italic_. This is _`**bold and italic code**`_. This is [~~strikethrough inside a link~~](https://www.whalesync.com).';
    const result = await htmlToAirMark(html);
    expect(result).toEqual(expected);
  });

  it('Roundtrip plain text newlines DEV-1674', async () => {
    // There was a bug resulting in duplicated newlines during the interaction of plain text to HTML to AirMark and
    // back. This verifies the fix for it.
    const originalPlainText = 'line1\nline2';
    const asHtml = plainTextToHtml(originalPlainText);
    const asAirmark = await htmlToAirMark(asHtml);
    const backToHtml = await airMarkToHtml(expectString(asAirmark));
    const backToPlain = htmlToPlainText(backToHtml);
    expect(backToPlain).toEqual(originalPlainText);
  });

  it('Non-breaking spaces to normal spaces DEV-1846', async () => {
    // Ensure multiple non-breaking spaces all get replaced correctly.
    const html = `This${String.fromCharCode(160)}is${String.fromCharCode(160)}a${String.fromCharCode(160)}test`;
    const result = await htmlToAirMark(html);
    expect(result).toEqual(`This is a test`);
  });
});
