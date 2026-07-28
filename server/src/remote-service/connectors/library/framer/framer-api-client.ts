// `framer-api` is a pure-ESM package (its module graph has top-level await), but
// the NestJS server is built/run as CommonJS — so a static `import` compiles to
// `require('framer-api')` and crashes at boot with ERR_REQUIRE_ASYNC_MODULE. The
// SDK is therefore loaded through a genuine dynamic `import()` (below), and every
// name we reference here is a TYPE-only import (fully erased at runtime, no require).
import type { Collection, CollectionItem, CollectionItemInput, Field, Framer, ProjectInfo } from 'framer-api';
import {
  FramerCollectionMeta,
  FramerCredentials,
  FramerFieldMeta,
  FramerFieldType,
  FramerItemFile,
  FramerWriteTranslationMaps,
} from './framer-types';

type FramerApiModule = typeof import('framer-api');

/**
 * Load the ESM-only `framer-api` SDK from this CommonJS runtime. The `import()`
 * lives inside a `Function` body (a string the TS compiler never sees, so it
 * can't down-level it to `require()`), which is the supported way to pull an
 * ESM-with-top-level-await module into CJS. Cached after the first load.
 */
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const importFramerApiModule = new Function('return import("framer-api")') as () => Promise<FramerApiModule>;
let framerApiModulePromise: Promise<FramerApiModule> | undefined;
function loadFramerApi(): Promise<FramerApiModule> {
  framerApiModulePromise ??= importFramerApiModule();
  return framerApiModulePromise;
}

/**
 * A write payload for one CMS item, in the shape Framer's `Collection.addItems`
 * accepts. `addItems` is an upsert: an entry WITH `id` updates that item, WITHOUT
 * `id` creates a new one. `fieldData` is keyed by field id; each entry is the
 * minimal `{ type, value }` the SDK needs (we drop the read-only `valueByLocale`).
 */
export interface FramerWriteItem {
  id?: string;
  slug?: string;
  draft?: boolean;
  fieldData?: Record<string, { type: string; value: unknown }>;
}

/**
 * Thin wrapper around the official `framer-api` WebSocket SDK.
 *
 * Framer's Server API is a *stateful* WebSocket session with cold-start latency,
 * so each connector method opens one short-lived connection, does its work, and
 * disconnects (via {@link withConnection}). All data is projected off the SDK's
 * live class instances into plain JSON *inside* that connection — nothing returned
 * here references the SDK runtime or the (now-closed) socket.
 */
export class FramerApiClient {
  constructor(private readonly credentials: FramerCredentials) {}

  /**
   * Open a connection, run `fn`, and always disconnect. The callback must extract
   * every piece of plain data it needs before returning, because the SDK objects
   * it receives stop working once the socket closes.
   */
  private async withConnection<T>(fn: (framer: Framer) => Promise<T>): Promise<T> {
    const { connect } = await loadFramerApi();
    const framer = await connect(this.credentials.projectUrl, this.credentials.apiKey);
    try {
      return await fn(framer);
    } finally {
      // Never let a disconnect failure mask the operation's own result or error
      // (a throw from `fn` must propagate, not get replaced by a socket-teardown error).
      await framer.disconnect().catch(() => undefined);
    }
  }

  /** Fetch the project's metadata — used by `testConnection` (throws on bad credentials). */
  async getProjectInfo(): Promise<ProjectInfo> {
    return this.withConnection((framer) => framer.getProjectInfo());
  }

  /** List the project's user-managed CMS collections (id + name only). */
  async listCollections(): Promise<{ id: string; name: string }[]> {
    return this.withConnection(async (framer) => {
      const collections = await framer.getCollections();
      return collections.map((collection) => ({ id: collection.id, name: collection.name }));
    });
  }

  /**
   * Fetch one collection's full metadata (its field definitions). Returns `null`
   * if no collection with that id exists (e.g. it was deleted in Framer).
   */
  async getCollectionMeta(collectionId: string): Promise<FramerCollectionMeta | null> {
    return this.withConnection(async (framer) => {
      const collection = await this.findCollection(framer, collectionId);
      if (!collection) return null;
      return projectCollectionMeta(collection, await collection.getFields());
    });
  }

  /** Pull every item in a collection as a verbatim JSON record. */
  async getItems(collectionId: string): Promise<FramerItemFile[]> {
    return this.withConnection(async (framer) => {
      const collection = await this.findCollection(framer, collectionId);
      if (!collection) return [];
      const items = await collection.getItems();
      return items.map(projectItemFile);
    });
  }

  /** Pull a subset of a collection's items by id (used to read back after a write). */
  async getItemsByIds(collectionId: string, ids: string[]): Promise<FramerItemFile[]> {
    if (ids.length === 0) return [];
    const wanted = new Set(ids);
    return this.withConnection(async (framer) => {
      const collection = await this.findCollection(framer, collectionId);
      if (!collection) return [];
      const items = await collection.getItems();
      return items.filter((item) => wanted.has(item.id)).map(projectItemFile);
    });
  }

