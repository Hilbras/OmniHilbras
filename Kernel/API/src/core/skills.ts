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
}
