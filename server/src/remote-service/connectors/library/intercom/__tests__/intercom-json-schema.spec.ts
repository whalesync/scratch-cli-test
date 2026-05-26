/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { X_SCRATCH_LAST_MODIFIED_FIELD, X_SCRATCH_READONLY } from '@spinner/shared-types';
import {
  buildIntercomArticlesJsonTableSpec,
  buildIntercomCollectionsJsonTableSpec,
  buildIntercomConversationsJsonTableSpec,
} from '../intercom-json-schema';

describe('buildIntercomArticlesJsonTableSpec', () => {
  const entityId = { wsId: 'articles', remoteId: ['articles'] };

  it('builds spec with correct metadata', () => {
    const spec = buildIntercomArticlesJsonTableSpec(entityId);

    expect(spec.name).toBe('Articles');
    expect(spec.slug).toBe('articles');
    expect(spec.idColumnRemoteId).toBe('id');
    expect(spec.titleColumnRemoteId).toEqual(['title']);
    expect(spec.mainContentColumnRemoteId).toEqual(['body']);
    expect(spec.slugFieldPath).toBe('title');
  });

  it('includes all article fields', () => {
    const spec = buildIntercomArticlesJsonTableSpec(entityId);
    const props = spec.schema.properties;

    expect(props).toHaveProperty('id');
    expect(props).toHaveProperty('workspace_id');
    expect(props).toHaveProperty('title');
    expect(props).toHaveProperty('description');
    expect(props).toHaveProperty('body');
    expect(props).toHaveProperty('author_id');
    expect(props).toHaveProperty('state');
    expect(props).toHaveProperty('url');
    expect(props).toHaveProperty('parent_id');
    expect(props).toHaveProperty('parent_ids');
    expect(props).toHaveProperty('parent_type');
    expect(props).toHaveProperty('default_locale');
    expect(props).toHaveProperty('translated_content');
    expect(props).toHaveProperty('statistics');
    expect(props).toHaveProperty('created_at');
    expect(props).toHaveProperty('updated_at');
  });

  it('marks id, workspace_id, url, parent_ids, default_locale, statistics, timestamps as readonly', () => {
    const spec = buildIntercomArticlesJsonTableSpec(entityId);
    const props = spec.schema.properties;

    expect(props.id[X_SCRATCH_READONLY]).toBe(true);
    expect(props.workspace_id[X_SCRATCH_READONLY]).toBe(true);
    expect(props.url[X_SCRATCH_READONLY]).toBe(true);
    expect(props.parent_ids[X_SCRATCH_READONLY]).toBe(true);
    expect(props.default_locale[X_SCRATCH_READONLY]).toBe(true);
    expect(props.statistics[X_SCRATCH_READONLY]).toBe(true);
    expect(props.created_at[X_SCRATCH_READONLY]).toBe(true);
    expect(props.updated_at[X_SCRATCH_READONLY]).toBe(true);
  });

  it('does NOT annotate updated_at as the last-modified field (articles have no incremental path)', () => {
    const spec = buildIntercomArticlesJsonTableSpec(entityId);
    const props = spec.schema.properties;

    expect(props.updated_at[X_SCRATCH_LAST_MODIFIED_FIELD]).toBeUndefined();
  });

  it('does not mark title, description, body, author_id, state as readonly', () => {
    const spec = buildIntercomArticlesJsonTableSpec(entityId);
    const props = spec.schema.properties;

    expect(props.title[X_SCRATCH_READONLY]).toBeUndefined();
    expect(props.description[X_SCRATCH_READONLY]).toBeUndefined();
    expect(props.body[X_SCRATCH_READONLY]).toBeUndefined();
    expect(props.author_id[X_SCRATCH_READONLY]).toBeUndefined();
    expect(props.state[X_SCRATCH_READONLY]).toBeUndefined();
  });

  it('tags body with contentMediaType: text/html', () => {
    const spec = buildIntercomArticlesJsonTableSpec(entityId);
    const props = spec.schema.properties;

    expect(props.body.contentMediaType).toBe('text/html');
  });

  it('includes generatedAt timestamp', () => {
    const spec = buildIntercomArticlesJsonTableSpec(entityId);
    expect(spec.generatedAt).toBeDefined();
    expect(() => new Date(spec.generatedAt!)).not.toThrow();
  });
});

