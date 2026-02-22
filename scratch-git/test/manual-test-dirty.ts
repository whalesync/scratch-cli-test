import * as crypto from 'crypto';
import { RepoDiffService } from '../src/services/repo-diff.service';
import { RepoReadService } from '../src/services/repo-read.service';
import { RepoWriteService } from '../src/services/repo-write.service';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FolderConfig {
  name: string;
  adds: number;
  edits: number;
  deletes: number;
}

interface FkMapping {
  sourceFolder: string; // e.g. "posts"
  fieldPath: string[]; // e.g. ["fieldData", "author_id"]
  targetFolder: string; // e.g. "authors"
}

// ---------------------------------------------------------------------------
// CLI Argument Parsing
// ---------------------------------------------------------------------------

let repoId = '';
const folders: FolderConfig[] = [];
const fkMappings: FkMapping[] = [];
let batchSize = 500;

let currentFolder: FolderConfig | null = null;

for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--repo') {
    repoId = process.argv[++i]!;
  } else if (arg === '--folder') {
    currentFolder = { name: process.argv[++i], adds: 0, edits: 0, deletes: 0 };
    folders.push(currentFolder);
  } else if (arg === '-a') {
    if (!currentFolder) {
      console.error('-a must come after --folder');
      process.exit(1);
    }
    currentFolder.adds = parseInt(process.argv[++i], 10);
  } else if (arg === '-e') {
    if (!currentFolder) {
      console.error('-e must come after --folder');
      process.exit(1);
    }
    currentFolder.edits = parseInt(process.argv[++i], 10);
  } else if (arg === '-d') {
    if (!currentFolder) {
      console.error('-d must come after --folder');
      process.exit(1);
    }
    currentFolder.deletes = parseInt(process.argv[++i], 10);
  } else if (arg === '--fk') {
    // Format: "child.field.path=parentFolder"
    const raw = process.argv[++i];
    const eqIdx = raw.indexOf('=');
    if (eqIdx === -1) {
      console.error(`Invalid --fk format: ${raw}  (expected child.field.path=parentFolder)`);
      process.exit(1);
    }
    const lhs = raw.slice(0, eqIdx);
    const targetFolder = raw.slice(eqIdx + 1);
    const parts = lhs.split('.');
    if (parts.length < 2) {
      console.error(`Invalid --fk format: ${raw}  (need at least folder.field)`);
      process.exit(1);
    }
    fkMappings.push({
      sourceFolder: parts[0],
      fieldPath: parts.slice(1),
      targetFolder,
    });
  } else if (arg === '-b') {
    batchSize = parseInt(process.argv[++i], 10);
  } else {
    console.error(`Unknown argument: ${arg}`);
    process.exit(1);
  }
}

if (!repoId) {
  console.error(
    'Usage: npx ts-node test/manual-test-dirty.ts --repo <repoId> --folder <name> -a <n> [-e <n>] [-d <n>] [--fk "child.field=parent"] [-b <n>]',
  );
  process.exit(1);
}

if (folders.length === 0) {
  console.error('At least one --folder is required');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setNestedValue(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (current[key] == null || typeof current[key] !== 'object') {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[path[path.length - 1]] = value;
}

/** Generate a value matching the type of the template value. */
function generateFieldValue(key: string, templateValue: unknown, index: number): unknown {
  if (typeof templateValue === 'string') {
    // Detect ISO timestamp strings and generate valid timestamps
    if (/^\d{4}-\d{2}-\d{2}[T ]/.test(templateValue)) {
      return new Date(Date.now() - index * 86_400_000).toISOString();
    }
    return `sample_${key}_${index}_${Math.random().toString(36).slice(2, 8)}`;
  }
  if (typeof templateValue === 'number') return Math.floor(Math.random() * 1_000_000);
  if (typeof templateValue === 'boolean') return Math.random() > 0.5;
  if (Array.isArray(templateValue)) return [];
  if (templateValue != null && typeof templateValue === 'object') {
    // Recursively generate nested objects
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(templateValue)) {
      result[k] = generateFieldValue(k, v, index);
    }
    return result;
  }
  return null;
}

/** Generate a record from a template schema. */
function generateRecord(
  template: Record<string, unknown>,
  index: number,
  fkFields: Map<string, string[]>, // fieldPath joined → target folder IDs
): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  record['id'] = crypto.randomUUID();

  for (const [key, value] of Object.entries(template)) {
    if (key === 'id') continue;
    record[key] = generateFieldValue(key, value, index);
  }

  // Apply FK references
  for (const [fieldPathKey, targetIds] of Array.from(fkFields)) {
    const fieldPath = fieldPathKey.split('.');
    if (targetIds.length > 0) {
      const targetId = targetIds[Math.floor(Math.random() * targetIds.length)];
      setNestedValue(record, fieldPath, targetId);
    }
  }

  return record;
}

