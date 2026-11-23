import { providerClientHeaders } from './provider-client-identity.js';
import { providerResponsesPath } from './provider-responses-lane.js';
import type { ProviderAdapter } from './index.js';
import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from '@omnihilbras/sdk-openai';
import type { CredentialValidationStrategy } from './provider-resolver.js';

import { AgnesAiAdapter } from '@omnihilbras/sdk-agnes-ai';
import { AgentrouterAdapter } from '@omnihilbras/sdk-agentrouter';
import { AionLabsAdapter } from '@omnihilbras/sdk-aion-labs';
import { OneHundredMillionSeekAdapter } from '@omnihilbras/sdk-100milionseek';
import { NumesAdapter } from '@omnihilbras/sdk-numes';
import { KiraaiAdapter } from '@omnihilbras/sdk-kiraai';
import { VengeticAdapter } from '@omnihilbras/sdk-vengetic';
import { AnyrouterAdapter } from '@omnihilbras/sdk-anyrouter';
import { ZroAdapter } from '@omnihilbras/sdk-zro';
import { UnorouterAdapter } from '@omnihilbras/sdk-unorouter';
import { OllamaAdapter } from '@omnihilbras/sdk-ollama';
import { MistralAdapter } from '@omnihilbras/sdk-mistral';
import { NaraRouterAdapter } from '@omnihilbras/sdk-nara-router';
import { TokenharborAdapter } from '@omnihilbras/sdk-tokenharbor';
import { ApinexAdapter } from '@omnihilbras/sdk-apinex';
import { TiarinaAdapter } from '@omnihilbras/sdk-tiarina';
import { XkiroAdapter } from '@omnihilbras/sdk-xkiro';
import { KimiAdapter } from '@omnihilbras/sdk-kimi';
import { DeepseekAdapter } from '@omnihilbras/sdk-deepseek';
import { QwenAdapter } from '@omnihilbras/sdk-qwen';
import { QwenTokenPlanAdapter } from '@omnihilbras/sdk-qwen-token-plan';
import { GroqAdapter } from '@omnihilbras/sdk-groq';
import { GrokAdapter } from '@omnihilbras/sdk-grok';
import { NvidiaAdapter } from '@omnihilbras/sdk-nvidia';
import { CoarenaAdapter } from '@omnihilbras/sdk-coarena';
import { XaiAdapter } from '@omnihilbras/sdk-xai';

/** One own adapter per provider id that had no dedicated package before phase 2. */
export type OwnAdapterOptions = { endpoint?: string; transport?: OpenAICompatibleAdapterOptions['transport'] };

/**
 * A factory and the answer its provider can honestly give to a Check request.
 *
 * `validation` used to be scattered across service registrations, so a provider whose catalog is
 * public could inherit a "list models" check that accepted any string as a key. Keeping the strategy
 * beside the factory makes the two impossible to drift apart: a row declares both what it builds and
 * what that thing can prove. `none` is the default decision, never the absence of a decision.
 */
export type OwnAdapterEntry = {
  create: (options?: OwnAdapterOptions) => ProviderAdapter;
  validation: CredentialValidationStrategy;
};

/** Forward only the options an adapter actually accepts; the rest keep their zero-argument shape. */
const withTransport = (options?: OwnAdapterOptions): OpenAICompatibleAdapterOptions =>
  options?.transport ? { transport: options.transport } : {};

/**
 * A keyed OpenAI-compatible router with no dedicated SDK package.
 *
 * `validation: 'none'` is declared, not inherited: these routers publish a catalog that answers a
 * bogus key, so an authenticated-catalog Check would report green for any string. The card says API
 * key and the gateway sends it; proving it belongs to a person is the model request's job.
 */
const openAiRouter = (id: string, name: string, baseUrl: string): OwnAdapterEntry => ({
  validation: 'none',
  create: (options) => new OpenAICompatibleAdapter({
    id, name, baseUrl: options?.endpoint ?? baseUrl,
  }, withTransport(options)),
});

