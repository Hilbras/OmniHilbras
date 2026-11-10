import { MemoryCcrStore, countMessageTokens, estimateTokens } from './ccr.js';
import { compressCode } from './code.js';
import { detectContentKind } from './detect.js';
import { compressJsonText } from './json.js';
import { compressLog } from './logs.js';
import { compressText } from './text.js';
import type {
  CcrStore,
  CompressionResult,
  CompressionStats,
  ContentPart,
  RouteStats,
  SavableMessage,
  TokenSaverOptions,
} from './types.js';

const DEFAULTS: Required<Omit<TokenSaverOptions, 'ccr'>> = {
  targetRatio: 0.5,
  protectRecent: 4,
  compressSystem: true,
  compressUsers: false,
  compressCode: false,
  minChars: 600,
  maxStringChars: 1_000,
  maxArrayItems: 12,
  reversible: true,
  ccrLimit: 200,
};

function queryFrom(messages: readonly SavableMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content.slice(-2_000);
    if (Array.isArray(message.content)) {
      return message.content.filter((part) => part.type === 'text').map((part) => String((part as { text?: unknown }).text ?? '')).join('\n').slice(-2_000);
    }
  }
  return '';
}

function compressString(text: string, options: Required<Omit<TokenSaverOptions, 'ccr'>>, ccr: CcrStore, query: string) {
  if (text.length < options.minChars) return undefined;
  const kind = detectContentKind(text);
  if (kind === 'json') {
    const result = compressJsonText(text, {
      maxStringChars: options.maxStringChars,
      maxArrayItems: options.maxArrayItems,
      ccr,
      reversible: options.reversible,
    });
    return result ? { result, kind } : undefined;
  }
  if (kind === 'log') {
    const result = compressLog(text, { targetRatio: options.targetRatio, ccr, reversible: options.reversible });
    return result ? { result, kind } : undefined;
  }
  if (kind === 'code') {
    if (!options.compressCode) return undefined;
    const result = compressCode(text, { targetRatio: options.targetRatio, ccr, reversible: options.reversible });
    return result ? { result, kind } : undefined;
  }
  const result = compressText(text, { targetRatio: options.targetRatio, ccr, reversible: options.reversible, query });
  return result ? { result, kind } : undefined;
}

/**
 * Compress a conversation, without knowing which provider it belongs to.
 *
 * The defaults are the ones a coding agent wants: tool/system/assistant output is fair game, user
 * instructions are not, and the last four turns are untouched. Every rewrite is reversible through the
 * store, and a rewrite that would not be smaller is discarded rather than reported as a saving.
 */
export function compressMessages(
  messages: readonly SavableMessage[],
  options: TokenSaverOptions = {},
): CompressionResult<SavableMessage[]> {
  const config = { ...DEFAULTS, ...options };
  const ccr: CcrStore = options.ccr ?? new MemoryCcrStore(config.ccrLimit);
  const query = queryFrom(messages);
  const originalTokens = countMessageTokens(messages);
  const routes: RouteStats[] = [];
  const protectedFrom = Math.max(0, messages.length - config.protectRecent);

  const output = messages.map((message, index) => {
    const shouldCompress =
      index < protectedFrom
      && (message.role === 'tool' || message.role === 'assistant' || (message.role === 'system' && config.compressSystem) || (message.role === 'user' && config.compressUsers));
    if (!shouldCompress) return message;

    const compressPart = (part: string): string => {
      const before = estimateTokens(part);
      const compressed = compressString(part, config, ccr, query);
      if (!compressed) return part;
      const after = estimateTokens(compressed.result);
      if (after >= before) return part;
      routes.push({ kind: compressed.kind, originalTokens: before, compressedTokens: after, strategy: compressed.kind, ...(compressed.kind === 'json' ? { ccrId: undefined } : {}) });
      return compressed.result;
    };

    if (typeof message.content === 'string') {
      return { ...message, content: compressPart(message.content) };
    }
    if (Array.isArray(message.content)) {
      const content = message.content.map((part: ContentPart) => {
        if (part.type !== 'text' || typeof (part as { text?: unknown }).text !== 'string') return part;
        return { ...part, text: compressPart((part as { text: string }).text) };
      });
      return { ...message, content };
    }
    return message;
  });

  const compressedTokens = countMessageTokens(output);
  const savedTokens = Math.max(0, originalTokens - compressedTokens);
  const stats: CompressionStats = {
    originalTokens,
    compressedTokens,
    savedTokens,
    savedRatio: originalTokens === 0 ? 0 : savedTokens / originalTokens,
    routes,
    reversible: routes.length > 0 && ccr.size() > 0,
  };
  return { value: output, stats };
}

export function retrieve(store: CcrStore, id: string): string | undefined {
  return store.get(id)?.content;
}
