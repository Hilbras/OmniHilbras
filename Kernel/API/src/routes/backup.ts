import { invalidRequest, isRecord, readJsonBody, readRequiredString, sendJson } from '../core/http.js';
import type { RouteContext } from './route-context.js';

const maxBackupBytes = 25 * 1024 * 1024;

/**
 * Encrypted backup export and import.
 *
 * The envelope is encrypted in the gateway, with a passphrase the gateway does not store. That is the
 * only shape in which provider credentials leave the vault.
 */
export async function handleBackupRoute(ctx: RouteContext): Promise<boolean> {
  const { request, response, url, service, origin, signal } = ctx;
  if (!url.pathname.startsWith('/v1/backup')) return false;

  if (request.method === 'POST' && url.pathname === '/v1/backup/export') {
    const body = await readJsonBody(request, 64 * 1024);
    if (!isRecord(body)) throw invalidRequest('Request body must be a JSON object.');
    const passphrase = readRequiredString(body, 'passphrase');
    const backup = await service.exportBackup(passphrase);
    sendJson(response, 200, { backup }, origin);
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/v1/backup/import') {
    const body = await readJsonBody(request, maxBackupBytes);
    if (!isRecord(body)) throw invalidRequest('Request body must be a JSON object.');
    if (body.confirmReplace !== true) {
      throw invalidRequest('Import replaces every connection and API key. Send confirmReplace: true to proceed.');
    }
    const passphrase = readRequiredString(body, 'passphrase');
    if (!isRecord(body.backup)) throw invalidRequest('backup must be an envelope object.');
    const result = await service.importBackup(passphrase, body.backup);
    sendJson(response, 200, result, origin);
    return true;
  }

  void signal;
  return false;
}