  /** Upsert items (create when no id, update when id present). */
  async upsertItems(collectionId: string, items: FramerWriteItem[]): Promise<void> {
    if (items.length === 0) return;
    await this.withConnection(async (framer) => {
      const collection = await this.findCollection(framer, collectionId);
      if (!collection) throw new Error(`Framer collection ${collectionId} not found`);
      // The SDK's CollectionItemInput is a discriminated union we build structurally;
      // cast at this single boundary (never `any`).
      await collection.addItems(items as unknown as CollectionItemInput[]);
    });
  }

  /** Remove items by id. */
  async removeItems(collectionId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.withConnection(async (framer) => {
      const collection = await this.findCollection(framer, collectionId);
      if (!collection) throw new Error(`Framer collection ${collectionId} not found`);
      await collection.removeItems(ids);
    });
  }

  /**
   * Build the enum/reference id-translation maps for a collection in one
   * connection. Framer stores enum values as case **names** and reference values
   * as target **slugs**, but `addItems` requires the case/item **ids** — so on
   * write we map name/slug → id. Each map also includes id→id so an already-id
   * value passes through unchanged. Reference targets are fetched once per
   * distinct target collection.
   */
  async getWriteTranslationMaps(collectionId: string): Promise<FramerWriteTranslationMaps> {
    return this.withConnection(async (framer) => {
      const collections = await framer.getCollections();
      const collection = collections.find((c) => c.id === collectionId);
      const maps: FramerWriteTranslationMaps = { enumCaseIdByValue: {}, refItemIdByValue: {} };
      if (!collection) return maps;

      const fields = await collection.getFields();
      const targetItemsCache = new Map<string, { id: string; slug: string }[]>();

      for (const field of fields) {
        if (field.type === FramerFieldType.Enum) {
          // Stored enum values are case NAMES, so name must win deterministically
          // over id-passthrough if a case name happens to equal another case's id.
          // Seed id->id first, then overwrite with name->id.
          const caseMap: Record<string, string> = {};
          for (const enumCase of field.cases) caseMap[enumCase.id] = enumCase.id;
          for (const enumCase of field.cases) caseMap[enumCase.name] = enumCase.id;
          maps.enumCaseIdByValue[field.id] = caseMap;
        } else if (
          field.type === FramerFieldType.CollectionReference ||
          field.type === FramerFieldType.MultiCollectionReference
        ) {
          const targetId = field.collectionId;
          let targetItems = targetItemsCache.get(targetId);
          if (!targetItems) {
            const targetCollection = collections.find((c) => c.id === targetId);
            targetItems = targetCollection
              ? (await targetCollection.getItems()).map((item) => ({ id: item.id, slug: item.slug }))
              : [];
            targetItemsCache.set(targetId, targetItems);
          }
          // Stored reference values are target SLUGS, so slug must win
          // deterministically over id-passthrough if a slug equals another item's
          // id. Seed id->id first, then overwrite with slug->id.
          const refMap: Record<string, string> = {};
          for (const item of targetItems) refMap[item.id] = item.id;
          for (const item of targetItems) refMap[item.slug] = item.id;
          maps.refItemIdByValue[field.id] = refMap;
        }
      }
      return maps;
    });
  }

  private async findCollection(framer: Framer, collectionId: string): Promise<Collection | undefined> {
    const collections = await framer.getCollections();
    return collections.find((collection) => collection.id === collectionId);
  }
}

/** Project a live SDK `Field` instance into plain {@link FramerFieldMeta}. */
function projectFieldMeta(field: Field): FramerFieldMeta {
  const meta: FramerFieldMeta = { id: field.id, name: field.name, type: field.type };
  if (field.type === FramerFieldType.Enum) {
    meta.cases = field.cases.map((enumCase) => ({ id: enumCase.id, name: enumCase.name }));
  }
  if (field.type === FramerFieldType.CollectionReference || field.type === FramerFieldType.MultiCollectionReference) {
    meta.collectionId = field.collectionId;
  }
  if (field.type === FramerFieldType.Date && field.displayTime !== undefined) {
    meta.displayTime = field.displayTime;
  }
  return meta;
}

function projectCollectionMeta(collection: Collection, fields: Field[]): FramerCollectionMeta {
  return { id: collection.id, name: collection.name, fields: fields.map(projectFieldMeta) };
}

/**
 * Project a live SDK `CollectionItem` into a plain, JSON-safe record. The
 * JSON round-trip both detaches the data from the (about-to-close) socket and
 * normalizes any class-instance field values (e.g. ImageAsset) into the same
 * plain JSON that gets written to disk — i.e. the verbatim stored shape.
 */
function projectItemFile(item: CollectionItem): FramerItemFile {
  const projected = {
    id: item.id,
    nodeId: item.nodeId,
    slug: item.slug,
    slugByLocale: item.slugByLocale,
    draft: item.draft,
    fieldData: item.fieldData,
  };
  return JSON.parse(JSON.stringify(projected)) as FramerItemFile;
}
