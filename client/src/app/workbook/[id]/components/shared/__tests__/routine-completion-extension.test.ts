import { CompletionContext, type CompletionResult, type CompletionSource } from '@codemirror/autocomplete';
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
  syncs: [
    { id: 'syn_blog', displayName: 'Blog Sync' },
    { id: 'syn_docs', displayName: 'Docs Sync' },
  ],
};

const source = routineCompletionSource(() => COMPLETION_DATA);

/**
 * Runs a completion source at the end of `doc`. `routineCompletionSource` is always synchronous, so we
 * assert it never returns a Promise — that narrows the union the `CompletionSource` type allows down to
 * the `CompletionResult | null` the assertions expect.
 */
function runCompletion(completionSource: CompletionSource, doc: string, explicit = false): CompletionResult | null {
  const result = completionSource(new CompletionContext(EditorState.create({ doc }), doc.length, explicit));
  if (result instanceof Promise) {
    throw new Error('routineCompletionSource should be synchronous, but it returned a Promise');
  }
  return result;
}

/** Runs the shared `source` with the cursor at the end of `doc`. */
function completeAtEndOf(doc: string, explicit = false): CompletionResult | null {
  return runCompletion(source, doc, explicit);
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

  describe('step options', () => {
    it('offers the `options` key on a pull step', () => {
      expect(labelsOf(completeAtEndOf('steps:\n  - action: pull\n    '))).toContain('options');
    });

    it('hides the `options` key on a sync step (no options defined), but keeps the other fields', () => {
      const labels = labelsOf(completeAtEndOf('steps:\n  - action: sync\n    '));
      expect(labels).not.toContain('options');
      expect(labels).toContain('name');
    });

    it('still offers `options` when the step action is not known yet', () => {
      expect(labelsOf(completeAtEndOf('steps:\n  - folder: /x\n    '))).toContain('options');
    });

    it('scaffolds a nested map via a custom apply on the `options` key', () => {
      const optionsKey = completeAtEndOf('steps:\n  - action: pull\n    ')?.options.find((o) => o.label === 'options');
      expect(typeof optionsKey?.apply).toBe('function');
    });

    it('suggests action-specific option keys inside an options block', () => {
      expect(labelsOf(completeAtEndOf('steps:\n  - action: pull\n    options:\n      '))).toEqual(['fullPull']);
    });

    it('filters option keys by the partially typed key, anchored at its start', () => {
      const doc = 'steps:\n  - action: pull\n    options:\n      full';
      const result = completeAtEndOf(doc);
      expect(labelsOf(result)).toContain('fullPull');
      expect(result?.from).toBe(doc.length - 'full'.length);
    });

    it('gives option keys an apply that chains into the value list', () => {
      const fullPull = completeAtEndOf('steps:\n  - action: pull\n    options:\n      ')?.options.find(
        (o) => o.label === 'fullPull',
      );
      expect(typeof fullPull?.apply).toBe('function');
    });

    it('offers no option keys inside a sync step options block (implicit)', () => {
      expect(completeAtEndOf('steps:\n  - action: sync\n    options:\n      ')).toBeNull();
    });

    it('offers all options when the enclosing step action is unknown', () => {
      expect(labelsOf(completeAtEndOf('steps:\n  - folder: /x\n    options:\n      '))).toContain('fullPull');
    });

    it('offers true/false for a boolean option value', () => {
      const doc = 'steps:\n  - action: pull\n    options:\n      fullPull: ';
      const result = completeAtEndOf(doc);
      expect(labelsOf(result)).toEqual(['true', 'false']);
      expect(result?.from).toBe(doc.length);
    });

    it('anchors the boolean value at a partially typed token', () => {
      const doc = 'steps:\n  - action: pull\n    options:\n      fullPull: tr';
      const result = completeAtEndOf(doc);
      expect(labelsOf(result)).toContain('true');
      expect(result?.from).toBe(doc.length - 'tr'.length);
    });
  });

  describe('sync field', () => {
    it('offers the `sync` key on a sync step', () => {
      expect(labelsOf(completeAtEndOf('steps:\n  - action: sync\n    '))).toContain('sync');
    });

    it('hides the `sync` key on a pull step', () => {
      expect(labelsOf(completeAtEndOf('steps:\n  - action: pull\n    '))).not.toContain('sync');
    });

    it('offers the `sync` key when the step action is not known yet', () => {
      expect(labelsOf(completeAtEndOf('steps:\n  - \n    '))).toContain('sync');
    });

    it('hides `folder` and `connection` on a sync step (invalid there), keeping `sync`/`name`', () => {
      const labels = labelsOf(completeAtEndOf('steps:\n  - action: sync\n    '));
      expect(labels).not.toContain('folder');
      expect(labels).not.toContain('connection');
      expect(labels).toEqual(expect.arrayContaining(['sync', 'name', 'comment', 'timeout']));
    });

    it('keeps `folder` and `connection` on a pull step', () => {
      const labels = labelsOf(completeAtEndOf('steps:\n  - action: pull\n    '));
      expect(labels).toEqual(expect.arrayContaining(['folder', 'connection']));
    });

    it('suggests sync ids with the display name as detail, anchored at the value', () => {
      const doc = 'steps:\n  - action: sync\n    sync: ';
      const result = completeAtEndOf(doc);
      expect(labelsOf(result)).toEqual(['syn_blog', 'syn_docs']);
      expect(result?.options.find((o) => o.label === 'syn_blog')?.detail).toBe('Blog Sync');
      expect(result?.from).toBe(doc.length);
    });

    it('anchors the sync id at a partially typed token', () => {
      const doc = 'steps:\n  - action: sync\n    sync: syn_bl';
      const result = completeAtEndOf(doc);
      expect(labelsOf(result)).toContain('syn_blog');
      expect(result?.from).toBe(doc.length - 'syn_bl'.length);
    });

    it('stays silent for sync values when none are loaded and completion is implicit', () => {
      const emptySource = routineCompletionSource(() => ({ actions: [], connections: [], folders: [], syncs: [] }));
      expect(runCompletion(emptySource, '    sync: ', false)).toBeNull();
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
    const emptySource = routineCompletionSource(() => ({ actions: [], connections: [], folders: [], syncs: [] }));

    it('stays silent for folder values when nothing is loaded and completion is implicit', () => {
      expect(runCompletion(emptySource, '    folder: ', false)).toBeNull();
    });

    it('returns an (empty) result when the user explicitly requests completion', () => {
      const result = runCompletion(emptySource, '    folder: ', true);
      expect(result).not.toBeNull();
      expect(result?.options).toHaveLength(0);
    });
  });
});
