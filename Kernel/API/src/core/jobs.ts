import { randomUUID } from 'node:crypto';
import { createStateDocument, type StateDocument } from './state-document.js';

/**
 * A bounded history of the gateway's background passes.
 *
 * Health sweeps and token renewals run on timers and previously left no durable trace: after a restart
 * an operator could see the current health but not whether the last sweep failed or when renewal ran.
 * This records the pass itself — name, start, duration, outcome and a short detail — not a scheduler.
 * The timer still owns *when*; the record is for diagnosis and for `GET /v1/jobs`.
 */
export type JobRun = {
  id: string;
  name: string;
  at: string;
  durationMs: number;
  outcome: 'ok' | 'error';
  detail?: string;
};

export interface JobStore {
  record(input: Omit<JobRun, 'id' | 'at'>): Promise<JobRun>;
  list(limit?: number): Promise<JobRun[]>;
}

export type JobsFile = { version: 1; runs: JobRun[] };

const maxRuns = 1000;
const version = 1;

export class LocalJobStore implements JobStore {
  private readonly document: StateDocument;
  private runs: JobRun[] = [];
  private loaded = false;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: { directory?: string; path?: string } = {}) {
    this.document = createStateDocument({ directory: options.directory, name: 'jobs', ...(options.path ? { path: options.path } : {}) });
  }

  private async ensureLoaded() {
    if (this.loaded) return;
    const text = await this.document.read();
    if (text) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { runs?: unknown }).runs)) {
          this.runs = (parsed as { runs: unknown[] }).runs.filter(isRun).slice(-maxRuns);
        }
      } catch {
        // A corrupt job file is an empty history, not an unstartable gateway.
      }
    }
    this.loaded = true;
  }

  private persist() {
    return this.document.write(`${JSON.stringify({ version, runs: this.runs } satisfies JobsFile)}\n`);
  }

  async record(input: Omit<JobRun, 'id' | 'at'>) {
    const run: JobRun = { id: `job_${randomUUID()}`, at: new Date().toISOString(), ...input };
    const queued = this.mutationQueue.then(async () => {
      await this.ensureLoaded();
      this.runs.push(run);
      if (this.runs.length > maxRuns) this.runs = this.runs.slice(-maxRuns);
      await this.persist();
      return run;
    });
    this.mutationQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  async list(limit = 50) {
    await this.mutationQueue;
    await this.ensureLoaded();
    return this.runs.slice(-Math.max(1, Math.min(Math.floor(limit), maxRuns))).reverse();
  }
}

function isRun(value: unknown): value is JobRun {
  if (!value || typeof value !== 'object') return false;
  const run = value as Record<string, unknown>;
  return typeof run.id === 'string'
    && typeof run.name === 'string'
    && typeof run.at === 'string'
    && typeof run.durationMs === 'number'
    && (run.outcome === 'ok' || run.outcome === 'error');
}
