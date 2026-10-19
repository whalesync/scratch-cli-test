import { Type } from '@sinclair/typebox';
import { TableViewBannerGroup, TableViewCol, TransformerTypes, X_SCRATCH_READONLY } from '@spinner/shared-types';
import { buildIntercomDefaultView } from '../intercom-default-view';
import {
  buildIntercomArticlesJsonTableSpec,
  buildIntercomCollectionsJsonTableSpec,
  buildIntercomCompaniesJsonTableSpec,
  buildIntercomContactsJsonTableSpec,
  buildIntercomConversationsJsonTableSpec,
} from '../intercom-json-schema';
import { IntercomDataAttribute } from '../intercom-types';

// The view is built from the connector's REAL schemas rather than hand-written fixtures: every
// behaviour it encodes (epoch timestamps, foreign keys, the closed `state` option set, the
// `source` expansion) is driven by an annotation the schema module owns, so a fixture that drifts
// from it would assert nothing. `buildDefaultView` reads only the spec — no API client, no network.
const articlesSchema = buildIntercomArticlesJsonTableSpec({ wsId: 'articles', remoteId: ['articles'] }).schema;
const collectionsSchema = buildIntercomCollectionsJsonTableSpec({
  wsId: 'collections',
  remoteId: ['collections'],
}).schema;
const conversationsSchema = buildIntercomConversationsJsonTableSpec({
  wsId: 'conversations',
  remoteId: ['conversations'],
}).schema;

const articlesView = buildIntercomDefaultView(articlesSchema, 'articles');
const collectionsView = buildIntercomDefaultView(collectionsSchema, 'collections');
const conversationsView = buildIntercomDefaultView(conversationsSchema, 'conversations');

function contactAttribute(overrides: Partial<IntercomDataAttribute>): IntercomDataAttribute {
  return {
    type: 'data_attribute',
    model: 'contact',
    name: 'attr',
    full_name: 'custom_attributes.attr',
    label: 'attr',
    data_type: 'string',
    custom: true,
    archived: false,
    ...overrides,
  };
}
const contactsSchema = buildIntercomContactsJsonTableSpec({ wsId: 'contacts', remoteId: ['contacts'] }, [
  contactAttribute({ name: 'plan_tier', data_type: 'string' }),
  contactAttribute({ name: 'Trial Ends At', data_type: 'date' }),
  contactAttribute({ name: 'priority', data_type: 'string', options: ['high', 'low'] }),
  // Collides with the standard `email` column once formatted, so it must be qualified.
  contactAttribute({ name: 'Email', data_type: 'string' }),
]).schema;
const contactsView = buildIntercomDefaultView(contactsSchema, 'contacts');
const companiesSchema = buildIntercomCompaniesJsonTableSpec({ wsId: 'companies', remoteId: ['companies'] }, [
  contactAttribute({ model: 'company', name: 'creation_source', data_type: 'string' }),
  contactAttribute({ model: 'company', name: 'fable_qa_renewal_date', data_type: 'date' }),
]).schema;
const companiesView = buildIntercomDefaultView(companiesSchema, 'companies');

/** Every column in a view, with banner groups flattened in place. */
function allColsOf(view: { cols: unknown[] }): TableViewCol[] {
  return (view.cols as (TableViewCol | TableViewBannerGroup)[]).flatMap((entry) =>
    entry.kind === 'banner-group' ? entry.cols : [entry],
  );
}

function colAt(view: { cols: unknown[] }, path: string): TableViewCol {
  const cols = view.cols as TableViewCol[];
  const found = cols.find((c) => c.kind === 'col' && c.path === path);
  if (!found) throw new Error(`No column at path "${path}"`);
  return found;
}

function pathsOf(view: { cols: unknown[] }): string[] {
  return (view.cols as TableViewCol[]).map((c) => c.path);
}

