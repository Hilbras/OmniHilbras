import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from '@omnihilbras/sdk-openai';

/** AgentRouter's own adapter. Its base URL and id live here, not in a dashboard card. */
export const agentrouterProviderId = 'agentrouter';

export type AgentrouterAdapterOptions = OpenAICompatibleAdapterOptions & {
  /** Client-identity headers, supplied by the gateway from its configuration. */
  headers?: Record<string, string>;
  /**
   * The Responses lane this relay serves for part of its catalog.
   *
   * Without it the adapter has no second lane: the provider's own "use /v1/responses" refusal is thrown
   * straight to the caller instead of switching the model to the endpoint that serves it. The gateway
   * supplies the measured path from `provider-responses-lane.ts`, so the same fact is not stated twice.
   */
  responsesPath?: string;
};

export class AgentrouterAdapter extends OpenAICompatibleAdapter {
  constructor(options: AgentrouterAdapterOptions = {}) {
    super({
      id: 'agentrouter',
      name: 'AgentRouter',
      baseUrl: 'https://agentrouter.org/v1',
      auth: { header: 'Authorization', prefix: 'Bearer' },
      ...(options.headers ? { headers: options.headers } : {}),
      ...(options.responsesPath ? { responsesPath: options.responsesPath } : {}),
    }, options);
  }
}
