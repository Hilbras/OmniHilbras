/**
 * `omnihilbras providers` — every saved account, and which ones can actually serve.
 *
 * This is the verb that makes the multi-account model legible. A provider is a card; an **account** is a
 * connection, and the gateway routes per account. So the listing is by connection, and it says the three
 * things that decide which one answers next: whether it is enabled, its priority, and whether it is
 * ejected or cooling down right now.
 */

export const providers = {
  name: 'providers',
  summary: 'List saved accounts, with their routing state',
  usage: 'omnihilbras providers [provider] [--all] [--json]',
  flags: ['--all'],
  async run({ client, out, args }) {
    const wanted = args[0];
    const [connections, routing] = await Promise.all([client.request('/v1/connections'), client.request('/v1/routing')]);
    const rows = Array.isArray(connections?.data) ? connections.data : [];
    const live = new Map((routing?.connections ?? []).map((entry) => [entry.connectionId, entry]));

    const filtered = wanted ? rows.filter((row) => row.providerId === wanted || row.id === wanted) : rows;
    if (wanted && filtered.length === 0) {
      out.line(`No account matches ${out.warn(wanted)}. Run \`omnihilbras providers\` to see them all.`);
      return 1;
    }

    // Grouped by provider, because "how many accounts does this have left" is the question, and a flat
    // list of 53 connections buries it.
    const accounts = filtered.map((row) => {
      const state = live.get(row.id);
      return {
        providerId: row.providerId,
        connectionId: row.id,
        name: row.name,
        enabled: row.enabled !== false,
        priority: row.priority,
        credential: row.hasCredential ? row.credentialType ?? 'stored' : 'none',
        models: Array.isArray(row.modelIds) ? row.modelIds.length : 0,
        ...(state?.ejected ? { ejected: true } : {}),
        ...(state?.rateLimitWaitMs ? { rateLimitWaitMs: state.rateLimitWaitMs } : {}),
        ...(state?.lastError ? { lastError: state.lastError } : {}),
      };
    });

    out.data(accounts);
    if (out.json) return 0;

    const byProvider = new Map();
    for (const account of accounts) {
      const list = byProvider.get(account.providerId) ?? [];
      list.push(account);
      byProvider.set(account.providerId, list);
    }

    out.title(`${accounts.length} account${accounts.length === 1 ? '' : 's'} across ${byProvider.size} provider${byProvider.size === 1 ? '' : 's'}`);
    out.line();
    for (const [providerId, list] of byProvider) {
      // A provider with several accounts is the interesting case, so it is the one that gets a header.
      out.line(list.length > 1 ? `${out.ok(providerId)} ${out.muted(`(${list.length} accounts)`)}` : out.muted(providerId));
      out.table(list.map((account) => [
        account.connectionId,
        account.enabled ? out.ok('on') : out.warn('paused'),
        `p${account.priority}`,
        `${account.models} models`,
        account.credential,
        account.ejected ? out.bad('ejected') : '',
        account.lastError ? out.muted(String(account.lastError).slice(0, 46)) : '',
      ]), ['account', 'state', 'prio', 'models', 'credential', 'ejected', 'last error']);
      out.line();
    }
    return 0;
  },
};
