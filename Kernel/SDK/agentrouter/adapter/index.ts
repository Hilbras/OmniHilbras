import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from '@omnihilbras/sdk-openai';

/** AgentRouter's own adapter. Its base URL and id live here, not in a dashboard card. */
export const agentrouterProviderId = 'agentrouter';

export type AgentrouterAdapterOptions = OpenAICompatibleAdapterOptions & {
  /** Client-identity headers, supplied by the gateway from its configuration. */
  headers?: Record<string, string>;
};

export class AgentrouterAdapter extends OpenAICompatibleAdapter {
  constructor(options: AgentrouterAdapterOptions = {}) {
    super({
      id: 'agentrouter',
      name: 'AgentRouter',
      baseUrl: 'https://agentrouter.org/v1',
      auth: { header: 'Authorization', prefix: 'Bearer' },
      ...(options.headers ? { headers: options.headers } : {}),
    }, options);
  }
}
