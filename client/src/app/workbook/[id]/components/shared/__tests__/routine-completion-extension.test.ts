import { CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { routineCompletionSource, type RoutineCompletionData } from '../routine-completion-extension';

const COMPLETION_DATA: RoutineCompletionData = {
  actions: ['pull', 'sync', 'publish-plan', 'publish'],
  connections: [
    { id: 'coa_air', displayName: 'Prod Airtable', service: 'airtable' },
    { id: 'coa_web', displayName: 'Marketing Webflow', service: 'webflow' },
  ],
  folders: [
    {
      id: 'dfd_posts',
      path: '/blog/posts',
      name: 'posts',
      connectorDisplayName: 'Prod Airtable',
      connectorService: 'airtable',
    },
    // A folder with no path — we fall back to inserting its id.
    { id: 'dfd_orphan', path: null, name: 'orphan', connectorDisplayName: null, connectorService: null },
  ],
};

const source = routineCompletionSource(() => COMPLETION_DATA);

/** Runs the source with the cursor at the end of `doc`. */
function completeAtEndOf(doc: string, explicit = false): CompletionResult | null {
  return source(new CompletionContext(EditorState.create({ doc }), doc.length, explicit));
}

function labelsOf(result: CompletionResult | null): string[] {
  return (result?.options ?? []).map((option) => String(option.label));
}

describe('routineCompletionSource', () => {
  describe('action values', () => {
    it('offers the action shortlist on an inline step line, anchored at the typed token', () => {
      const doc = '  - action: pu';
      const result = completeAtEndOf(doc);
      expect(labelsOf(result)).toEqual(expect.arrayContaining(['pull', 'sync', 'publish-plan', 'publish']));
      expect(result?.from).toBe(doc.length - 'pu'.length);
    });

    it('offers the action shortlist on a field line with an empty value', () => {
      const doc = '    action: ';
      const result = completeAtEndOf(doc);
      expect(labelsOf(result)).toEqual(expect.arrayContaining(['pull', 'sync', 'publish-plan', 'publish']));
      expect(result?.from).toBe(doc.length);
    });

    it('describes each action via the completion detail', () => {
      const pull = completeAtEndOf('  - action: ')?.options.find((option) => option.label === 'pull');
      expect(pull?.detail).toBeTruthy();
    });
  });

  describe('folder values', () => {
    it('suggests folder paths and falls back to the id when a folder has no path', () => {
      const doc = '    folder: ';
      const labels = labelsOf(completeAtEndOf(doc));
      expect(labels).toContain('/blog/posts');
      expect(labels).toContain('dfd_orphan');
    });

    it('shows connection + service as detail and the stable id as info for a path folder', () => {
      const posts = completeAtEndOf('    folder: ')?.options.find((option) => option.label === '/blog/posts');
      expect(posts?.detail).toBe('Prod Airtable · airtable');
      expect(posts?.info).toBe('dfd_posts');
    });

    it('anchors the replacement at the start of a partially typed path', () => {
      const doc = '    folder: /bl';
      const result = completeAtEndOf(doc);
      expect(result?.from).toBe(doc.length - '/bl'.length);
      expect(labelsOf(result)).toContain('/blog/posts');
    });
  });

  describe('connection values', () => {
    it('suggests connection display names with service detail and id info', () => {
      const doc = '    connection: ';
      const result = completeAtEndOf(doc);
      expect(labelsOf(result)).toEqual(expect.arrayContaining(['Prod Airtable', 'Marketing Webflow']));
      const airtable = result?.options.find((option) => option.label === 'Prod Airtable');
      expect(airtable?.detail).toBe('airtable');
      expect(airtable?.info).toBe('coa_air');
      expect(result?.from).toBe(doc.length);
    });
  });

  describe('step field keys', () => {
    it('offers the step fields plus a "new step" scaffold on a blank indented line', () => {
      expect(labelsOf(completeAtEndOf('    '))).toEqual(
        expect.arrayContaining(['new step', 'action', 'folder', 'connection', 'name', 'comment', 'timeout']),
      );
    });

    it('omits the "new step" scaffold once a dash has been typed', () => {
      const labels = labelsOf(completeAtEndOf('  - '));
      expect(labels).toContain('action');
      expect(labels).not.toContain('new step');
    });

    it('filters by the partially typed key, anchored at the key start', () => {
      const doc = '    fol';
      const result = completeAtEndOf(doc);
      expect(labelsOf(result)).toContain('folder');
      expect(result?.from).toBe(doc.length - 'fol'.length);
    });

    it('gives field keys an apply that chains into the value list; action values insert plainly', () => {
      const actionKey = completeAtEndOf('  - ')?.options.find((option) => option.label === 'action');
      expect(typeof actionKey?.apply).toBe('function');
      const pullValue = completeAtEndOf('  - action: ')?.options.find((option) => option.label === 'pull');
      expect(pullValue?.apply).toBeUndefined();
    });
  });

  describe('top-level keys', () => {
    it('offers top-level keys on an empty document', () => {
      expect(labelsOf(completeAtEndOf(''))).toEqual(expect.arrayContaining(['name', 'steps', 'schedule', 'comment']));
    });

    it('filters top-level keys by the typed prefix, anchored at the key start', () => {
      const doc = 'ste';
      const result = completeAtEndOf(doc);
      expect(labelsOf(result)).toContain('steps');
      expect(result?.from).toBe(doc.length - 'ste'.length);
    });
  });

  describe('non-completion contexts', () => {
    it('returns null on a comment line', () => {
      expect(completeAtEndOf('# just a comment')).toBeNull();
    });

    it('returns null after a completed, space-separated value', () => {
      expect(completeAtEndOf('    folder: /blog/posts extra')).toBeNull();
    });
  });

  describe('empty live data', () => {
    const emptySource = routineCompletionSource(() => ({ actions: [], connections: [], folders: [] }));

    it('stays silent for folder values when nothing is loaded and completion is implicit', () => {
      const doc = '    folder: ';
      expect(emptySource(new CompletionContext(EditorState.create({ doc }), doc.length, false))).toBeNull();
    });

    it('returns an (empty) result when the user explicitly requests completion', () => {
      const doc = '    folder: ';
      const result = emptySource(new CompletionContext(EditorState.create({ doc }), doc.length, true));
      expect(result).not.toBeNull();
      expect(result?.options).toHaveLength(0);
    });
  });
});
