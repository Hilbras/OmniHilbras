import { providerClientHeaders } from './provider-client-identity.js';
import type { ProviderAdapter } from './index.js';

import { AgnesAiAdapter } from '@omnihilbras/sdk-agnes-ai';
import { AgentrouterAdapter } from '@omnihilbras/sdk-agentrouter';
import { AionLabsAdapter } from '@omnihilbras/sdk-aion-labs';
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
export const OWN_PROVIDER_ADAPTERS: Readonly<Record<string, () => ProviderAdapter>> = Object.freeze({
  'agnes-ai': () => new AgnesAiAdapter(),
  // AgentRouter gates on a client identity. Its own package owns the adapter; the gateway supplies the
  // environment-configured identity, so a host override still reaches the wire.
  'agentrouter': () => new AgentrouterAdapter({ headers: providerClientHeaders('agentrouter') }),
  'aion-labs': () => new AionLabsAdapter(),
  'numes': () => new NumesAdapter(),
  'kiraai': () => new KiraaiAdapter(),
  'vengetic': () => new VengeticAdapter(),
  'anyrouter': () => new AnyrouterAdapter(),
  'zro': () => new ZroAdapter(),
  'unorouter': () => new UnorouterAdapter(),
  'ollama': () => new OllamaAdapter(),
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
