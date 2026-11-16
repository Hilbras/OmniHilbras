import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { atomicWrite, defaultStateDirectory } from './secure-store.js';

export type Skill = {
  id: string;
  name: string;
  description: string;
  content: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SkillInput = {
  id: string;
  name?: string;
  description?: string;
  content?: string;
  enabled?: boolean;
};

export interface SkillStore {
  list(): Promise<Skill[]>;
  get(id: string): Promise<Skill | undefined>;
  save(input: SkillInput): Promise<Skill>;
  remove(id: string): Promise<boolean>;
  /** Encrypted-backup support, in this store's own file shape. Optional, like `ApiKeyStore`'s pair. */
  exportState?(): Promise<SkillsBackupState>;
  /** Replaces every skill. Validates before it mutates; see `parseSkillState`. */
  importState?(state: SkillsBackupState): Promise<void>;
}

/** The store's own file shape, so a backup is the file it already writes rather than a second format. */
export type SkillsBackupState = SkillsFile;

/**
 * Reads a backup's skill section.
 *
 * Strict where the load path is tolerant. A missing or corrupt file is an empty catalog rather than an
 * unstartable gateway, and a single malformed record is skipped so it cannot hide the rest; neither is
 * true of a whole section being swapped in, where a record that cannot be read means the section is not
 * one this store can hold. Every record then goes through the same `normalize` the writer uses.
 */
export function parseSkillState(value: unknown): SkillsBackupState {
  if (!isRecord(value) || !Array.isArray(value.skills)) throw new Error('The backup\'s skill section is not readable.');
  const skills = new Map<string, Skill>();
  for (const candidate of value.skills) {
    if (!isStoredSkill(candidate)) throw new Error('The backup contains an unreadable skill.');
    skills.set(candidate.id, normalize(candidate, candidate));
  }
  return { version: 1, skills: [...skills.values()] };
}

/** Every field the writer puts on a record. A backup is read strictly, so one missing field is refused. */
function isStoredSkill(value: unknown): value is Skill {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.description === 'string'
    && typeof value.content === 'string'
    && typeof value.enabled === 'boolean'
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

function normalize(input: SkillInput, existing?: Skill): Skill {
  if (typeof input.id !== 'string' || !idPattern.test(input.id)) throw new Error('Skill ids must be non-empty and contain only safe characters.');
  const name = input.name?.trim() || existing?.name || input.id;
  if (!name) throw new Error('A skill needs a name.');
  const now = new Date().toISOString();
  return {
    id: input.id,
    name,
    description: input.description?.trim() ?? existing?.description ?? '',
    content: input.content ?? existing?.content ?? '',
    enabled: input.enabled ?? existing?.enabled ?? true,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export class InMemorySkillStore implements SkillStore {
  private readonly skills = new Map<string, Skill>();

  async list() { return [...this.skills.values()].sort((a, b) => a.id.localeCompare(b.id)); }
  async get(id: string) { return this.skills.get(id); }
  async save(input: SkillInput) {
    const next = normalize(input, this.skills.get(input.id));
    this.skills.set(next.id, next);
    return next;
  }
  async remove(id: string) { return this.skills.delete(id); }
  async exportState(): Promise<SkillsBackupState> { return { version: 1, skills: [...this.skills.values()] }; }
  async importState(state: SkillsBackupState) {
    const next = parseSkillState(state);
    this.skills.clear();
    for (const skill of next.skills) this.skills.set(skill.id, skill);
  }
}

type SkillsFile = { version: 1; skills: Skill[] };

export class LocalSkillStore implements SkillStore {
  private readonly path: string;
  private skills = new Map<string, Skill>();
  private loaded = false;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: { directory?: string; path?: string } = {}) {
    this.path = options.path ?? join(options.directory ?? defaultStateDirectory(), 'skills.json');
  }

  private async ensureLoaded() {
    if (this.loaded) return;
    try {
      const raw: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (raw && typeof raw === 'object' && Array.isArray((raw as { skills?: unknown }).skills)) {
        for (const candidate of (raw as { skills: unknown[] }).skills) {
          try {
            const skill = normalize(candidate as SkillInput, candidate as Skill);
            this.skills.set(skill.id, skill);
          } catch { /* skip malformed */ }
        }
      }
    } catch { /* missing/corrupt => empty */ }
    this.loaded = true;
  }

  private persist() {
    return atomicWrite(this.path, `${JSON.stringify({ version: 1, skills: [...this.skills.values()] } satisfies SkillsFile, null, 2)}\n`);
  }

  private withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(operation, operation);
    this.mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  async list() {
    await this.mutationQueue;
    await this.ensureLoaded();
    return [...this.skills.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
  async get(id: string) {
    await this.mutationQueue;
    await this.ensureLoaded();
    return this.skills.get(id);
  }
  async save(input: SkillInput) {
    return this.withMutation(async () => {
      await this.ensureLoaded();
      const next = normalize(input, this.skills.get(input.id));
      this.skills.set(next.id, next);
      await this.persist();
      return next;
    });
  }
  async remove(id: string) {
    return this.withMutation(async () => {
      await this.ensureLoaded();
      const removed = this.skills.delete(id);
      if (removed) await this.persist();
      return removed;
    });
  }

  async exportState(): Promise<SkillsBackupState> {
    await this.mutationQueue;
    await this.ensureLoaded();
    return { version: 1, skills: [...this.skills.values()] };
  }

  /**
   * Replaces every skill, in one write.
   *
   * The previous map is held while the file is written and put back if the write fails, so a failed import
   * leaves the store as it was — which is what lets `importBackup` undo a half-applied restore.
   */
  async importState(state: SkillsBackupState): Promise<void> {
    const next = parseSkillState(state);
    return this.withMutation(async () => {
      await this.ensureLoaded();
      const previous = this.skills;
      this.skills = new Map(next.skills.map((skill) => [skill.id, skill] as const));
      try {
        await this.persist();
      } catch (error) {
        this.skills = previous;
        await this.persist().catch(() => undefined);
        throw error;
      }
    });
  }
}
