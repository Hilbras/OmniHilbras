/**
 * `omnihilbras logs` — follow the gateway's finished requests.
 *
 * `GET /v1/logs/stream` is a server-sent event stream carrying one record per finished request: time,
 * model, provider, connection, outcome, error code, attempt count, request id. It carries **no message
 * content, prompt or credential**, which is what makes it safe to pipe somewhere.
 *
 * The stream is plain text lines, so `--json` here means "one JSON object per line" rather than one array
 * — a follower never finishes, and an array would never close.
 */

import { CliError } from '../lib/client.mjs';

export const logs = {
  name: 'logs',
  summary: 'Stream finished requests (no prompt content)',
  usage: 'omnihilbras logs [--json] [--limit <n>]',
  flags: ['--limit'],
  async run({ client, out, flags }) {
    const response = await client.request('/v1/logs/stream', { raw: true });
    if (!response.body) throw new CliError('The gateway accepted the request but sent no stream body.');

    const limit = flags.limit ?? 0;
    let seen = 0;
    const decoder = new TextDecoder();
    let buffer = '';

    // Cancelled by Ctrl-C, which is the only way a follower ends. The exit code for that is 130, the
    // shell's own convention for an interrupted command.
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);

    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        // SSE frames are separated by a blank line; a chunk boundary can fall anywhere, so the tail is
        // kept until the next newline rather than parsed as if it were complete.
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const payload = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('');
          if (!payload) continue;
          let record;
          try {
            record = JSON.parse(payload);
          } catch {
            continue;
          }
          if (out.json) out.data(record);
          else {
            const when = String(record.at ?? record.timestamp ?? '').slice(11, 19);
            const outcome = record.outcome === 'success' ? out.ok('ok') : out.bad(String(record.outcome ?? 'failed'));
            out.line(`${out.muted(when)} ${outcome} ${record.providerId ?? '?'}/${record.model ?? '?'} ${out.muted(`attempts=${record.attempts ?? 1}`)} ${record.connectionId ? out.muted(`conn=${record.connectionId}`) : ''}${record.errorCode ? ` ${out.bad(record.errorCode)}` : ''}`);
          }
          seen += 1;
          if (limit > 0 && seen >= limit) return 0;
        }
      }
    } catch (error) {
      if (controller.signal.aborted) return 0;
      throw error;
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
    return 0;
  },
};
