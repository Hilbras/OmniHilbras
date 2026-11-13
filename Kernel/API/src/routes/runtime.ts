import type { RouteContext } from './route-context.js';
import { readJsonBody, sendJson } from '../core/http.js';
import { ProviderError } from '../core/provider-error.js';
import { ensureOpencodeService, installOpencodeRuntime, opencodeRuntimeStatus, readOpencodeInstallRecord, type OpencodeRuntimeOptions } from '../core/opencode-runtime.js';

/**
 * The OpenCode runtime: is it here, install it, start it.
 *
 * `opencode-console`'s free models are served only through the OpenCode client's own service, and a
 * device that has never seen OpenCode has no such service. These routes are how that gap is closed
 * from the dashboard instead of by reading a README: the gateway downloads the official release into
 * its own data directory, and starts it on demand.
 */

const runtimePrefix = '/v1/runtime/opencode';

function runtimeOptions(ctx: RouteContext): OpencodeRuntimeOptions {
  const dataDir = (ctx.service as unknown as { config?: { dataDir?: string } })?.config?.dataDir;
  return dataDir ? { dataDir } : {};
}

async function status(ctx: RouteContext) {
  const runtime = runtimeOptions(ctx);
  const status = await opencodeRuntimeStatus(runtime);
  const record = await readOpencodeInstallRecord(runtime);
  return { ...status, ...(record ? { install: record } : {}) };
}

export async function handleRuntimeRoute(ctx: RouteContext): Promise<boolean> {
  const { request, response, url, origin, options } = ctx;

  if (url.pathname !== runtimePrefix && !url.pathname.startsWith(`${runtimePrefix}/`)) return false;

  if (request.method === 'GET' && url.pathname === runtimePrefix) {
    sendJson(response, 200, await status(ctx), origin);
    return true;
  }

  if (request.method === 'POST' && url.pathname === `${runtimePrefix}/install`) {
    /**
     * The body is optional, and reading one that is not there is an error in `readJsonBody`
     * ("Request body is required.") — which turned `POST /install` with no body into a `400` for
     * anyone who had nothing to say except "install the current release".
     */
    const declaresBody = Boolean(request.headers['transfer-encoding']) || Number(request.headers['content-length'] ?? 0) > 0;
    const body = declaresBody ? await readJsonBody(request, Math.min(options.maxBodyBytes ?? 4096, 4096)) : undefined;
    const version = (body as { version?: unknown } | undefined)?.version;
    if (version !== undefined && (typeof version !== 'string' || !/^\d+\.\d+\.\d+[\w.-]*$/.test(version))) {
      throw new ProviderError('INVALID_REQUEST', 'version must look like 1.2.3.', { publicMessage: 'version must look like 1.2.3.' });
    }
    try {
      const installed = await installOpencodeRuntime({ ...runtimeOptions(ctx), ...(typeof version === 'string' ? { version } : {}) });
      sendJson(response, 200, { ...(await status(ctx)), installedVersion: installed.reportedVersion ?? installed.version }, origin);
    } catch (error) {
      // The install reaches the network and unpacks an archive, so its failure has to name the step
      // that failed rather than collapse into "the request failed".
      const message = error instanceof Error ? error.message : String(error);
      throw new ProviderError('PROVIDER_REQUEST_FAILED', `OpenCode runtime install failed: ${message}`, { publicMessage: message, cause: error });
    }
    return true;
  }

  if (request.method === 'POST' && url.pathname === `${runtimePrefix}/start`) {
    const endpoint = await ensureOpencodeService(runtimeOptions(ctx));
    if (!endpoint) {
      throw new ProviderError('PROVIDER_REQUEST_FAILED', 'No OpenCode runtime is available to start.', {
        publicMessage: 'No OpenCode runtime is installed on this machine. Install it first, or set OMNIHILBRAS_OPENCODE_BINARY to a binary you already have.',
      });
    }
    sendJson(response, 200, await status(ctx), origin);
    return true;
  }

  return false;
}
