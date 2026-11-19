#!/usr/bin/env node
/**
 * Read every saved provider catalog, without spending inference tokens.
 *
 * Model listings are unbilled metadata reads; this script still refuses to call chat, streaming or a
 * probe, because those can spend a request. It is deliberately **not** part of `pnpm verify` — it
 * needs a running gateway and, for most providers, a real credential, so it is an operator tool.
 *
 *   node scripts/audit-model-catalogs.mjs
 *   node scripts/audit-model-catalogs.mjs --gateway http://127.0.0.1:20138 --json report.json
 *   node scripts/audit-model-catalogs.mjs --provider codex
 *
 * Authentication, in order: `--api-key`, `OMNIHILBRAS_API_KEY`, then the per-launch dashboard token
 * file with the dashboard origin. Nothing is printed except the report; no credential is read.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const valueOf = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const gateway = (valueOf('--gateway', process.env.OMNIHILBRAS_GATEWAY_URL ?? 'http://127.0.0.1:20138')).replace(/\/$/, '');
const providerFilter = valueOf('--provider', undefined);
const jsonPath = valueOf('--json', undefined);
const apiKey = valueOf('--api-key', process.env.OMNIHILBRAS_API_KEY);
const dashboardOrigin = valueOf('--origin', 'http://127.0.0.1:20137');

async function dashboardToken() {
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  try {
    return (await readFile(join(configHome, 'omnihilbras', 'dashboard-token'), 'utf8')).trim();
  } catch {
    return undefined;
  }
}

const token = await dashboardToken();
const headers = { accept: 'application/json' };
if (apiKey) headers.authorization = `Bearer ${apiKey}`;
else if (token) {
  headers.origin = dashboardOrigin;
  headers['x-omnihilbras-dashboard-token'] = token;
}

async function call(path, init = {}) {
  const response = await fetch(`${gateway}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  const body = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} answered ${response.status}: ${body?.error?.message ?? 'no reason'}`);
  return body;
}

const connections = (await call('/v1/connections')).data
  .filter((connection) => connection.enabled !== false && connection.hasCredential !== false)
  .filter((connection) => !providerFilter || connection.providerId === providerFilter);

const report = [];
for (const connection of connections) {
  const before = Array.isArray(connection.modelIds) ? connection.modelIds.length : 0;
  const startedAt = Date.now();
  try {
    const updated = await call(`/v1/connections/${encodeURIComponent(connection.id)}/models/refresh`, { method: 'POST' });
    const after = Array.isArray(updated.modelIds) ? updated.modelIds.length : 0;
    report.push({
      providerId: connection.providerId,
      connectionId: connection.id,
      status: 'ok',
      before,
      after,
      added: Math.max(0, after - before),
      removed: Math.max(0, before - after),
      modelsRefreshedAt: updated.catalogRefreshedAt,
      durationMs: Date.now() - startedAt,
    });
    console.log(`${connection.providerId}/${connection.id}: ${before} → ${after} models (${Date.now() - startedAt} ms)`);
  } catch (error) {
    report.push({
      providerId: connection.providerId,
      connectionId: connection.id,
      status: 'unverified',
      before,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    });
    console.log(`${connection.providerId}/${connection.id}: UNVERIFIED — ${error instanceof Error ? error.message : String(error)}`);
  }
}

const verified = report.filter((entry) => entry.status === 'ok').length;
const unverified = report.length - verified;
console.log(`\nverified ${verified}, unverified ${unverified}, total ${report.length}`);
if (jsonPath) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(jsonPath, `${JSON.stringify({ gateway, at: new Date().toISOString(), verified, unverified, report }, null, 2)}\n`, 'utf8');
  console.log(`report written to ${jsonPath}`);
}
if (unverified > 0) process.exitCode = 1;
