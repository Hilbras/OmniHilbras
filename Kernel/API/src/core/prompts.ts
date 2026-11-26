import { createStateDocument, type StateDocument } from './state-document.js';
import { defaultStateDirectory } from './secure-store.js';

/**
 * Versioned prompts, stored locally.
 *
 * A prompt is content, not a credential: it is written to the same state directory as the rest of the
 * gateway, exported with the encrypted backup, and never handed to a browser as anything but text.
 * Every edit appends a version rather than overwriting one, so "which prompt produced that answer"
 * has an answer, and a bad edit can be rolled back by activating the previous version.
 */

export type PromptVersion = {
  version: number;
  content: string;
  variables: string[];
  createdAt: string;
};

export type Prompt = {
  id: string;
  name: string;
  description: string;
  versions: PromptVersion[];
  activeVersion: number;
  createdAt: string;
  updatedAt: string;
};

const idPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function promptVariables(content: string): string[] {
  const found = new Set<string>();
  for (const match of content.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) found.add(match[1]!);
  return [...found].sort();
}

/** Renders a prompt, refusing rather than leaving `{{name}}` in the output. */
export function renderPrompt(content: string, values: Readonly<Record<string, string | number | boolean>>): string {
  const missing = promptVariables(content).filter((name) => values[name] === undefined);
  if (missing.length > 0) throw new Error(`Missing prompt variables: ${missing.join(', ')}.`);
  return content.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_match, name: string) => String(values[name]));
}

export class LocalPromptStore {
  private readonly document: StateDocument;
  private prompts = new Map<string, Prompt>();
  private loaded?: Promise<void>;

  constructor(options: { directory?: string; path?: string; env?: Readonly<Record<string, string | undefined>> } = {}) {
    this.document = createStateDocument({
      name: 'prompts',
      directory: options.directory ?? defaultStateDirectory(options.env),
      ...(options.path === undefined ? {} : { path: options.path }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
  }

  private async ensureLoaded(): Promise<void> {
    this.loaded ??= (async () => {
      const text = await this.document.read(16 * 1024 * 1024).catch(() => undefined);
      if (!text) return;
      try {
        const parsed = JSON.parse(text) as { prompts?: unknown };
        if (Array.isArray(parsed.prompts)) {
          for (const item of parsed.prompts) {
            if (isPrompt(item)) this.prompts.set(item.id, item);
          }
        }
      } catch { /* an unreadable registry is empty, not fatal */ }
    })();
    await this.loaded;
  }

  async list(): Promise<Prompt[]> {
    await this.ensureLoaded();
    return [...this.prompts.values()].sort((left, right) => left.name.localeCompare(right.name)).map((prompt) => ({ ...prompt, versions: prompt.versions.map((version) => ({ ...version })) }));
  }

  async get(id: string): Promise<Prompt | undefined> {
    await this.ensureLoaded();
    const prompt = this.prompts.get(id);
    return prompt ? { ...prompt, versions: prompt.versions.map((version) => ({ ...version })) } : undefined;
  }

  /** Creates a prompt or appends a version to it. */
  async save(input: { id: string; name?: string; description?: string; content: string; activate?: boolean }): Promise<Prompt> {
    await this.ensureLoaded();
    if (!idPattern.test(input.id)) throw new Error('Prompt ids must be lowercase letters, digits, dots, dashes or underscores.');
    if (typeof input.content !== 'string' || input.content.trim() === '') throw new Error('A prompt needs content.');
    const now = new Date().toISOString();
    const existing = this.prompts.get(input.id);
    const version = (existing?.versions.at(-1)?.version ?? 0) + 1;
    const entry: PromptVersion = { version, content: input.content, variables: promptVariables(input.content), createdAt: now };
    const next: Prompt = existing
      ? { ...existing, versions: [...existing.versions, entry], activeVersion: input.activate === false ? existing.activeVersion : version, updatedAt: now }
      : { id: input.id, name: input.name?.trim() || input.id, description: input.description?.trim() || '', versions: [entry], activeVersion: version, createdAt: now, updatedAt: now };
    this.prompts.set(next.id, next);
    await this.persist();
    return next;
  }

  /** Activates an existing version, so a bad edit is one call away from being undone. */
  async activate(id: string, version: number): Promise<Prompt | undefined> {
    await this.ensureLoaded();
    const existing = this.prompts.get(id);
    if (!existing) return undefined;
    if (!existing.versions.some((candidate) => candidate.version === version)) throw new Error(`Prompt ${id} has no version ${version}.`);
    const next = { ...existing, activeVersion: version, updatedAt: new Date().toISOString() };
    this.prompts.set(id, next);
    await this.persist();
    return next;
  }

  async remove(id: string): Promise<boolean> {
    await this.ensureLoaded();
    if (!this.prompts.delete(id)) return false;
    await this.persist();
    return true;
  }

  private persist() {
    return this.document.write(JSON.stringify({ version: 1, prompts: [...this.prompts.values()] }));
  }
}

function isPrompt(value: unknown): value is Prompt {
  if (typeof value !== 'object' || value === null) return false;
  const prompt = value as Record<string, unknown>;
  return typeof prompt.id === 'string' && typeof prompt.name === 'string' && typeof prompt.description === 'string'
    && typeof prompt.activeVersion === 'number' && typeof prompt.createdAt === 'string' && typeof prompt.updatedAt === 'string'
    && Array.isArray(prompt.versions) && prompt.versions.every((version) => typeof version === 'object' && version !== null
      && typeof (version as Record<string, unknown>).version === 'number'
      && typeof (version as Record<string, unknown>).content === 'string'
      && Array.isArray((version as Record<string, unknown>).variables));
}