describe('buildIntercomCollectionsJsonTableSpec', () => {
  const entityId = { wsId: 'collections', remoteId: ['collections'] };

  it('builds spec with correct metadata', () => {
    const spec = buildIntercomCollectionsJsonTableSpec(entityId);

    expect(spec.name).toBe('Collections');
    expect(spec.slug).toBe('collections');
    expect(spec.idColumnRemoteId).toBe('id');
    expect(spec.titleColumnRemoteId).toEqual(['name']);
    expect(spec.slugFieldPath).toBe('name');
  });

  it('includes all collection fields', () => {
    const spec = buildIntercomCollectionsJsonTableSpec(entityId);
    const props = spec.schema.properties;

    expect(props).toHaveProperty('id');
    expect(props).toHaveProperty('workspace_id');
    expect(props).toHaveProperty('name');
    expect(props).toHaveProperty('description');
    expect(props).toHaveProperty('icon');
    expect(props).toHaveProperty('order');
    expect(props).toHaveProperty('url');
    expect(props).toHaveProperty('default_locale');
    expect(props).toHaveProperty('translated_content');
    expect(props).toHaveProperty('parent_id');
    expect(props).toHaveProperty('help_center_id');
    expect(props).toHaveProperty('created_at');
    expect(props).toHaveProperty('updated_at');
  });

  it('marks id, workspace_id, order, url, default_locale, timestamps as readonly', () => {
    const spec = buildIntercomCollectionsJsonTableSpec(entityId);
    const props = spec.schema.properties;

    expect(props.id[X_SCRATCH_READONLY]).toBe(true);
    expect(props.workspace_id[X_SCRATCH_READONLY]).toBe(true);
    expect(props.order[X_SCRATCH_READONLY]).toBe(true);
    expect(props.url[X_SCRATCH_READONLY]).toBe(true);
    expect(props.default_locale[X_SCRATCH_READONLY]).toBe(true);
    expect(props.created_at[X_SCRATCH_READONLY]).toBe(true);
    expect(props.updated_at[X_SCRATCH_READONLY]).toBe(true);
  });

  it('does NOT annotate updated_at as the last-modified field (collections have no incremental path)', () => {
    const spec = buildIntercomCollectionsJsonTableSpec(entityId);
    const props = spec.schema.properties;

    expect(props.updated_at[X_SCRATCH_LAST_MODIFIED_FIELD]).toBeUndefined();
  });

  it('does not mark name, description, icon, parent_id, help_center_id as readonly', () => {
    const spec = buildIntercomCollectionsJsonTableSpec(entityId);
    const props = spec.schema.properties;

    expect(props.name[X_SCRATCH_READONLY]).toBeUndefined();
    expect(props.description[X_SCRATCH_READONLY]).toBeUndefined();
    expect(props.icon[X_SCRATCH_READONLY]).toBeUndefined();
    expect(props.parent_id[X_SCRATCH_READONLY]).toBeUndefined();
    expect(props.help_center_id[X_SCRATCH_READONLY]).toBeUndefined();
  });

  it('includes generatedAt timestamp', () => {
    const spec = buildIntercomCollectionsJsonTableSpec(entityId);
    expect(spec.generatedAt).toBeDefined();
    expect(() => new Date(spec.generatedAt!)).not.toThrow();
  });
});

describe('buildIntercomConversationsJsonTableSpec', () => {
  const entityId = { wsId: 'conversations', remoteId: ['conversations'] };

  it('builds spec with correct metadata', () => {
    const spec = buildIntercomConversationsJsonTableSpec(entityId);

    expect(spec.name).toBe('Conversations');
    expect(spec.slug).toBe('conversations');
    expect(spec.idColumnRemoteId).toBe('id');
    expect(spec.titleColumnRemoteId).toEqual(['title']);
    expect(spec.slugFieldPath).toBe('source.subject');
  });

  it('includes all conversation fields', () => {
    const spec = buildIntercomConversationsJsonTableSpec(entityId);
    const props = spec.schema.properties;

    expect(props).toHaveProperty('id');
    expect(props).toHaveProperty('title');
    expect(props).toHaveProperty('state');
    expect(props).toHaveProperty('open');
    expect(props).toHaveProperty('read');
    expect(props).toHaveProperty('priority');
    expect(props).toHaveProperty('admin_assignee_id');
    expect(props).toHaveProperty('team_assignee_id');
    expect(props).toHaveProperty('waiting_since');
    expect(props).toHaveProperty('snoozed_until');
    expect(props).toHaveProperty('source');
    expect(props).toHaveProperty('contacts');
    expect(props).toHaveProperty('tags');
    expect(props).toHaveProperty('custom_attributes');
    expect(props).toHaveProperty('conversation_rating');
    expect(props).toHaveProperty('statistics');
    expect(props).toHaveProperty('conversation_parts');
    expect(props).toHaveProperty('created_at');
    expect(props).toHaveProperty('updated_at');
  });

  it('marks all fields as readonly', () => {
    const spec = buildIntercomConversationsJsonTableSpec(entityId);
    const props = spec.schema.properties;

    for (const key of Object.keys(props)) {
      expect(props[key][X_SCRATCH_READONLY]).toBe(true);
    }
  });

  it('annotates updated_at as the last-modified field for the UI picker (not created_at)', () => {
    const spec = buildIntercomConversationsJsonTableSpec(entityId);
    const props = spec.schema.properties;

    expect(props.updated_at[X_SCRATCH_LAST_MODIFIED_FIELD]).toBe(true);
    expect(props.created_at[X_SCRATCH_LAST_MODIFIED_FIELD]).toBeUndefined();
  });

  it('includes source with nested author schema', () => {
    const spec = buildIntercomConversationsJsonTableSpec(entityId);
    const source = spec.schema.properties.source;

    expect(source.properties).toHaveProperty('subject');
    expect(source.properties).toHaveProperty('body');
    expect(source.properties).toHaveProperty('author');
    expect(source.properties.author.properties).toHaveProperty('name');
    expect(source.properties.author.properties).toHaveProperty('email');
  });

  it('includes conversation_parts with nested part schema', () => {
    const spec = buildIntercomConversationsJsonTableSpec(entityId);
    const parts = spec.schema.properties.conversation_parts;

    expect(parts.properties).toHaveProperty('conversation_parts');
    expect(parts.properties).toHaveProperty('total_count');
  });

  it('tags source.body and conversation part body with contentMediaType: text/html', () => {
    const spec = buildIntercomConversationsJsonTableSpec(entityId);
    const sourceBody = spec.schema.properties.source.properties.body;
    const partBody = spec.schema.properties.conversation_parts.properties.conversation_parts.items.properties.body;

    expect(sourceBody.contentMediaType).toBe('text/html');
    expect(partBody.contentMediaType).toBe('text/html');
  });

  it('includes generatedAt timestamp', () => {
    const spec = buildIntercomConversationsJsonTableSpec(entityId);
    expect(spec.generatedAt).toBeDefined();
    expect(() => new Date(spec.generatedAt!)).not.toThrow();
  });
});
