import { Service } from 'src/remote-service/connectors/service-constants';
import { ricosToHtmlTransformer } from '../implementations/ricos-to-html.transformer';
import { createNullLookupTools } from '../lookup-tools';
import { SyncRecord, TransformContext } from '../transformer.types';

function createContext(sourceValue: unknown): TransformContext {
  const sourceRecord: SyncRecord = { id: 'test', filePath: '/test', fields: { richContent: sourceValue } };
  return {
    sourceRecord,
    sourceFieldPath: 'richContent',
    sourceValue,
    sourceTableSpec: null,
    sourceService: Service.WIX_BLOG,
    destinationFieldPath: 'body',
    destinationTableSpec: null,
    destinationService: Service.AIRTABLE,
    lookupTools: createNullLookupTools(),
    options: {},
    phase: 'DATA',
  };
}

/**
 * Run the transformer and return the rendered HTML.
 *
 * `TransformResult` is a discriminated union and only the success arm carries `value`, so a failure
 * has to be narrowed out before the assertion — and failing here with the transformer's own error
 * message beats a bare "value is undefined".
 */
async function renderToHtml(sourceValue: unknown): Promise<string> {
  const result = await ricosToHtmlTransformer.transform(createContext(sourceValue));
  if (!result.success) {
    throw new Error(`Expected the transform to succeed, got: ${result.error}`);
  }
  return result.value as string;
}

/** A Ricos paragraph carrying one run of text, optionally decorated. */
function paragraph(text: string, decorations: unknown[] = []): unknown {
  return {
    type: 'PARAGRAPH',
    id: `p-${text}`,
    nodes: [{ type: 'TEXT', id: `t-${text}`, nodes: [], textData: { text, decorations } }],
  };
}

describe('ricosToHtmlTransformer', () => {
  it('has the expected type', () => {
    expect(ricosToHtmlTransformer.type).toBe('ricos_to_html');
  });

  it('renders a Ricos document to HTML', async () => {
    const document = {
      nodes: [
        {
          type: 'HEADING',
          id: 'h1',
          headingData: { level: 1 },
          nodes: [{ type: 'TEXT', id: 't1', textData: { text: 'Title', decorations: [] } }],
        },
        paragraph('Body text'),
      ],
    };

    expect(await renderToHtml(document)).toBe('<h1>Title</h1><p>Body text</p>');
  });

  it('carries text decorations through as HTML', async () => {
    const document = {
      nodes: [
        paragraph('bold', [
          { type: 'BOLD', fontWeightValue: 700 },
          { type: 'ITALIC', italicData: true },
        ]),
      ],
    };

    expect(await renderToHtml(document)).toBe('<p><em><strong>bold</strong></em></p>');
  });

  // DEV-11114: the whole point is that a destination stops receiving raw JSON.
  it('never emits the raw Ricos JSON', async () => {
    const document = { nodes: [paragraph('Hello')], metadata: { version: 1 } };

    const html = await renderToHtml(document);

    expect(html).not.toContain('"nodes"');
    expect(html).not.toContain('textData');
  });

  it('passes null and undefined through as null', async () => {
    expect(await ricosToHtmlTransformer.transform(createContext(null))).toEqual({ success: true, value: null });
    expect(await ricosToHtmlTransformer.transform(createContext(undefined))).toEqual({ success: true, value: null });
  });

  // `richContent` is optional on a draft post. A body-less post should export as empty, not as a
  // failed field that fails the whole record.
  it('renders anything that is not a Ricos document as empty rather than failing', async () => {
    for (const notADocument of ['already html', 42, {}, { nodes: 'not-an-array' }]) {
      expect(await ricosToHtmlTransformer.transform(createContext(notADocument))).toEqual({
        success: true,
        value: '',
      });
    }
  });

  it('renders a document with no nodes as an empty string', async () => {
    const result = await ricosToHtmlTransformer.transform(createContext({ nodes: [] }));

    expect(result).toEqual({ success: true, value: '' });
  });
});