describe('buildIntercomDefaultView', () => {
  describe('articles', () => {
    it('should return a view named "Default"', () => {
      expect(articlesView.name).toBe('Default');
    });

    it('should place priority fields first in defined order', () => {
      const expected = ['title', 'id', 'description', 'author_id', 'state', 'url', 'created_at', 'updated_at'];
      expect(pathsOf(articlesView).slice(0, expected.length)).toEqual(expected);
    });

    it('should sort remaining fields alphabetically after priority fields', () => {
      const nonPriority = pathsOf(articlesView).slice(8);
      expect(nonPriority).toEqual([...nonPriority].sort((a, b) => a.localeCompare(b)));
    });

    it.each(['workspace_id', 'translated_content', 'parent_ids', 'statistics'])('should hide %s', (path) => {
      expect(colAt(articlesView, path).hidden).toBe(true);
    });

    it('should not hide visible fields', () => {
      expect(colAt(articlesView, 'title').hidden).toBeUndefined();
    });
  });

  describe('collections', () => {
    it('should return a view named "Default"', () => {
      expect(collectionsView.name).toBe('Default');
    });

    it('should place priority fields first in defined order', () => {
      const expected = ['name', 'id', 'description', 'url', 'order', 'created_at', 'updated_at'];
      expect(pathsOf(collectionsView).slice(0, expected.length)).toEqual(expected);
    });

    it.each(['workspace_id', 'translated_content'])('should hide %s', (path) => {
      expect(colAt(collectionsView, path).hidden).toBe(true);
    });
  });

  describe('conversations', () => {
    it('should return a view named "Default"', () => {
      expect(conversationsView.name).toBe('Default');
    });

    it('should place priority fields first in defined order', () => {
      const expected = [
        'title',
        'id',
        'state',
        'open',
        'read',
        'priority',
        'admin_assignee_id',
        'created_at',
        'updated_at',
      ];
      expect(pathsOf(conversationsView).slice(0, expected.length)).toEqual(expected);
    });

    it.each(['conversation_parts', 'custom_attributes', 'conversation_rating', 'statistics'])(
      'should hide %s',
      (path) => {
        expect(colAt(conversationsView, path).hidden).toBe(true);
      },
    );
  });

  // DEV-11284 — the raw record keeps the integer Intercom sent; only the view/codec change.
  describe('Unix-epoch timestamps', () => {
    it.each([
      ['articles', 'created_at'],
      ['articles', 'updated_at'],
      ['collections', 'updated_at'],
      ['conversations', 'waiting_since'],
      ['conversations', 'snoozed_until'],
    ])('should render %s.%s as a date backed by an epoch_to_iso codec', (entity, path) => {
      const view = { articles: articlesView, collections: collectionsView, conversations: conversationsView }[entity];
      if (!view) throw new Error(`Unknown entity ${entity}`);
      const col = colAt(view, path);

      // Text cell (the only one that consults displayTransformer) + datetime semantics for export.
      expect(col.type).toBe('string');
      expect(col.logicalType).toBe('datetime');
      expect(col.displayTransformer).toEqual({ type: 'epoch_to_iso', options: { unit: 'seconds' } });
      expect(col.codec).toEqual({ toCore: { type: TransformerTypes.EpochToIso, options: { unit: 'seconds' } } });
    });

    it('should leave a genuine number alone', () => {
      const col = colAt(articlesView, 'author_id');
      expect(col.type).toBe('number');
      expect(col.logicalType).toBeUndefined();
      expect(col.codec).toBeUndefined();
    });

    it('should give each timestamp column its own transformer objects', () => {
      const created = colAt(articlesView, 'created_at');
      const updated = colAt(articlesView, 'updated_at');
      expect(created.displayTransformer).not.toBe(updated.displayTransformer);
      expect(created.codec).not.toBe(updated.codec);
    });
  });

  // DEV-11285 — mirrored from the schema annotation so a synthesized column carries it too.
  describe('foreign keys', () => {
    it('should declare Articles.parent_id as a link to collections', () => {
      expect(colAt(articlesView, 'parent_id').foreignKey).toEqual({
        linkedTableId: 'collections',
        linkedTableRemoteId: ['collections'],
        isSingleValued: true,
      });
    });

    it('should declare Collections.parent_id as a self-referential link', () => {
      expect(colAt(collectionsView, 'parent_id').foreignKey).toEqual({
        linkedTableId: 'collections',
        linkedTableRemoteId: ['collections'],
        isSingleValued: true,
      });
    });

    it('should not invent a foreign key on an ordinary id-shaped field', () => {
      expect(colAt(conversationsView, 'admin_assignee_id').foreignKey).toBeUndefined();
    });
  });

  // DEV-11288 — the option set is statically known, so the destination gets a real select.
  describe('closed option sets', () => {
    it('should give Articles.state select semantics while still rendering as a string', () => {
      const col = colAt(articlesView, 'state');
      expect(col.type).toBe('string');
      expect(col.logicalType).toBe('select');
    });

    it('should leave an open string alone (conversations.state is not a declared literal union)', () => {
      const col = colAt(conversationsView, 'state');
      expect(col.type).toBe('string');
      expect(col.logicalType).toBeUndefined();
    });

    it('should not mistake a nullable string for a closed option set', () => {
      expect(colAt(articlesView, 'description').logicalType).toBeUndefined();
    });
  });

  // DEV-11287 — the initiating message is a conversation's highest-value content; as one JSON blob
  // it is unusable at every destination.
  describe('conversations source expansion', () => {
    it('should expand the useful inner values into their own columns', () => {
      expect(colAt(conversationsView, 'source.subject').name).toBe('Source (Subject)');
      expect(colAt(conversationsView, 'source.body').name).toBe('Source (Body)');
      expect(colAt(conversationsView, 'source.author.email').name).toBe('Source (Author Email)');
      expect(colAt(conversationsView, 'source.subject').type).toBe('string');
    });

    it('should keep the raw object as a hidden column so nothing is lost', () => {
      const raw = (conversationsView.cols as TableViewCol[]).find((c) => c.name === 'Source (raw)');
      expect(raw).toMatchObject({ path: 'source', type: 'object', hidden: true });
    });

    it('should carry the readonly flag down to every expanded leaf', () => {
      expect(colAt(conversationsView, 'source.subject').readonly).toBe(true);
      expect(colAt(conversationsView, 'source.author.name').readonly).toBe(true);
    });

    it('should flatten tags to their names', () => {
      const col = colAt(conversationsView, 'tags');
      expect(col.type).toBe('string');
      expect(col.logicalType).toBe('string');
      expect(col.displayTransformer).toEqual({
        type: TransformerTypes.JSONPath,
        options: { expression: '$.tags[*].name', arrayHandling: 'join_comma' },
      });
    });

    it('should leave contacts as an object — its elements are ids with no scalar worth plucking', () => {
      expect(colAt(conversationsView, 'contacts').type).toBe('object');
    });
  });

  describe('type mapping', () => {
    it('should map Boolean to checkbox', () => {
      expect(colAt(conversationsView, 'open').type).toBe('checkbox');
    });

    it('should map Number to number', () => {
      expect(colAt(articlesView, 'author_id').type).toBe('number');
    });

    it('should map Array to object', () => {
      expect(colAt(articlesView, 'parent_ids').type).toBe('object');
    });

    it('should map a nullable String union to string', () => {
      expect(colAt(articlesView, 'url').type).toBe('string');
    });

    it('should map a nullable Number union to number', () => {
      expect(colAt(conversationsView, 'admin_assignee_id').type).toBe('number');
    });

    it('should map date-time format to date', () => {
      const view = buildIntercomDefaultView(
        Type.Object({ timestamp: Type.String({ format: 'date-time' }) }),
        'articles',
      );
      expect(colAt(view, 'timestamp').type).toBe('date');
    });

    it('should map uri format to url', () => {
      const view = buildIntercomDefaultView(Type.Object({ link: Type.String({ format: 'uri' }) }), 'articles');
      expect(colAt(view, 'link').type).toBe('url');
    });

    // A view can be rebuilt from a stored (JSON-parsed) schema, where TypeBox's Kind symbols are
    // gone. A Kind-based mapping types every column `undefined` there, silently dropping every hint.
    it('should map types from a schema round-tripped through JSON', () => {
      const roundTripped = JSON.parse(JSON.stringify(articlesSchema)) as typeof articlesSchema;
      const view = buildIntercomDefaultView(roundTripped, 'articles');

      expect(colAt(view, 'author_id').type).toBe('number');
      expect(colAt(view, 'url').type).toBe('string');
      expect(colAt(view, 'state').logicalType).toBe('select');
      expect(colAt(view, 'created_at').logicalType).toBe('datetime');
      expect(colAt(view, 'parent_id').foreignKey?.linkedTableId).toBe('collections');
    });
  });

  describe('readonly', () => {
    it('should mark readonly fields', () => {
      expect(colAt(articlesView, 'id').readonly).toBe(true);
    });

    it('should not mark writable fields as readonly', () => {
      expect(colAt(articlesView, 'title').readonly).toBeUndefined();
    });

    it('should propagate readonly from a Union wrapper', () => {
      expect(colAt(articlesView, 'url').readonly).toBe(true);
    });
  });

  describe('name formatting', () => {
    it('should convert snake_case to Title Case', () => {
      expect(colAt(articlesView, 'author_id').name).toBe('Author Id');
    });

    it('should capitalize single-word fields', () => {
      expect(colAt(articlesView, 'title').name).toBe('Title');
    });

    it('should handle multi-segment names', () => {
      expect(colAt(conversationsView, 'admin_assignee_id').name).toBe('Admin Assignee Id');
    });
  });

  describe('contacts', () => {
    function contactCol(path: string): TableViewCol {
      const found = allColsOf(contactsView).find((col) => col.path === path);
      if (!found) throw new Error(`No contacts column at path "${path}"`);
      return found;
    }

    it('places priority fields first in defined order', () => {
      const expected = [
        'email',
        'name',
        'role',
        'id',
        'external_id',
        'phone',
        'created_at',
        'updated_at',
        'last_seen_at',
        'signed_up_at',
      ];
      expect(pathsOf(contactsView).slice(0, expected.length)).toEqual(expected);
    });

    it.each([
      'type',
      'workspace_id',
      'avatar',
      'social_profiles',
      'notes',
      'opted_in_subscription_types',
      'opted_out_subscription_types',
    ])('hides %s', (path) => {
      expect(contactCol(path).hidden).toBe(true);
    });

    it('gathers the custom attributes under a "Custom Attributes" banner, one typed column each', () => {
      const banner = contactsView.cols.find((entry): entry is TableViewBannerGroup => entry.kind === 'banner-group');
      expect(banner?.name).toBe('Custom Attributes');
      expect(banner?.cols.map((col) => col.path)).toEqual([
        'custom_attributes.plan_tier',
        'custom_attributes.Trial Ends At',
        'custom_attributes.priority',
        'custom_attributes.Email',
      ]);
      expect(banner?.cols.every((col) => col.readonly === true)).toBe(true);
      expect(banner?.cols.some((col) => col.hidden)).toBe(false);
    });

    it('names custom attribute columns by the attribute, qualifying one that collides with a standard column', () => {
      expect(contactCol('custom_attributes.plan_tier').name).toBe('Plan Tier');
      expect(contactCol('custom_attributes.Trial Ends At').name).toBe('Trial Ends At');
      expect(contactCol('custom_attributes.Email').name).toBe('Custom Attributes (Email)');
      expect(contactCol('email').name).toBe('Email');
    });

    it('keeps the raw custom_attributes bag as a hidden column so later-added attributes stay reachable', () => {
      expect(contactCol('custom_attributes')).toMatchObject({ type: 'object', hidden: true });
    });

    it('renders a date custom attribute as a datetime with the epoch-seconds codec', () => {
      expect(contactCol('custom_attributes.Trial Ends At')).toMatchObject({
        type: 'string',
        logicalType: 'datetime',
        codec: { toCore: { type: TransformerTypes.EpochToIso, options: { unit: 'seconds' } } },
      });
    });

    it('renders a custom attribute with options as a select', () => {
      expect(contactCol('custom_attributes.priority').logicalType).toBe('select');
    });

    it.each(['created_at', 'updated_at', 'last_seen_at', 'signed_up_at', 'last_email_opened_at'])(
      'renders %s as a datetime',
      (path) => {
        expect(contactCol(path).logicalType).toBe('datetime');
      },
    );

    it('expands location into one column per leaf', () => {
      expect(contactCol('location.country').name).toBe('Location (Country)');
      expect(contactCol('location.city').name).toBe('Location (City)');
      expect(contactCol('location')).toMatchObject({ name: 'Location (raw)', hidden: true });
    });

    it('flattens tags to their ids — a contact’s tag stubs carry no names', () => {
      expect(contactCol('tags').displayTransformer).toEqual({
        type: TransformerTypes.JSONPath,
        options: { expression: '$.data[*].id', arrayHandling: 'join_comma' },
      });
    });

    it('links companies.data to the Companies table, flattening the ids', () => {
      expect(contactCol('companies.data')).toEqual({
        kind: 'col',
        path: 'companies.data',
        name: 'Companies',
        type: 'string',
        foreignKey: { linkedTableId: 'companies', linkedTableRemoteId: ['companies'] },
        displayTransformer: {
          type: TransformerTypes.JSONPath,
          options: { expression: '$[*].id', arrayHandling: 'join_comma' },
        },
        codec: {
          toCore: { type: TransformerTypes.JSONPath, options: { expression: '$[*].id', arrayHandling: 'array' } },
        },
        readonly: true,
      });
      expect(contactCol('companies')).toMatchObject({ name: 'Companies (raw)', hidden: true });
    });

    it('renders role as a select of user | lead', () => {
      expect(contactCol('role').logicalType).toBe('select');
    });

    it('leaves the conversations tags rule untouched (names, not ids)', () => {
      expect(colAt(conversationsView, 'tags').displayTransformer).toEqual({
        type: TransformerTypes.JSONPath,
        options: { expression: '$.tags[*].name', arrayHandling: 'join_comma' },
      });
    });
  });

  describe('companies', () => {
    function companyCol(path: string): TableViewCol {
      const found = allColsOf(companiesView).find((col) => col.path === path);
      if (!found) throw new Error(`No companies column at path "${path}"`);
      return found;
    }

    it('places priority fields first in defined order', () => {
      expect(pathsOf(companiesView).slice(0, 6)).toEqual([
        'name',
        'company_id',
        'id',
        'website',
        'industry',
        'plan.name',
      ]);
    });

    it.each(['type', 'app_id', 'segments'])('hides %s', (path) => {
      expect(companyCol(path).hidden).toBe(true);
    });

    it('shows the plan as one "Plan" column of its name, keeping the raw object hidden', () => {
      expect(companyCol('plan.name')).toMatchObject({ name: 'Plan', type: 'string', readonly: true });
      expect(companyCol('plan')).toMatchObject({ name: 'Plan (raw)', hidden: true });
      expect(allColsOf(companiesView).map((col) => col.path)).not.toContain('plan.id');
    });

    it('flattens tags to their names', () => {
      expect(companyCol('tags').displayTransformer).toEqual({
        type: TransformerTypes.JSONPath,
        options: { expression: '$.tags[*].name', arrayHandling: 'join_comma' },
      });
    });

    it('gathers the custom attributes under a "Custom Attributes" banner', () => {
      const banner = companiesView.cols.find((entry): entry is TableViewBannerGroup => entry.kind === 'banner-group');
      expect(banner?.name).toBe('Custom Attributes');
      expect(banner?.cols.map((col) => col.path)).toEqual([
        'custom_attributes.creation_source',
        'custom_attributes.fable_qa_renewal_date',
      ]);
      expect(companyCol('custom_attributes.fable_qa_renewal_date').logicalType).toBe('datetime');
    });

    it.each(['created_at', 'updated_at', 'remote_created_at', 'last_request_at'])(
      'renders %s as a datetime',
      (path) => {
        expect(companyCol(path).logicalType).toBe('datetime');
      },
    );
  });

  describe('empty schema', () => {
    it('should handle an empty schema', () => {
      const view = buildIntercomDefaultView(Type.Object({}), 'articles');
      expect(view.name).toBe('Default');
      expect(view.cols).toHaveLength(0);
    });

    it('should not expand an object with no declared properties', () => {
      const view = buildIntercomDefaultView(
        Type.Object({ source: Type.Object({}, { [X_SCRATCH_READONLY]: true }) }),
        'conversations',
      );
      expect(pathsOf(view)).toEqual(['source']);
      expect(colAt(view, 'source').type).toBe('object');
    });
  });
});
