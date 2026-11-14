/**
 * `omnihilbras test` — prove one account, or every account of a provider.
 *
 * The dashboard's per-row Test button calls `POST /v1/connections/:id/probe`; this is the same call, so
 * the two cannot disagree about what "this account works" means. Testing **all** accounts is the default
 * for a provider with several, because "the provider's first account is fine" is the answer that made a
 * working sibling invisible.
 */

import { CliError } from '../lib/client.mjs';

/** The pause between probes. Long enough not to look like a burst, short enough not to feel broken. */
const proberGapMs = 400;

export const test = {
  name: 'test',
  summary: 'Probe one account, or every account of a provider',
  usage: 'omnihilbras test <provider|account> [--all] [--json]',
  flags: ['--all'],
  async run({ client, out, args, flags }) {
    const target = args[0];
    if (!target) throw new CliError('`test` needs a provider or an account id.', { code: 2, hint: 'Try `omnihilbras providers` to see the ids.' });

    const connections = await client.request('/v1/connections');
    const all = Array.isArray(connections?.data) ? connections.data : [];
    const matches = all.filter((row) => row.id === target || row.providerId === target);
    if (matches.length === 0) {
      throw new CliError(`No account or provider matches ${target}.`, { hint: 'Run `omnihilbras providers` to see the ids.' });
    }
    // An explicit account id tests exactly that account. A provider id tests every account it has, unless
    // one of them *is* the provider id — which is how the first account is saved — and then that one is
    // still only one of several.
    const targets = flags.all || matches.every((row) => row.providerId === target) ? matches : matches.slice(0, 1);

    /**
     * **One at a time, with a gap.** This used to be `Promise.all`, and the probe is a real request to the
     * provider for each account: testing a provider with four accounts meant four logins' worth of traffic
     * from one address in the same instant. That is the shape providers describe as unusual activity —
     * CodeBuddy answers it with `403 11140 request illegal` and restricts the account — so a command whose
     * job is to find out which accounts still work should not be the thing that gets them restricted.
     */
    const results = [];
    for (const row of targets) {
      if (results.length > 0) await new Promise((resolve) => setTimeout(resolve, proberGapMs));
      try {
        const probe = await client.request(`/v1/connections/${encodeURIComponent(row.id)}/probe`, { method: 'POST' });
        results.push({ connectionId: row.id, providerId: row.providerId, enabled: row.enabled !== false, valid: probe.valid !== false, latencyMs: probe.latencyMs });
      } catch (error) {
        // One account refusing is a result, not a reason to abandon the others: the whole point of testing
        // every account is to find the one that still works.
        results.push({ connectionId: row.id, providerId: row.providerId, enabled: row.enabled !== false, valid: false, message: error instanceof Error ? error.message : String(error) });
      }
    }

    out.data(results);
    if (out.json) return results.some((result) => result.valid) ? 0 : 1;

    out.title(`Tested ${results.length} account${results.length === 1 ? '' : 's'}`);
    out.table(results.map((result) => [
      result.connectionId,
      result.valid ? out.ok('accepted') : out.bad('refused'),
      result.latencyMs === undefined ? '' : `${result.latencyMs} ms`,
      result.message ? out.muted(String(result.message).slice(0, 60)) : '',
    ]), ['account', 'result', 'latency', 'says']);

    const working = results.filter((result) => result.valid).length;
    out.line();
    out.line(working > 0 ? out.ok(`${working} of ${results.length} can serve.`) : out.bad('None of them can serve.'));
    return working > 0 ? 0 : 1;
  },
};
