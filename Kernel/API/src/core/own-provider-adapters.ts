import { providerClientHeaders } from './provider-client-identity.js';
import type { ProviderAdapter } from './index.js';
import type { OpenAICompatibleAdapterOptions } from '@omnihilbras/sdk-openai';

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

/** One own adapter per provider id that had no dedicated package before phase 2. */
export type OwnAdapterOptions = { endpoint?: string; transport?: OpenAICompatibleAdapterOptions['transport'] };
export const OWN_PROVIDER_ADAPTERS: Readonly<Record<string, (options?: OwnAdapterOptions) => ProviderAdapter>> = Object.freeze({
  'agnes-ai': () => new AgnesAiAdapter(),
  // AgentRouter gates on a client identity. Its own package owns the adapter; the gateway supplies the
  // environment-configured identity, so a host override still reaches the wire.
  'agentrouter': () => new AgentrouterAdapter({ headers: providerClientHeaders('agentrouter') }),
  'aion-labs': (options) => new AionLabsAdapter(options?.transport ? { transport: options.transport } : {}),
  '100milionseek': (options) => new OneHundredMillionSeekAdapter(options?.transport ? { transport: options.transport } : {}),
  'numes': () => new NumesAdapter(),
  'kiraai': () => new KiraaiAdapter(),
  'vengetic': (options) => new VengeticAdapter(options?.transport ? { transport: options.transport } : {}),
  'anyrouter': () => new AnyrouterAdapter(),
  'zro': () => new ZroAdapter(),
  'unorouter': () => new UnorouterAdapter(),
  'ollama': (options) => new OllamaAdapter({ ...(options?.endpoint ? { endpoint: options.endpoint } : {}), ...(options?.transport ? { transport: options.transport } : {}) }),
  'mistral': () => new MistralAdapter(),
  'nara-router': () => new NaraRouterAdapter(),
  'tokenharbor': () => new TokenharborAdapter(),
  'apinex': () => new ApinexAdapter(),
  'tiarina': () => new TiarinaAdapter(),
  'xkiro': () => new XkiroAdapter(),
  'kimi': () => new KimiAdapter(),
  'deepseek': () => new DeepseekAdapter(),
  'qwen': () => new QwenAdapter(),
  'qwen-token-plan': () => new QwenTokenPlanAdapter(),
  'groq': () => new GroqAdapter(),
  'grok': () => new GrokAdapter(),
  'nvidia': () => new NvidiaAdapter(),
  'coarena': () => new CoarenaAdapter(),
});
