import {
  airMarkToHtml,
  ListItemLine,
  ListTreeNode,
  richTextLinesToListTree,
} from '../airtable-airmark-to-html-converter';

describe('AirMarkToHTMLConverter', () => {
  it('escape HTML', async () => {
    const html = await airMarkToHtml('This <span>has HTML</span> in <strong>it</strong>. 20 < 30 & I like "pizza".');
    expect(html).toEqual(
      '<p>This &lt;span&gt;has HTML&lt;/span&gt; in &lt;strong&gt;it&lt;/strong&gt;. 20 &lt; 30 &amp; I like &quot;pizza&quot;.</p>',
    );
  });

  it('code block', async () => {
    const html = await airMarkToHtml(
      '~~~programminglanguagenameisstripped\nthis is a code block\n\nSome HTML characters: 20 < 30 & 70 > 60\nMarkdown characters are kept: _ * ~ # [ ] ~ * _\n~~~\n',
    );
    expect(html).toEqual(
      '<pre><code>this is a code block\n\nSome HTML characters: 20 &lt; 30 &amp; 70 &gt; 60\nMarkdown characters are kept: _ * ~ # [ ] ~ * _</code></pre>',
    );
  });

  it('code block with text after it', async () => {
    const html = await airMarkToHtml('~~~\nsome code\n~~~\nHi\n');
    expect(html).toEqual('<pre><code>some code</code></pre><p>Hi</p>');
  });

  it('headers', async () => {
    const html1 = await airMarkToHtml('# Header 1');
    expect(html1).toEqual('<h1>Header 1</h1>');

    const html2 = await airMarkToHtml('## Header 2');
    expect(html2).toEqual('<h2>Header 2</h2>');

    const html3 = await airMarkToHtml('### Header 3');
    expect(html3).toEqual('<h3>Header 3</h3>');

    const html4 = await airMarkToHtml('#### Header 4');
    expect(html4).toEqual('<h4>Header 4</h4>');

    const html5 = await airMarkToHtml('##### Header 5');
    expect(html5).toEqual('<h5>Header 5</h5>');

    const html6 = await airMarkToHtml('###### Header 6');
    expect(html6).toEqual('<h6>Header 6</h6>');

    const html7 = await airMarkToHtml('####### Not a header, too many hashes');
    expect(html7).toEqual('<p>####### Not a header, too many hashes</p>');
  });

  it('headers with styles', async () => {
    const headerWithBold = await airMarkToHtml('### Header 3 **with bold**');
    expect(headerWithBold).toEqual('<h3>Header 3&nbsp;<strong>with bold</strong></h3>');

    const headerWithItalic = await airMarkToHtml('### Header 3 _with italic_');
    expect(headerWithItalic).toEqual('<h3>Header 3&nbsp;<em>with italic</em></h3>');
  });

  it('bold', async () => {
    const html = await airMarkToHtml('this is **bold**');
    expect(html).toEqual('<p>this is&nbsp;<strong>bold</strong></p>');
  });

  it('bold2', async () => {
    const html = await airMarkToHtml('this is __bold__');
    expect(html).toEqual('<p>this is&nbsp;<strong>bold</strong></p>');
  });

  it('italic', async () => {
    const html = await airMarkToHtml('this is *italic*');
    expect(html).toEqual('<p>this is&nbsp;<em>italic</em></p>');
  });

  it('italic2', async () => {
    const html = await airMarkToHtml('this is _italic_');
    expect(html).toEqual('<p>this is&nbsp;<em>italic</em></p>');
  });

  it('strikethrough', async () => {
    const html = await airMarkToHtml('this is ~~strikethrough~~');
    expect(html).toEqual('<p>this is&nbsp;<del>strikethrough</del></p>');
  });

  it('inline code', async () => {
    const html = await airMarkToHtml('this is `inline code`');
    expect(html).toEqual('<p>this is&nbsp;<code>inline code</code></p>');
  });

  it('inline code with backtick', async () => {
    const html = await airMarkToHtml('this is ``inline code with a ` backtick in the middle``');
    expect(html).toEqual('<p>this is&nbsp;<code>inline code with a &grave; backtick in the middle</code></p>');
  });

  it('inline code with several backticks', async () => {
    const html = await airMarkToHtml(
      'Escaped\\` backtick, a single code backtick:`` ` ``, `double backticks ``in the middle`, ``single backtick ` in the middle``',
    );
    expect(html).toEqual(
      '<p>Escaped&grave; backtick, a single code backtick:<code>&nbsp;&grave;&nbsp;</code>,&nbsp;<code>double backticks &grave;&grave;in the middle</code>,&nbsp;<code>single backtick &grave; in the middle</code></p>',
    );
  });

  it('hyperlink', async () => {
    const html = await airMarkToHtml('this is a [hyperlink](https://www.whalesync.com)');
    expect(html).toEqual('<p>this is a&nbsp;<a href="https://www.whalesync.com">hyperlink</a></p>');
  });

  it('blockquote', async () => {
    const html = await airMarkToHtml('> This is a blockquote');
    expect(html).toEqual('<blockquote><p>This is a blockquote</p></blockquote>');
  });

  it('line breaks create paragraphs and empty lines create <br>s', async () => {
    const html = await airMarkToHtml(
      `Paragraph 1
paragraph 2


> A blockquote`,
    );
    expect(html).toEqual(
      '<p>Paragraph 1</p><p>paragraph 2</p><p class="whalesync-empty-line">&#8203;</p><p class="whalesync-empty-line">&#8203;</p><blockquote><p>A blockquote</p></blockquote>',
    );
  });

  it('multiple spaces become &nbsp;', async () => {
    // Test that extra spaces get turned into &nbsp; so they're preserved.
    const html = await airMarkToHtml(
      `A line with   extra spaces should 
 be preserved     `,
    );
    expect(html).toEqual(
      '<p>A line with&nbsp;&nbsp;&nbsp;extra spaces should&nbsp;</p><p>&nbsp;be preserved&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</p>',
    );
  });

  it('ordered list', async () => {
    const html = await airMarkToHtml('1. Item 1\n2. Item 2');
    expect(html).toEqual('<ol><li>Item 1</li><li>Item 2</li></ol>');
  });

  it('ordered list 2', async () => {
    const html = await airMarkToHtml('1) Item 1\n1) Item 2');
    expect(html).toEqual('<ol><li>Item 1</li><li>Item 2</li></ol>');
  });

  it('unordered list', async () => {
    const html = await airMarkToHtml('* A list item\n* Another list item');
    expect(html).toEqual('<ul><li>A list item</li><li>Another list item</li></ul>');
  });

  it('unordered list 2', async () => {
    const html = await airMarkToHtml('- A list item\n- Another list item');
    expect(html).toEqual('<ul><li>A list item</li><li>Another list item</li></ul>');
  });

  it('checkbox list', async () => {
    const html = await airMarkToHtml('[ ] A checkbox\n[x] Another checkbox');
    expect(html).toEqual(
      '<ul style="list-style-type: none; list-style-image: none;" class="whalesync-checkbox-list"><li><input type="checkbox"> A checkbox</li><li><input type="checkbox" checked> Another checkbox</li></ul>',
    );
  });

  it('ordered list and unordered list', async () => {
    const html = await airMarkToHtml('1. Item 1\n* Item 2');
    expect(html).toEqual('<ol><li>Item 1</li></ol><ul><li>Item 2</li></ul>');
  });

  it('unordered list with various indents', async () => {
    const html = await airMarkToHtml(`
* List item level 1
* List item level 1
    * List item level 2
    - List item level 2
            * List item level 4
        * List item level 3
        - List item level 3
        * List item level 3
                * List item level 5
    * List item level 2`);
    expect(html).toEqual(
      '<p class="whalesync-empty-line">&#8203;</p><ul><li>List item level 1</li><li>List item level 1<ul><li>List item level 2</li><li>List item level 2<ul style="list-style-type: none; list-style-image: none;" class="whalesync-placeholder-list"><li><ul><li>List item level 4</li></ul></li></ul><ul><li>List item level 3</li><li>List item level 3</li><li>List item level 3<ul style="list-style-type: none; list-style-image: none;" class="whalesync-placeholder-list"><li><ul><li>List item level 5</li></ul></li></ul></li></ul></li><li>List item level 2</li></ul></li></ul>',
    );
  });

  it('ordered, unordered, and checkbox lists with various indents', async () => {
    const html = await airMarkToHtml(`
            * List item level 3
1) List item level 1
1) List item level 1
    [ ] List item level 2
    [x] List item level 2
            * List item level 4
        1. List item level 3
        2. List item level 3
        3. List item level 3
                * List item level 5
    * List item level 2`);
    expect(html).toEqual(
      '<p class="whalesync-empty-line">&#8203;</p><ul style="list-style-type: none; list-style-image: none;" class="whalesync-placeholder-list"><li><ul style="list-style-type: none; list-style-image: none;" class="whalesync-placeholder-list"><li><ul style="list-style-type: none; list-style-image: none;" class="whalesync-placeholder-list"><li><ul><li>List item level 3</li></ul></li></ul></li></ul></li></ul><ol><li>List item level 1</li><li>List item level 1<ul style="list-style-type: none; list-style-image: none;" class="whalesync-checkbox-list"><li><input type="checkbox"> List item level 2</li><li><input type="checkbox" checked> List item level 2<ul style="list-style-type: none; list-style-image: none;" class="whalesync-placeholder-list"><li><ul><li>List item level 4</li></ul></li></ul><ol><li>List item level 3</li><li>List item level 3</li><li>List item level 3<ul style="list-style-type: none; list-style-image: none;" class="whalesync-placeholder-list"><li><ul><li>List item level 5</li></ul></li></ul></li></ol></li></ul><ul><li>List item level 2</li></ul></li></ol>',
    );
  });

  it('combined styles', async () => {
    const html = await airMarkToHtml(
      'this is a _**`~~[hyperlink with lots of styles](https://www.whalesync.com)~~`**_',
    );
    expect(html).toEqual(
      '<p>this is a&nbsp;<em><strong><code><del><a href="https://www.whalesync.com">hyperlink with lots of styles</a></del></code></strong></em></p>',
    );
  });

  it('combined styles, mixed', async () => {
    const html = await airMarkToHtml(
      'This is plain. **This is bold. _This is bold and italic. ~~This is bold, italic, and strikethrough. `This is all of the above and code. [Hyperlink with lots of styles](https://www.whalesync.com)`~~_**',
    );
    expect(html).toEqual(
      '<p>This is plain.&nbsp;<strong>This is bold.&nbsp;<em>This is bold and italic.&nbsp;<del>This is bold, italic, and strikethrough.&nbsp;<code>This is all of the above and code.&nbsp;<a href="https://www.whalesync.com">Hyperlink with lots of styles</a></code></del></em></strong></p>',
    );
  });

  it('header with styles', async () => {
    const html = await airMarkToHtml(
      '## Header 2 ~~**_hi [`this`](https://www.whalesync.com) is italic strikethrough and bold_**~~   ',
    );
    expect(html).toEqual(
      '<h2>Header 2&nbsp;<del><strong><em>hi&nbsp;<a href="https://www.whalesync.com"><code>this</code></a>&nbsp;is italic strikethrough and bold</em></strong></del>&nbsp;&nbsp;&nbsp;</h2>',
    );
  });

  it('hyperlink with double quote', async () => {
    const html = await airMarkToHtml(
      'hyperlink [with a double quote](https://www.google.com?myparam=this"hasdouble"quotes)',
    );
    expect(html).toEqual(
      '<p>hyperlink&nbsp;<a href="https://www.google.com?myparam=this%22hasdouble%22quotes">with a double quote</a></p>',
    );
  });

  it('hyperlink via angle brackets', async () => {
    const html = await airMarkToHtml('hyperlink to <https://www.whalesync.com> because we make a splash');
    expect(html).toEqual(
      '<p>hyperlink to&nbsp;<a href="https://www.whalesync.com">https://www.whalesync.com</a>&nbsp;because we make a splash</p>',
    );
  });

  it('weird hyperlinks', async () => {
    const html = await airMarkToHtml(
      'hyperlink [\\[test 1]\\(](https://www.google.com)\nhyperlink [test [2]](https://www.google.com)\nhyperlink [[test] 3](https://www.google.com)\nhyperlink [[test 4]](https://www.google.com)',
    );
    expect(html).toEqual(
      '<p>hyperlink&nbsp;<a href="https://www.google.com">[test 1](</a></p><p>hyperlink&nbsp;<a href="https://www.google.com">test [2]</a></p><p>hyperlink&nbsp;<a href="https://www.google.com">[test] 3</a></p><p>hyperlink&nbsp;<a href="https://www.google.com">[test 4]</a></p>',
    );
  });

  // TODO(curtis): NOTE, this test DOES NOT PASS. I wasn't able to figure out the exact hyperlink parsing rules of
  // AirMark such that this passes and the above tests pass too.
  // it('extra weird hyperlink', async () => {
  //   const html = await airMarkToHtml('hyperlink [[test 5](](https://www.google.com)');
  //   expect(html).toEqual('<p>hyperlink [<a href="https://www.google.com">test 5](</a></p>');
  // });

  it('unescape AirMark special chars', async () => {
    const html = await airMarkToHtml('1\\. September, 2022.\n\\~\\[\\]\n');
    expect(html).toEqual('<p>1. September, 2022.</p><p>~[]</p>');
  });

  it('the kitchen sink', async () => {
    const html = await airMarkToHtml(
      [
        'This ~~is~~ `supercalifragilisticexpialidocious`  \n\n\n',
        'hyperlink [\\[test 1]\\(](https://www.google.com)\nhyperlink [test[ [2]](https://www.google.com)\nhyperlink [[test] 3](https://www.google.com)\nhyperlink [[test 4]](https://www.google.com)\n',
        '# \n# Header 1  \n## Header 2 ~~**_hi [`this`](https://www.whalesync.com) is italic strikethrough and bold_**~~   \n### Header 3  \n#### Not a header 4 but we allow it  \n  \n\n',
        '- \n    - \n        - \n\n  \n',
        '1. List item 1 with a [hyperlink](https://www.google.com)  \n2. List item 2  \n    1. Indented item 1\n  \n- UL list item 1  \n- UL list item 2\n- UL list item 3\n        - Indented 4, extra  \n    - Indented 5 but less\n    [ ] Checkbox indented 1  \n    [ ] Checkbox indented 2  \n\n[x] Checkbox 1  \n[ ] Checkbox 2  \n\n',
        '> This is a blockquote\n> \n\n> Blockquote\nNot a blockquote\n> Blockquote\n\n\n',
        'This is a simple hyperlink <https://www.whalesync.com> and this is not </http://www.google.com> or this <blah>\n',
        'Hello! <p>This should escape</p>.**This is \\*\\*bold**. _This is \\*italic_. **_This is bold and \\*\\*italic_**.\n  \nHi10  \n\n```\n',
        'this is a   \nmultiline **code** block \n```\n\n\n',
      ].join(''),
    );
    const expected = [
      '<p>This&nbsp;<del>is</del>&nbsp;<code>supercalifragilisticexpialidocious</code>&nbsp;&nbsp;</p><p class="whalesync-empty-line">&#8203;</p><p class="whalesync-empty-line">&#8203;</p>',
      '<p>hyperlink&nbsp;<a href="https://www.google.com">[test 1](</a></p><p>hyperlink&nbsp;<a href="https://www.google.com">test[ [2]</a></p><p>hyperlink&nbsp;<a href="https://www.google.com">[test] 3</a></p><p>hyperlink&nbsp;<a href="https://www.google.com">[test 4]</a></p>',
      '<h1></h1><h1>Header 1&nbsp;&nbsp;</h1><h2>Header 2&nbsp;<del><strong><em>hi&nbsp;<a href="https://www.whalesync.com"><code>this</code></a>&nbsp;is italic strikethrough and bold</em></strong></del>&nbsp;&nbsp;&nbsp;</h2><h3>Header 3&nbsp;&nbsp;</h3><h4>Not a header 4 but we allow it&nbsp;&nbsp;</h4><p>&nbsp;&nbsp;</p><p class="whalesync-empty-line">&#8203;</p>',
      '<ul><li><ul><li><ul><li></li></ul></li></ul></li></ul><p class="whalesync-empty-line">&#8203;</p><p>&nbsp;&nbsp;</p>',
      '<ol><li>List item 1 with a&nbsp;<a href="https://www.google.com">hyperlink</a>&nbsp;&nbsp;</li><li>List item 2&nbsp;&nbsp;<ol><li>Indented item 1</li></ol></li></ol><p>&nbsp;&nbsp;</p><ul><li>UL list item 1&nbsp;&nbsp;</li><li>UL list item 2</li><li>UL list item 3<ul style="list-style-type: none; list-style-image: none;" class="whalesync-placeholder-list"><li><ul><li>Indented 4, extra&nbsp;&nbsp;</li></ul></li></ul><ul><li>Indented 5 but less</li></ul><ul style="list-style-type: none; list-style-image: none;" class="whalesync-checkbox-list"><li><input type="checkbox"> Checkbox indented 1&nbsp;&nbsp;</li><li><input type="checkbox"> Checkbox indented 2&nbsp;&nbsp;</li></ul></li></ul><p class="whalesync-empty-line">&#8203;</p><ul style="list-style-type: none; list-style-image: none;" class="whalesync-checkbox-list"><li><input type="checkbox" checked> Checkbox 1&nbsp;&nbsp;</li><li><input type="checkbox"> Checkbox 2&nbsp;&nbsp;</li></ul><p class="whalesync-empty-line">&#8203;</p>',
      '<blockquote><p>This is a blockquote</p><p class="whalesync-empty-line">&#8203;</p></blockquote><p class="whalesync-empty-line">&#8203;</p><blockquote><p>Blockquote</p></blockquote><p>Not a blockquote</p><blockquote><p>Blockquote</p></blockquote><p class="whalesync-empty-line">&#8203;</p><p class="whalesync-empty-line">&#8203;</p>',
      '<p>This is a simple hyperlink&nbsp;<a href="https://www.whalesync.com">https://www.whalesync.com</a>&nbsp;and this is not &lt;/http://www.google.com&gt; or this &lt;blah&gt;</p>',
      '<p>Hello! &lt;p&gt;This should escape&lt;/p&gt;.<strong>This is **bold</strong>.&nbsp;<em>This is *italic</em>.&nbsp;<strong><em>This is bold and **italic</em></strong>.</p><p>&nbsp;&nbsp;</p><p>Hi10&nbsp;&nbsp;</p><p class="whalesync-empty-line">&#8203;</p>',
      '<pre><code>this is a   \nmultiline **code** block </code></pre><p class="whalesync-empty-line">&#8203;</p><p class="whalesync-empty-line">&#8203;</p>',
    ].join('');
    expect(html).toEqual(expected);
  });

  it('list tree converter', () => {
    // - List Item 1
    // - List Item 2
    const lines: ListItemLine[] = [
      { type: 'listItem', detail: { type: 'unordered' }, level: 1, text: [{ text: 'List Item 1', type: 'text' }] },
      { type: 'listItem', detail: { type: 'unordered' }, level: 1, text: [{ text: 'List Item 2', type: 'text' }] },
    ];

    const expected: ListTreeNode[] = [
      {
        type: 'unordered',
        linChildren: [
          {
            text: {
              type: 'listItem',
              detail: { type: 'unordered' },
              text: [{ text: 'List Item 1', type: 'text' }],
            },
            ltnChildren: [],
          },
          {
            text: {
              type: 'listItem',
              detail: { type: 'unordered' },
              text: [{ text: 'List Item 2', type: 'text' }],
            },
            ltnChildren: [],
          },
        ],
      },
    ];

    const tree = richTextLinesToListTree(lines);
    expect(tree).toEqual(expected);
  });

  it('list tree converter: indent', () => {
    // - List Item 1
    // - List Item 2
    //     - Indent
    const lines: ListItemLine[] = [
      { type: 'listItem', detail: { type: 'unordered' }, level: 1, text: [{ text: 'List Item 1', type: 'text' }] },
      { type: 'listItem', detail: { type: 'unordered' }, level: 1, text: [{ text: 'List Item 2', type: 'text' }] },
      { type: 'listItem', detail: { type: 'unordered' }, level: 2, text: [{ text: 'Indent', type: 'text' }] },
    ];

    const expected: ListTreeNode[] = [
      {
        type: 'unordered',
        linChildren: [
          {
            text: {
              type: 'listItem',
              detail: { type: 'unordered' },
              text: [{ text: 'List Item 1', type: 'text' }],
            },
            ltnChildren: [],
          },
          {
            text: {
              type: 'listItem',
              detail: { type: 'unordered' },
              text: [{ text: 'List Item 2', type: 'text' }],
            },
            ltnChildren: [
              {
                type: 'unordered',
                linChildren: [
                  {
                    text: {
                      type: 'listItem',
                      detail: { type: 'unordered' },
                      text: [{ text: 'Indent', type: 'text' }],
                    },
                    ltnChildren: [],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];

    const tree = richTextLinesToListTree(lines);
    expect(tree).toEqual(expected);
  });

  it('list tree converter: starting indent', () => {
    //         * List level 3
    // * List level 1
    const lines: ListItemLine[] = [
      { type: 'listItem', detail: { type: 'unordered' }, level: 3, text: [{ text: 'List level 3', type: 'text' }] },
      { type: 'listItem', detail: { type: 'unordered' }, level: 1, text: [{ text: 'List level 1', type: 'text' }] },
    ];

    const expected: ListTreeNode[] = [
      {
        type: 'unordered_blank',
        linChildren: [
          {
            text: { type: 'listItem', detail: { type: 'unordered_blank' }, text: [] },
            ltnChildren: [
              {
                type: 'unordered_blank',
                linChildren: [
                  {
                    text: { type: 'listItem', detail: { type: 'unordered_blank' }, text: [] },
                    ltnChildren: [
                      {
                        type: 'unordered',
                        linChildren: [
                          {
                            text: {
                              type: 'listItem',
                              detail: { type: 'unordered' },
                              text: [{ text: 'List level 3', type: 'text' }],
                            },
                            ltnChildren: [],
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
        type: 'unordered',
        linChildren: [
          {
            text: {
              type: 'listItem',
              detail: { type: 'unordered' },
              text: [{ text: 'List level 1', type: 'text' }],
            },
            ltnChildren: [],
          },
        ],
      },
    ];

    const tree = richTextLinesToListTree(lines);
    expect(tree).toEqual(expected);
  });

  it('list tree converter: lots of crazy indents', () => {
    //         * List level 3
    //         * List level 3
    //                 * List level 5
    // * List level 1
    //     * List level 2
    // * List level 1
    const lines: ListItemLine[] = [
      { type: 'listItem', detail: { type: 'unordered' }, level: 3, text: [{ text: 'List level 3', type: 'text' }] },
      { type: 'listItem', detail: { type: 'unordered' }, level: 3, text: [{ text: 'List level 3', type: 'text' }] },
      { type: 'listItem', detail: { type: 'unordered' }, level: 5, text: [{ text: 'List level 5', type: 'text' }] },
      { type: 'listItem', detail: { type: 'unordered' }, level: 1, text: [{ text: 'List level 1', type: 'text' }] },
      { type: 'listItem', detail: { type: 'unordered' }, level: 2, text: [{ text: 'List level 2', type: 'text' }] },
      { type: 'listItem', detail: { type: 'unordered' }, level: 1, text: [{ text: 'List level 1', type: 'text' }] },
    ];

    const expected: ListTreeNode[] = [
      {
        type: 'unordered_blank',
        linChildren: [
          {
            text: { type: 'listItem', detail: { type: 'unordered_blank' }, text: [] },
            ltnChildren: [
              {
                type: 'unordered_blank',
                linChildren: [
                  {
                    text: { type: 'listItem', detail: { type: 'unordered_blank' }, text: [] },
                    ltnChildren: [
                      {
                        type: 'unordered',
                        linChildren: [
                          {
                            text: {
                              type: 'listItem',
                              detail: { type: 'unordered' },
                              text: [{ text: 'List level 3', type: 'text' }],
                            },
                            ltnChildren: [],
                          },
                          {
                            text: {
                              type: 'listItem',
                              detail: { type: 'unordered' },
                              text: [{ text: 'List level 3', type: 'text' }],
                            },
                            ltnChildren: [
                              {
                                type: 'unordered_blank',
                                linChildren: [
                                  {
                                    text: { type: 'listItem', detail: { type: 'unordered_blank' }, text: [] },
                                    ltnChildren: [
                                      {
                                        type: 'unordered',
                                        linChildren: [
                                          {
                                            text: {
                                              type: 'listItem',
                                              detail: { type: 'unordered' },
                                              text: [{ text: 'List level 5', type: 'text' }],
                                            },
                                            ltnChildren: [],
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
                ],
              },
            ],
          },
        ],
      },
      {
        type: 'unordered',
        linChildren: [
          {
            text: {
              type: 'listItem',
              detail: { type: 'unordered' },
              text: [{ text: 'List level 1', type: 'text' }],
            },
            ltnChildren: [
              {
                type: 'unordered',
                linChildren: [
                  {
                    text: {
                      type: 'listItem',
                      detail: { type: 'unordered' },
                      text: [{ text: 'List level 2', type: 'text' }],
                    },
                    ltnChildren: [],
                  },
                ],
              },
            ],
          },
          {
            text: {
              type: 'listItem',
              detail: { type: 'unordered' },
              text: [{ text: 'List level 1', type: 'text' }],
            },
            ltnChildren: [],
          },
        ],
      },
    ];

    const tree = richTextLinesToListTree(lines);
    expect(tree).toEqual(expected);
  });

  it('list tree converter: several list types', () => {
    // * UL list item
    // - UL list item
    // 1) OL list item
    // 1. OL list item
    // [ ] Unchecked
    // [x] Checked
    const lines: ListItemLine[] = [
      { type: 'listItem', detail: { type: 'unordered' }, level: 1, text: [{ text: 'UL list item', type: 'text' }] },
      { type: 'listItem', detail: { type: 'unordered' }, level: 1, text: [{ text: 'UL list item', type: 'text' }] },
      { type: 'listItem', detail: { type: 'ordered' }, level: 1, text: [{ text: 'OL list item', type: 'text' }] },
      { type: 'listItem', detail: { type: 'ordered' }, level: 1, text: [{ text: 'OL list item', type: 'text' }] },
      {
        type: 'listItem',
        detail: { type: 'checkbox', checked: false },
        level: 1,
        text: [{ text: 'Unchecked', type: 'text' }],
      },
      {
        type: 'listItem',
        detail: { type: 'checkbox', checked: true },
        level: 1,
        text: [{ text: 'Checked', type: 'text' }],
      },
    ];

    const expected: ListTreeNode[] = [
      {
        type: 'unordered',
        linChildren: [
          {
            text: {
              type: 'listItem',
              detail: { type: 'unordered' },
              text: [{ text: 'UL list item', type: 'text' }],
            },
            ltnChildren: [],
          },
          {
            text: {
              type: 'listItem',
              detail: { type: 'unordered' },
              text: [{ text: 'UL list item', type: 'text' }],
            },
            ltnChildren: [],
          },
        ],
      },
      {
        type: 'ordered',
        linChildren: [
          {
            text: {
              type: 'listItem',
              detail: { type: 'ordered' },
              text: [{ text: 'OL list item', type: 'text' }],
            },
            ltnChildren: [],
          },
          {
            text: {
              type: 'listItem',
              detail: { type: 'ordered' },
              text: [{ text: 'OL list item', type: 'text' }],
            },
            ltnChildren: [],
          },
        ],
      },
      {
        type: 'checkbox',
        linChildren: [
          {
            text: {
              type: 'listItem',
              detail: { type: 'checkbox', checked: false },
              text: [{ text: 'Unchecked', type: 'text' }],
            },
            ltnChildren: [],
          },
          {
            text: {
              type: 'listItem',
              detail: { type: 'checkbox', checked: true },
              text: [{ text: 'Checked', type: 'text' }],
            },
            ltnChildren: [],
          },
        ],
      },
    ];

    const tree = richTextLinesToListTree(lines);
    expect(tree).toEqual(expected);
  });

  it('list tree converter: all kinds of items with crazy indents', () => {
    //         * UL item, level 3
    //         1. OL item, level 3
    //                 [ ] Unchecked item, level 5
    // * UL item, level 1
    // *
    // [x] Checked, level 1
    // [ ] Unchecked, level 1
    //     [ ] Unchecked, level 2
    //     1) OL item, level 2
    //     * UL item, level 2 and **bold**
    // * UL item, level 1
    const lines: ListItemLine[] = [
      {
        type: 'listItem',
        detail: { type: 'unordered' },
        level: 3,
        text: [{ text: 'UL item, level 3', type: 'text' }],
      },
      {
        type: 'listItem',
        detail: { type: 'ordered' },
        level: 3,
        text: [{ text: 'OL item, level 3', type: 'text' }],
      },
      {
        type: 'listItem',
        detail: { type: 'checkbox', checked: false },
        level: 5,
        text: [{ text: 'Unchecked item, level 5', type: 'text' }],
      },
      {
        type: 'listItem',
        detail: { type: 'unordered' },
        level: 1,
        text: [{ text: 'UL item, level 1', type: 'text' }],
      },
      { type: 'listItem', detail: { type: 'unordered' }, level: 1, text: [{ text: '', type: 'text' }] },
      {
        type: 'listItem',
        detail: { type: 'checkbox', checked: true },
        level: 1,
        text: [{ text: 'Checked, level 1', type: 'text' }],
      },
      {
        type: 'listItem',
        detail: { type: 'checkbox', checked: false },
        level: 1,
        text: [{ text: 'Unchecked, level 1', type: 'text' }],
      },
      {
        type: 'listItem',
        detail: { type: 'checkbox', checked: false },
        level: 2,
        text: [{ text: 'Unchecked, level 2', type: 'text' }],
      },
      {
        type: 'listItem',
        detail: { type: 'ordered' },
        level: 2,
        text: [{ text: 'OL item, level 2', type: 'text' }],
      },
      {
        type: 'listItem',
        detail: { type: 'unordered' },
        level: 2,
        text: [
          { text: 'UL item, level 2 and ', type: 'text' },
          { children: [{ type: 'text', text: 'bold' }], annotations: { bold: true }, type: 'tag' },
        ],
      },
      {
        type: 'listItem',
        detail: { type: 'unordered' },
        level: 1,
        text: [{ text: 'UL item, level 1', type: 'text' }],
      },
    ];

    const expected: ListTreeNode[] = [
      {
        type: 'unordered_blank',
        linChildren: [
          {
            text: { text: [], type: 'listItem', detail: { type: 'unordered_blank' } },
            ltnChildren: [
              {
                type: 'unordered_blank',
                linChildren: [
                  {
                    text: { text: [], type: 'listItem', detail: { type: 'unordered_blank' } },
                    ltnChildren: [
                      {
                        type: 'unordered',
                        linChildren: [
                          {
                            text: {
                              text: [{ text: 'UL item, level 3', type: 'text' }],
                              type: 'listItem',
                              detail: { type: 'unordered' },
                            },
                            ltnChildren: [],
                          },
                        ],
                      },
                      {
                        type: 'ordered',
                        linChildren: [
                          {
                            text: {
                              text: [{ text: 'OL item, level 3', type: 'text' }],
                              type: 'listItem',
                              detail: { type: 'ordered' },
                            },
                            ltnChildren: [
                              {
                                type: 'unordered_blank',
                                linChildren: [
                                  {
                                    text: { text: [], type: 'listItem', detail: { type: 'unordered_blank' } },
                                    ltnChildren: [
                                      {
                                        type: 'checkbox',
                                        linChildren: [
                                          {
                                            text: {
                                              text: [{ text: 'Unchecked item, level 5', type: 'text' }],
                                              type: 'listItem',
                                              detail: { type: 'checkbox', checked: false },
                                            },
                                            ltnChildren: [],
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
                ],
              },
            ],
          },
        ],
      },
      {
        type: 'unordered',
        linChildren: [
          {
            text: {
              text: [{ text: 'UL item, level 1', type: 'text' }],
              type: 'listItem',
              detail: { type: 'unordered' },
            },
            ltnChildren: [],
          },
          {
            text: { text: [{ text: '', type: 'text' }], type: 'listItem', detail: { type: 'unordered' } },
            ltnChildren: [],
          },
        ],
      },
      {
        type: 'checkbox',
        linChildren: [
          {
            text: {
              text: [{ text: 'Checked, level 1', type: 'text' }],
              type: 'listItem',
              detail: { type: 'checkbox', checked: true },
            },
            ltnChildren: [],
          },
          {
            text: {
              text: [{ text: 'Unchecked, level 1', type: 'text' }],
              type: 'listItem',
              detail: { type: 'checkbox', checked: false },
            },
            ltnChildren: [
              {
                type: 'checkbox',
                linChildren: [
                  {
                    text: {
                      text: [{ text: 'Unchecked, level 2', type: 'text' }],
                      type: 'listItem',
                      detail: { type: 'checkbox', checked: false },
                    },
                    ltnChildren: [],
                  },
                ],
              },
              {
                type: 'ordered',
                linChildren: [
                  {
                    text: {
                      text: [{ text: 'OL item, level 2', type: 'text' }],
                      type: 'listItem',
                      detail: { type: 'ordered' },
                    },
                    ltnChildren: [],
                  },
                ],
              },
              {
                type: 'unordered',
                linChildren: [
                  {
                    text: {
                      text: [
                        { text: 'UL item, level 2 and ', type: 'text' },
                        { children: [{ type: 'text', text: 'bold' }], annotations: { bold: true }, type: 'tag' },
                      ],
                      type: 'listItem',
                      detail: { type: 'unordered' },
                    },
                    ltnChildren: [],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        type: 'unordered',
        linChildren: [
          {
            text: {
              text: [{ text: 'UL item, level 1', type: 'text' }],
              type: 'listItem',
              detail: { type: 'unordered' },
            },
            ltnChildren: [],
          },
        ],
      },
    ];

    const tree = richTextLinesToListTree(lines);
    expect(tree).toEqual(expected);
  });
});