/** Topological sort of folders based on FK dependencies. Parents before children. */
function topoSort(folderConfigs: FolderConfig[], mappings: FkMapping[]): FolderConfig[] {
  const nameToConfig = new Map(folderConfigs.map((f) => [f.name, f]));
  const inDegree = new Map<string, number>();
  const deps = new Map<string, string[]>(); // folder → folders it depends on

  for (const f of folderConfigs) {
    inDegree.set(f.name, 0);
    deps.set(f.name, []);
  }

  for (const fk of mappings) {
    // sourceFolder depends on targetFolder (target must be processed first)
    const current = inDegree.get(fk.sourceFolder) ?? 0;
    inDegree.set(fk.sourceFolder, current + 1);
    const d = deps.get(fk.sourceFolder) ?? [];
    d.push(fk.targetFolder);
    deps.set(fk.sourceFolder, d);
  }

  const sorted: FolderConfig[] = [];
  const queue: string[] = [];

  for (const [name, deg] of Array.from(inDegree)) {
    if (deg === 0) queue.push(name);
  }

  while (queue.length > 0) {
    const name = queue.shift();
    const config = nameToConfig.get(name);
    if (config) sorted.push(config);

    // Decrease in-degree for dependents
    for (const fk of mappings) {
      if (fk.targetFolder === name) {
        const newDeg = (inDegree.get(fk.sourceFolder) ?? 1) - 1;
        inDegree.set(fk.sourceFolder, newDeg);
        if (newDeg === 0) queue.push(fk.sourceFolder);
      }
    }
  }

  if (sorted.length !== folderConfigs.length) {
    console.error('Cycle detected in FK dependencies');
    process.exit(1);
  }

  return sorted;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run() {
  const readService = new RepoReadService(repoId);
  const writeService = new RepoWriteService(repoId);
  const diffService = new RepoDiffService(repoId);

  console.log(`Repo: ${repoId}`);
  console.log(`Folders: ${folders.map((f) => `${f.name}(+${f.adds} ~${f.edits} -${f.deletes})`).join(', ')}`);
  console.log(
    `FK mappings: ${fkMappings.length > 0 ? fkMappings.map((fk) => `${fk.sourceFolder}.${fk.fieldPath.join('.')}→${fk.targetFolder}`).join(', ') : 'none'}`,
  );
  console.log(`Batch size: ${batchSize}`);
  console.log('');

  const sortedFolders = topoSort(folders, fkMappings);

  // Track generated IDs per folder (for FK references)
  const generatedIds = new Map<string, string[]>();

  console.time('Total');

  for (const folder of sortedFolders) {
    console.log(`\n=== ${folder.name} ===`);

    // ------------------------------------------------------------------
    // Read existing records (if edits or deletes needed)
    // ------------------------------------------------------------------
    const editCandidates: Array<{ path: string; record: Record<string, unknown> }> = [];
    const deleteCandidates: Array<{ path: string }> = [];

    if (folder.edits > 0 || folder.deletes > 0) {
      console.time(`  ${folder.name}: read`);

      const files = await readService.list('dirty', folder.name);
      const fileNames = files.filter((f) => f.type === 'file').map((f) => f.name);

      // Read in batches
      for (let i = 0; i < fileNames.length; i += batchSize) {
        const batch = fileNames.slice(i, i + batchSize);
        const results = await readService.readFilesFromFolder('dirty', folder.name, batch);

        for (const { path, content } of results) {
          if (!content) continue;
          let record: Record<string, unknown>;
          try {
            record = JSON.parse(content) as Record<string, unknown>;
          } catch {
            continue;
          }

          // Check for edit candidates: any top-level or nested key starting with "edit_me"
          const hasEditKey =
            Object.keys(record).some((k) => k.startsWith('edit_me')) ||
            (record['fieldData'] != null &&
              typeof record['fieldData'] === 'object' &&
              Object.keys(record['fieldData'] as Record<string, unknown>).some((k) => k.startsWith('edit_me')));
          if (hasEditKey) {
            editCandidates.push({ path, record });
          }

          // Check for delete candidates: safe_to_delete === true (top-level or in fieldData)
          const safeTop = record['safe_to_delete'] === true;
          const safeFd =
            record['fieldData'] != null &&
            typeof record['fieldData'] === 'object' &&
            (record['fieldData'] as Record<string, unknown>)['safe_to_delete'] === true;
          if (safeTop || safeFd) {
            deleteCandidates.push({ path });
          }
        }
        process.stdout.write('.');
      }
      console.log('');
      console.timeEnd(`  ${folder.name}: read`);
      console.log(`  Found ${editCandidates.length} edit candidates, ${deleteCandidates.length} delete candidates`);

      const availableEdits = editCandidates.length - Math.min(deleteCandidates.length, folder.deletes);
      if (folder.edits > 0 && availableEdits < folder.edits) {
        console.error(
          `  ERROR: Need ${folder.edits} edit candidates but only ${availableEdits} available after excluding deletes (records with edit_me* fields)`,
        );
        process.exit(1);
      }
      if (folder.deletes > 0 && deleteCandidates.length < folder.deletes) {
        console.error(
          `  ERROR: Need ${folder.deletes} delete candidates but only found ${deleteCandidates.length} (records with safe_to_delete=true)`,
        );
        process.exit(1);
      }
    }

    // ------------------------------------------------------------------
    // Deletes
    // ------------------------------------------------------------------
    if (folder.deletes > 0) {
      console.time(`  ${folder.name}: deletes`);
      const toDelete = deleteCandidates.slice(0, folder.deletes);

      for (let i = 0; i < toDelete.length; i += batchSize) {
        const batch = toDelete.slice(i, i + batchSize);
        const paths = batch.map((d) => d.path);
        await writeService.deleteFiles('dirty', paths, `Delete batch ${Math.floor(i / batchSize) + 1}`);
        process.stdout.write('.');
      }
      console.log('');
      console.timeEnd(`  ${folder.name}: deletes`);
    }

    // ------------------------------------------------------------------
    // Edits
    // ------------------------------------------------------------------
    if (folder.edits > 0) {
      console.time(`  ${folder.name}: edits`);
      // Exclude records that were already deleted
      const deletedPaths = new Set(deleteCandidates.slice(0, folder.deletes).map((d) => d.path));
      const toEdit = editCandidates.filter((c) => !deletedPaths.has(c.path)).slice(0, folder.edits);
      const timestamp = Date.now();

      for (let i = 0; i < toEdit.length; i += batchSize) {
        const batch = toEdit.slice(i, i + batchSize);
        const files: Array<{ path: string; content: string }> = [];

        for (const { path, record } of batch) {
          // Modify edit_me* fields at top level
          for (const key of Object.keys(record)) {
            if (key.startsWith('edit_me')) {
              record[key] = `edited_${timestamp}_${Math.random().toString(36).slice(2, 8)}`;
            }
          }
          // Modify edit_me* fields inside fieldData
          if (record['fieldData'] != null && typeof record['fieldData'] === 'object') {
            const fd = record['fieldData'] as Record<string, unknown>;
            for (const key of Object.keys(fd)) {
              if (key.startsWith('edit_me')) {
                fd[key] = `edited_${timestamp}_${Math.random().toString(36).slice(2, 8)}`;
              }
            }
          }
          files.push({ path, content: JSON.stringify(record, null, 2) });
        }

        await writeService.commitFiles('dirty', files, `Edit batch ${Math.floor(i / batchSize) + 1}`);
        process.stdout.write('.');
      }
      console.log('');
      console.timeEnd(`  ${folder.name}: edits`);
    }

    // ------------------------------------------------------------------
    // Adds
    // ------------------------------------------------------------------
    if (folder.adds > 0) {
      console.time(`  ${folder.name}: adds`);

      // Schema discovery: read first existing file, or use a simple default
      let template: Record<string, unknown> = { id: '', name: '', data: '' };

      const existingFiles = await readService.list('dirty', folder.name);
      const firstFile = existingFiles.find((f) => f.type === 'file');
      if (firstFile) {
        const [result] = await readService.readFilesFromFolder('dirty', folder.name, [firstFile.name]);
        if (result?.content) {
          try {
            template = JSON.parse(result.content) as Record<string, unknown>;
          } catch {
            // use default
          }
        }
      }

      // Build FK field map for this folder
      const fkFields = new Map<string, string[]>();
      for (const fk of fkMappings) {
        if (fk.sourceFolder === folder.name) {
          const targetIds = generatedIds.get(fk.targetFolder) ?? [];
          // FK refs use the @/<folder>/<id>.json pseudo-ref format
          const refs = targetIds.map((id) => `@/${fk.targetFolder}/${id}.json`);
          fkFields.set(fk.fieldPath.join('.'), refs);
        }
      }

      const addedIds: string[] = [];

      for (let i = 0; i < folder.adds; i += batchSize) {
        const files: Array<{ path: string; content: string }> = [];
        const end = Math.min(i + batchSize, folder.adds);

        for (let j = i; j < end; j++) {
          const record = generateRecord(template, j, fkFields);
          const id = record['id'] as string;
          addedIds.push(id);
          files.push({
            path: `${folder.name}/${id}.json`,
            content: JSON.stringify(record, null, 2),
          });
        }

        await writeService.commitFiles('dirty', files, `Add batch ${Math.floor(i / batchSize) + 1}`);
        process.stdout.write('.');
      }
      console.log('');
      console.timeEnd(`  ${folder.name}: adds`);

      generatedIds.set(folder.name, addedIds);
    }
  }

  // ------------------------------------------------------------------
  // Summary
  // ------------------------------------------------------------------
  console.log('\n--------------------');

  const dirtyStatus = await diffService.getDirtyStatus();

  console.log('Summary:');
  for (const folder of sortedFolders) {
    const pad = Math.max(...sortedFolders.map((f) => f.name.length));
    console.log(
      `  ${folder.name.padEnd(pad)}: ${folder.adds} added, ${folder.edits} edited, ${folder.deletes} deleted`,
    );
  }
  const totalChanges = folders.reduce((sum, f) => sum + f.adds + f.edits + f.deletes, 0);
  console.log(`  Total dirty changes: ${totalChanges} (requested), ${dirtyStatus.length} (actual dirty diff)`);
  console.timeEnd('Total');
}

void run().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
