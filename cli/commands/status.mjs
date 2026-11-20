/**
 * `omnihilbras status` — is the gateway up, what is it, and what is wrong with it.
 *
 * The verb a person runs first and a script runs before anything else. It answers in one shot what
 * otherwise takes a health URL, a version and a screenshot of the routing page.
 */

import { CliError } from '../lib/client.mjs';

export const status = {
  name: 'status',
  summary: 'Is the gateway up, and what is it reporting',
  usage: 'omnihilbras status [--json]',
  flags: ['--strict'],
  async run({ client, out, flags }) {
    const health = await client.request('/health');
    // `degraded` is not a failure: a provider with no credential reports itself unavailable, and that is
    // the normal state of an installation that has not connected everything. It is reported, not thrown.
    const providers = Array.isArray(health.providers) ? health.providers : [];
    const unhealthy = providers.filter((provider) => provider.status !== 'healthy');

    out.data({
      service: health.service,
      version: health.build?.version,
      startedAt: health.build?.startedAt,
      status: health.status,
      checkedAt: health.checkedAt,
      providers: providers.length,
      unavailable: unhealthy.map((provider) => ({ providerId: provider.providerId, status: provider.status, message: provider.message })),
      gateway: client.baseUrl,
      auth: client.auth.kind,
    });

    const dot = health.status === 'healthy' ? out.ok('●') : out.warn('●');
    out.box(
      `${dot} ${health.service ?? 'gateway'} ${health.build?.version ?? ''}`.trim(),
      [
        `${out.muted('url')}        ${client.baseUrl}`,
        `${out.muted('started')}    ${health.build?.startedAt ?? 'unknown'}`,
        `${out.muted('auth')}       ${client.auth.kind === 'none' ? out.warn('none (no key and no dashboard token found)') : client.auth.kind}`,
        `${out.muted('providers')}  ${providers.length - unhealthy.length}/${providers.length} reporting healthy`,
      ],
    );

    if (unhealthy.length > 0) {
      out.line();
      out.line(out.muted('Not healthy (a missing credential is expected until that provider is connected):'));
      out.table(unhealthy.map((provider) => [provider.providerId, provider.status, String(provider.message ?? '').slice(0, 70)]), ['provider', 'status', 'says']);
    }

    if (flags.strict && unhealthy.length > 0) {
      throw new CliError(`${unhealthy.length} provider${unhealthy.length === 1 ? '' : 's'} not healthy.`, { hint: 'Run without --strict to report and continue.' });
    }
    return 0;
  },
};