export const OWN_PROVIDER_ADAPTERS: Readonly<Record<string, OwnAdapterEntry>> = Object.freeze({
  'agnes-ai': { validation: 'none', create: (options) => new AgnesAiAdapter(withTransport(options)) },
  // AgentRouter gates on a client identity. Its own package owns the adapter; the gateway supplies the
  // environment-configured identity, so a host override still reaches the wire.
  'agentrouter': { validation: 'none', create: (options) => new AgentrouterAdapter({
    headers: providerClientHeaders('agentrouter'),
    // The dedicated adapter used to miss this, so a model whose refusal named /responses was thrown
    // back to the caller instead of being retried on the lane that serves it.
    ...(providerResponsesPath('agentrouter') ? { responsesPath: providerResponsesPath('agentrouter') } : {}),
    ...withTransport(options),
  }) },
  'aion-labs': { validation: 'credential', create: (options) => new AionLabsAdapter({ ...withTransport(options), ...(options?.endpoint ? { endpoint: options.endpoint } : {}) }) },
  '100milionseek': { validation: 'none', create: (options) => new OneHundredMillionSeekAdapter({ ...withTransport(options), ...(options?.endpoint ? { endpoint: options.endpoint } : {}) }) },
  'numes': { validation: 'none', create: (options) => new NumesAdapter(withTransport(options)) },
  'kiraai': { validation: 'none', create: (options) => new KiraaiAdapter(withTransport(options)) },
  'vengetic': { validation: 'credential', create: (options) => new VengeticAdapter(withTransport(options)) },
  'anyrouter': { validation: 'none', create: (options) => new AnyrouterAdapter(withTransport(options)) },
  'zro': { validation: 'none', create: (options) => new ZroAdapter(withTransport(options)) },
  'unorouter': { validation: 'none', create: (options) => new UnorouterAdapter(withTransport(options)) },
  'ollama': { validation: 'none', create: (options) => new OllamaAdapter({ ...withTransport(options), ...(options?.endpoint ? { endpoint: options.endpoint } : {}) }) },
  'mistral': { validation: 'none', create: (options) => new MistralAdapter(withTransport(options)) },
  'nara-router': { validation: 'none', create: (options) => new NaraRouterAdapter(withTransport(options)) },
  'tokenharbor': { validation: 'none', create: (options) => new TokenharborAdapter(withTransport(options)) },
  'apinex': { validation: 'none', create: (options) => new ApinexAdapter(withTransport(options)) },
  'tiarina': { validation: 'none', create: (options) => new TiarinaAdapter(withTransport(options)) },
  'xkiro': { validation: 'none', create: (options) => new XkiroAdapter(withTransport(options)) },
  'kimi': { validation: 'none', create: (options) => new KimiAdapter(withTransport(options)) },
  'deepseek': { validation: 'none', create: (options) => new DeepseekAdapter(withTransport(options)) },
  'qwen': { validation: 'none', create: (options) => new QwenAdapter(withTransport(options)) },
  'qwen-token-plan': { validation: 'none', create: (options) => new QwenTokenPlanAdapter(withTransport(options)) },
  'groq': { validation: 'none', create: (options) => new GroqAdapter(withTransport(options)) },
  'grok': { validation: 'none', create: (options) => new GrokAdapter(withTransport(options)) },
  // NVIDIA's catalog is public, so `none` would be a lie in the other direction: the adapter proves
  // the key with a real 1-token inference. This is why the strategy lives beside the factory.
  'nvidia': { validation: 'credential', create: (options) => new NvidiaAdapter(withTransport(options)) },
  'coarena': { validation: 'none', create: (options) => new CoarenaAdapter(withTransport(options)) },
  'together': openAiRouter('together', 'Together AI', 'https://api.together.xyz/v1'),
  'fireworks': openAiRouter('fireworks', 'Fireworks AI', 'https://api.fireworks.ai/inference/v1'),
  // Cycle-4's small, honest slice of the 115-id provider gap: five API-key OpenAI-compatible routers
  // that 9router already serves with a plain key and no browser impersonation. Their hosts come from
  // the corresponding registry entries; no client identity, OAuth, live validation or measured card
  // field is copied with them. `openAiRouter` declares `validation: 'none'` beside each factory.
  'sambanova': openAiRouter('sambanova', 'SambaNova', 'https://api.sambanova.ai/v1'),
  'cerebras': openAiRouter('cerebras', 'Cerebras', 'https://api.cerebras.ai/v1'),
  'siliconflow': openAiRouter('siliconflow', 'SiliconFlow', 'https://api.siliconflow.com/v1'),
  'nebius': openAiRouter('nebius', 'Nebius AI', 'https://api.studio.nebius.ai/v1'),
  'perplexity': openAiRouter('perplexity', 'Perplexity', 'https://api.perplexity.ai'),
  // Cycle 5's one honest slice of the remaining backlog: `glm` is a paid Z.ai coding-plan API key on
  // the plain OpenAI chat wire. The base stops at /v4 because the shared adapter appends
  // /chat/completions, giving https://api.z.ai/api/coding/paas/v4/chat/completions. The reference's
  // Claude-header lane, forged CLI identity and ZCode OAuth grant are deliberately not ported; this
  // id is a separate product from the `zcode` Start Plan card. `validation: 'none'` is declared beside
  // the factory because a public catalog cannot prove a pasted key is the caller's.
  'glm': openAiRouter('glm', 'Z.ai GLM Coding', 'https://api.z.ai/api/coding/paas/v4'),
  // xAI has its own SDK package because its video-job surface is not the shared chat wire. `none` is
  // declared, not inherited: no authenticated credential check was measured, and xAI's catalog is
  // public enough that a bogus key would look valid. Its own id keeps its own vault entry.
  'xai': {
    validation: 'none',
    create: (options) => new XaiAdapter({ ...(options?.endpoint ? { endpoint: options.endpoint } : {}), ...withTransport(options) }),
  },
});
