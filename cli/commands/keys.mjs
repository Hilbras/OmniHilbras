/**
 * `omnihilbras keys` — the gateway's own API keys, and minting a new one.
 *
 * The secret is returned **once**, at creation, by the gateway itself (`POST /v1/keys`); nothing can read
 * it back afterwards. So this verb prints it exactly once, to stdout only, with the sentence that says so
 * — and never writes it anywhere. The old project printed a new key's secret in a log line that also
 * carried the key's metadata, which is how a secret ends up in a ticket.
 */

export const keys = {
  name: 'keys',
  summary: 'List gateway API keys, or mint one',
  usage: 'omnihilbras keys [--mint <name>] [--json]',
  flags: ['--mint'],
  async run({ client, out, flags }) {
    if (flags.mint) {
      const created = await client.request('/v1/keys', { method: 'POST', body: { name: flags.mint } });
      const record = created?.key ?? created;
      // `--json` still carries it: a script that asked for JSON asked for the whole answer, and
      // withholding a field from it would make the flag mean "something else, sometimes".
      out.data(record);
      if (!out.json) {
        out.title(`Created ${record.name ?? flags.mint}`);
        out.line(`  ${out.muted('id')}     ${record.id}`);
        out.line(`  ${out.muted('prefix')} ${record.prefix}`);
        out.line();
        out.line(out.warn('The secret is shown once and cannot be read back:'));
        out.line(`  ${record.secret}`);
      }
      return 0;
    }

    const listed = await client.request('/v1/keys');
    const records = Array.isArray(listed?.keys) ? listed.keys : [];
    out.data({ requireApiKey: listed?.requireApiKey ?? false, keys: records });
    if (out.json) return 0;

    out.title(`${records.length} key${records.length === 1 ? '' : 's'} ${listed?.requireApiKey ? '(enforcement on)' : '(enforcement off)'}`);
    if (records.length === 0) {
      out.line(out.muted('None yet. `omnihilbras keys --mint <name>` creates one.'));
      return 0;
    }
    out.line();
    out.table(records.map((key) => [key.id, key.name, key.prefix, key.enabled === false ? out.warn('paused') : out.ok('on'), key.createdAt ?? '']), ['id', 'name', 'prefix', 'state', 'created']);
    return 0;
  },
};
