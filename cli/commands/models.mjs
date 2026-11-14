/**
 * `omnihilbras models` — what the gateway will serve, grouped by provider prefix.
 *
 * The ids here are the ones a client pastes into its config (`zc/glm-5.3-flash`), so this is also the
 * verb that answers "what do I write in my editor".
 */

export const models = {
  name: 'models',
  summary: 'List the model ids the gateway serves',
  usage: 'omnihilbras models [--provider <id>] [--json]',
  flags: ['--provider', '--limit'],
  async run({ client, out, flags }) {
    const list = await client.request('/v1/models');
    const entries = Array.isArray(list?.data) ? list.data : [];

    const grouped = new Map();
    for (const entry of entries) {
      const id = String(entry.id ?? '');
      const prefix = id.includes('/') ? id.slice(0, id.indexOf('/')) : '(bare)';
      if (flags.provider && prefix !== flags.provider) continue;
      const bucket = grouped.get(prefix) ?? [];
      bucket.push({ id, ...(entry.owned_by ? { owner: entry.owned_by } : {}), ...(entry.provider ? { provider: entry.provider } : {}) });
      grouped.set(prefix, bucket);
    }

    const total = [...grouped.values()].reduce((sum, bucket) => sum + bucket.length, 0);
    out.data({ total, prefixes: Object.fromEntries([...grouped].map(([prefix, bucket]) => [prefix, bucket.map((entry) => entry.id)])) });
    if (out.json) return 0;

    out.title(`${total} model${total === 1 ? '' : 's'} in ${grouped.size} group${grouped.size === 1 ? '' : 's'}`);
    out.line();
    // Sorted by size: the group with a hundred ids is the one a person is scrolling for.
    for (const [prefix, bucket] of [...grouped].sort((left, right) => right[1].length - left[1].length)) {
      out.line(`${out.ok(prefix)} ${out.muted(`(${bucket.length})`)}`);
      for (const entry of bucket.slice(0, flags.limit ?? 8)) out.line(`  ${entry.id}`);
      if (bucket.length > (flags.limit ?? 8)) out.line(out.muted(`  … and ${bucket.length - (flags.limit ?? 8)} more (--limit to show more)`));
      out.line();
    }
    return 0;
  },
};
