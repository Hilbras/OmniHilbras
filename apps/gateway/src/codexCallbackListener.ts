import { createServer, type Server } from 'node:http';

/**
 * The loopback listener a registered Codex redirect URI actually points at.
 *
 * The public Codex CLI client registers `http://localhost:1455/auth/callback`, which is not the
 * gateway's own port. A provider therefore redirects the browser to a port this process does not
 * otherwise serve, and the sign-in silently never completes unless something is listening there.
 *
 * It is opened when a sign-in starts and closed the moment the callback lands or the session
 * expires, so the port is not held for the gateway's lifetime — a fixed port that stayed bound
 * would collide with every other tool that wants it.
 */
export class CodexCallbackListener {
  private server?: Server;
  private closing = false;

  constructor(private readonly handle: (pathname: string, params: URLSearchParams) => Promise<{ ok: boolean; message: string }>) {}

  /**
   * Bind the redirect port, or reuse the listener already open on it.
   *
   * A busy port is an error the caller must hear about: the browser is about to be sent to a URL
   * nobody is serving, and the sign-in would fail with no explanation.
   */
  async open(port: number, host: string): Promise<void> {
    if (this.server?.listening) return;
    const server = createServer((request, response) => {
      void this.serve(request.method, request.url ?? '/', response);
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
    this.server = server;
  }

  private async serve(method: string | undefined, rawUrl: string, response: import('node:http').ServerResponse): Promise<void> {
    const url = new URL(rawUrl, 'http://localhost');
    if (method !== 'GET') {
      response.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' }).end('Method not allowed');
      return;
    }
    let outcome: { ok: boolean; message: string };
    try {
      outcome = await this.handle(url.pathname, url.searchParams);
    } catch {
      outcome = { ok: false, message: 'The gateway could not complete the sign-in. Start again from OmniHilbras.' };
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(renderCallbackPage(outcome.ok, outcome.message));
    this.close();
  }

  close(): void {
    this.closing = true;
    const server = this.server;
    this.server = undefined;
    server?.close();
    if (this.closing) this.closing = false;
  }
}

/**
 * The page the browser lands on. It states the outcome and nothing else: no code, no state, no
 * credential, and no configuration detail — the same contract the gateway's own callback page keeps.
 */
export function renderCallbackPage(ok: boolean, message: string): string {
  const safeMessage = /^[\S ]{1,300}$/.test(message) && !/[<>]/.test(message)
    ? message
    : 'The sign-in could not be completed.';
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${ok ? 'Codex connected' : 'Codex sign-in failed'}</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b0d10; color: #e6e8eb;
         font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width: min(520px, calc(100% - 2rem)); text-align: center; }
  h1 { font-size: 1.2rem; margin: 0 0 .5rem; }
  p { margin: 0; color: #aeb4bb; }
</style>
<main>
  <h1>${ok ? 'Codex connected' : 'Codex sign-in failed'}</h1>
  <p>${safeMessage}</p>
</main>
</html>`;
}
