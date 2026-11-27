import type { RouteContext } from './route-context.js';
import { renderPrometheusMetrics } from '../core/metrics.js';
import { gatewayBuild } from '../core/build-info.js';

/**
 * `GET /metrics` — the gateway in Prometheus's text exposition format.
 *
 * ## Why this exists at all
 *
 * `/v1/usage` answers "what has this cost and what happened", for a person looking at a page. Nothing answered for a
 * machine watching a gateway at three in the morning, and `grep prometheus|/metrics Kernel/API/src` returned nothing
 * before this file: an operator could see that a provider was failing only by opening the dashboard, and could not
 * alert on it at all.
 *
 * ## What it is not
 *
 * Not a second bookkeeping path. Every number is rendered from the usage records the gateway already writes, so
 * `/metrics` and `/v1/usage` cannot disagree — they are two renderings of one store. If the store is absent, the
 * endpoint still answers (a gateway with no `usageStore` is a supported configuration) and says so through the
 * absence of the series rather than inventing zeros: only `omnihilbras_up` and `omnihilbras_build_info` appear.
 *
 * ## Auth
 *
 * This is a management path: it names every provider the gateway can reach and how they are failing, which is
 * reconnaissance for anyone who can read it. It sits behind the same gate as `/v1/usage` rather than being open on the
 * loopback interface.
 */
export const metricsPath = '/metrics';

export async function handleMetricsRoute(context: RouteContext): Promise<boolean> {
  const { request, response, url, service, origin } = context;
  // Positive form on purpose: the route-documentation guard resolves `url.pathname === <const>`, and a path written
  // as a `!==` early-return is a route the guard cannot see — which is how a route goes undocumented by accident.
  if (request.method === 'GET' && url.pathname === metricsPath) {
    // handled below
  } else {
    return false;
  }

  const records = await service.usage?.list({ limit: Number.MAX_SAFE_INTEGER }) ?? [];
  const body = renderPrometheusMetrics({ records, version: gatewayBuild().version, budget: service.budgetMetrics() });

  if (origin) {
    response.setHeader('access-control-allow-origin', origin);
    response.setHeader('access-control-expose-headers', 'x-request-id');
  }
  response.writeHead(200, {
    // The registered content type, not `text/plain`: a scraper that honours it will parse, and one that does not
    // still gets the bytes. `no-store` because a cached scrape is a lie about the present.
    'content-type': 'text/plain; version=0.0.4; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
  return true;
}
