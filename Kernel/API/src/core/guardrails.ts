import { createStateDocument, type StateDocument } from './state-document.js';
import { defaultStateDirectory } from './secure-store.js';
import { estimatePromptTokens } from './token-estimate.js';

/**
 * Guardrails at the gateway boundary.
 *
 * A gateway sees every prompt and every answer, which makes it the one place a policy can be
 * enforced for every client without each client implementing it. The rules here are data, not code:
 * an operator writes them, a dry run shows what they would have caught, and a rule that fires names
 * itself in the refusal and in the audit trail.
 *
 * Three limits are stated rather than hidden:
 *
 * 1. **Streaming output cannot be unsent.** Request rules run before dispatch; response rules scan
 *    the accumulated text, and once bytes have reached a client a later block is a report, not a
 *    recall. The dashboard says so.
 * 2. **Injection detection is a flag, never a rewrite.** A heuristic that silently edits a prompt
 *    changes what the user asked without saying so.
 * 3. **Redaction is for logs and opt-in outbound.** The default redacts what the gateway writes;
 *    redacting the prompt a provider receives is a separate, explicit rule.
 */

export type RedactionKind = 'email' | 'phone' | 'card' | 'secret' | 'ipv4';

export type GuardrailRule =
  | { id: string; action: 'block' | 'flag'; target?: 'request' | 'response'; text: string; regex?: boolean; keys?: string[] }
  | { id: string; action: 'redact'; target?: 'request' | 'response'; patterns: RedactionKind[]; outbound?: boolean; keys?: string[] }
  | { id: string; action: 'limit'; maxInputTokens?: number; maxOutputTokens?: number; maxMessages?: number; maxTools?: number; keys?: string[] }
  | { id: string; action: 'tool'; deny?: string[]; allow?: string[]; keys?: string[] }
  | { id: string; action: 'injection'; threshold?: number; keys?: string[] };

export type GuardrailPolicy = {
  enabled: boolean;
  /** Report findings and add a header, but do not refuse. */
  dryRun?: boolean;
  rules: GuardrailRule[];
};

export type GuardrailFinding = {
  ruleId: string;
  action: GuardrailRule['action'];
  target: 'request' | 'response';
  detail: string;
};

export type GuardrailDecision = {
  findings: GuardrailFinding[];
  blocked: boolean;
  /** The request text after outbound redaction, when a redact rule asked for it. */
  text?: string;
};

export const emptyGuardrailPolicy: GuardrailPolicy = { enabled: false, rules: [] };

const redactionPatterns: Record<RedactionKind, RegExp> = {
  email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  phone: /\+?\d[\d ().-]{7,}\d/g,
  // A card candidate; the Luhn check is applied per match so an order number is not redacted.
  card: /\b(?:\d[ -]?){13,19}\b/g,
  secret: /\b(?:sk-[A-Za-z0-9_-]{8,}|ohk_[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g,
  ipv4: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
};

function luhnValid(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = Number(digits[index]);
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

export function redactText(text: string, kinds: readonly RedactionKind[]): string {
  let output = text;
  for (const kind of kinds) {
    output = output.replace(redactionPatterns[kind], (match) => {
      if (kind === 'card' && !luhnValid(match)) return match;
      return `[redacted:${kind}]`;
    });
  }
  return output;
}

const injectionPhrases = [
  /ignore (all )?(previous|prior|above) (instructions|prompts)/i,
  /disregard (the )?(system|developer) (prompt|message)/i,
  /you are now (?:dan|developer mode|unrestricted)/i,
  /reveal (your|the) (system prompt|instructions)/i,
  /<\|im_start\|>|<\|system\|>/i,
];

/** Flags instruction-override shapes. A count, not a verdict; the caller decides the threshold. */
export function injectionScore(text: string): number {
  return injectionPhrases.reduce((score, pattern) => score + (pattern.test(text) ? 1 : 0), 0);
}

function applies(rule: GuardrailRule, keyId: string | undefined): boolean {
  return rule.keys === undefined || rule.keys.length === 0 || (keyId !== undefined && rule.keys.includes(keyId));
}

/**
 * Evaluates the request half. `text` is the serialized messages; the caller supplies counts so the
 * policy does not have to understand three wire formats.
 */
export function evaluateRequest(
  policy: GuardrailPolicy,
  input: { text: string; messages?: number; tools?: readonly string[]; maxOutputTokens?: number; keyId?: string; untrustedText?: string },
): GuardrailDecision {
  const findings: GuardrailFinding[] = [];
  if (!policy.enabled) return { findings, blocked: false };
  let text = input.text;
  for (const rule of policy.rules) {
    if (!applies(rule, input.keyId)) continue;
    if (rule.action === 'block' || rule.action === 'flag') {
      if ((rule.target ?? 'request') !== 'request') continue;
      const matched = rule.regex ? new RegExp(rule.text, 'i').test(text) : text.toLowerCase().includes(rule.text.toLowerCase());
      if (matched) findings.push({ ruleId: rule.id, action: rule.action, target: 'request', detail: rule.regex ? 'pattern matched' : `contains "${rule.text}"` });
    } else if (rule.action === 'redact') {
      if ((rule.target ?? 'request') !== 'request') continue;
      const before = text;
      text = redactText(text, rule.patterns);
      if (text !== before) findings.push({ ruleId: rule.id, action: 'redact', target: 'request', detail: rule.patterns.join(', ') });
    } else if (rule.action === 'limit') {
      const tokens = estimatePromptTokens([{ role: 'user', content: input.text }]) ?? 0;
      if (rule.maxInputTokens !== undefined && tokens > rule.maxInputTokens) findings.push({ ruleId: rule.id, action: 'limit', target: 'request', detail: `${tokens} input tokens over ${rule.maxInputTokens}` });
      if (rule.maxMessages !== undefined && (input.messages ?? 0) > rule.maxMessages) findings.push({ ruleId: rule.id, action: 'limit', target: 'request', detail: `${input.messages} messages over ${rule.maxMessages}` });
      if (rule.maxTools !== undefined && (input.tools?.length ?? 0) > rule.maxTools) findings.push({ ruleId: rule.id, action: 'limit', target: 'request', detail: `${input.tools?.length} tools over ${rule.maxTools}` });
      if (rule.maxOutputTokens !== undefined && (input.maxOutputTokens ?? 0) > rule.maxOutputTokens) findings.push({ ruleId: rule.id, action: 'limit', target: 'request', detail: `${input.maxOutputTokens} output tokens over ${rule.maxOutputTokens}` });
    } else if (rule.action === 'tool') {
      for (const name of input.tools ?? []) {
        if (rule.allow && !rule.allow.includes(name)) findings.push({ ruleId: rule.id, action: 'tool', target: 'request', detail: `tool ${name} is not allowed` });
        if (rule.deny?.includes(name)) findings.push({ ruleId: rule.id, action: 'tool', target: 'request', detail: `tool ${name} is denied` });
      }
    } else if (rule.action === 'injection') {
      const score = injectionScore(input.untrustedText ?? input.text);
      if (score >= (rule.threshold ?? 1)) findings.push({ ruleId: rule.id, action: 'injection', target: 'request', detail: `injection score ${score}` });
    }
  }
  const blocked = !policy.dryRun && findings.some((finding) => finding.action !== 'flag' && finding.action !== 'injection');
  return { findings, blocked, ...(text !== input.text ? { text } : {}) };
}

/** Evaluates the answer half. A block here can only stop a non-streaming reply before it is sent. */
export function evaluateResponse(policy: GuardrailPolicy, text: string, keyId?: string): GuardrailDecision {
  const findings: GuardrailFinding[] = [];
  if (!policy.enabled) return { findings, blocked: false };
  let output = text;
  for (const rule of policy.rules) {
    if (!applies(rule, keyId)) continue;
    if (((('target' in rule ? rule.target : undefined) ?? 'request') !== 'response')) continue;
    if (rule.action === 'block' || rule.action === 'flag') {
      const matched = rule.regex ? new RegExp(rule.text, 'i').test(output) : output.toLowerCase().includes(rule.text.toLowerCase());
      if (matched) findings.push({ ruleId: rule.id, action: rule.action, target: 'response', detail: rule.regex ? 'pattern matched' : `contains "${rule.text}"` });
    } else if (rule.action === 'redact') {
      const before = output;
      output = redactText(output, rule.patterns);
      if (output !== before) findings.push({ ruleId: rule.id, action: 'redact', target: 'response', detail: rule.patterns.join(', ') });
    } else if (rule.action === 'injection') {
      const score = injectionScore(output);
      if (score >= (rule.threshold ?? 1)) findings.push({ ruleId: rule.id, action: 'injection', target: 'response', detail: `injection score ${score}` });
    }
  }
  const blocked = !policy.dryRun && findings.some((finding) => finding.action !== 'flag' && finding.action !== 'injection');
  return { findings, blocked, ...(output !== text ? { text: output } : {}) };
}

/** Reads a policy from the state document, tolerant of a hand-edited file. */
export function parseGuardrailPolicy(value: unknown): GuardrailPolicy {
  if (typeof value !== 'object' || value === null) return emptyGuardrailPolicy;
  const record = value as Record<string, unknown>;
  const rules: GuardrailRule[] = [];
  if (Array.isArray(record.rules)) {
    for (const item of record.rules) {
      if (typeof item !== 'object' || item === null) continue;
      const rule = item as Record<string, unknown>;
      if (typeof rule.id !== 'string' || typeof rule.action !== 'string') continue;
      if (rule.action === 'block' || rule.action === 'flag') {
        if (typeof rule.text !== 'string') continue;
        rules.push({ id: rule.id, action: rule.action, ...(rule.target === 'response' ? { target: 'response' } : {}), text: rule.text, ...(rule.regex === true ? { regex: true } : {}), ...(Array.isArray(rule.keys) ? { keys: rule.keys.filter((key): key is string => typeof key === 'string') } : {}) });
      } else if (rule.action === 'redact') {
        const patterns = Array.isArray(rule.patterns) ? rule.patterns.filter((kind): kind is RedactionKind => typeof kind === 'string' && kind in redactionPatterns) : [];
        if (patterns.length === 0) continue;
        rules.push({ id: rule.id, action: 'redact', ...(rule.target === 'response' ? { target: 'response' } : {}), patterns, ...(rule.outbound === true ? { outbound: true } : {}) });
      } else if (rule.action === 'limit') {
        rules.push({
          id: rule.id,
          action: 'limit',
          ...(typeof rule.maxInputTokens === 'number' ? { maxInputTokens: rule.maxInputTokens } : {}),
          ...(typeof rule.maxOutputTokens === 'number' ? { maxOutputTokens: rule.maxOutputTokens } : {}),
          ...(typeof rule.maxMessages === 'number' ? { maxMessages: rule.maxMessages } : {}),
          ...(typeof rule.maxTools === 'number' ? { maxTools: rule.maxTools } : {}),
        });
      } else if (rule.action === 'tool') {
        rules.push({ id: rule.id, action: 'tool', ...(Array.isArray(rule.deny) ? { deny: rule.deny.filter((name): name is string => typeof name === 'string') } : {}), ...(Array.isArray(rule.allow) ? { allow: rule.allow.filter((name): name is string => typeof name === 'string') } : {}) });
      } else if (rule.action === 'injection') {
        rules.push({ id: rule.id, action: 'injection', ...(typeof rule.threshold === 'number' ? { threshold: rule.threshold } : {}) });
      }
    }
  }
  return { enabled: record.enabled === true, ...(record.dryRun === true ? { dryRun: true } : {}), rules };
}

/** The policy store, over the same state seam every other document uses. */
export class LocalGuardrailStore {
  private readonly document: StateDocument;
  private policy: GuardrailPolicy = emptyGuardrailPolicy;
  private loaded?: Promise<void>;

  constructor(options: { directory?: string; path?: string; env?: Readonly<Record<string, string | undefined>> } = {}) {
    this.document = createStateDocument({
      name: 'guardrails',
      directory: options.directory ?? defaultStateDirectory(options.env),
      ...(options.path === undefined ? {} : { path: options.path }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
  }

  private async ensureLoaded(): Promise<void> {
    this.loaded ??= (async () => {
      const text = await this.document.read(1_000_000).catch(() => undefined);
      if (!text) return;
      try { this.policy = parseGuardrailPolicy(JSON.parse(text)); } catch { this.policy = emptyGuardrailPolicy; }
    })();
    await this.loaded;
  }

  async get(): Promise<GuardrailPolicy> {
    await this.ensureLoaded();
    return this.policy;
  }

  async set(policy: GuardrailPolicy): Promise<GuardrailPolicy> {
    this.policy = policy;
    await this.document.write(JSON.stringify(policy));
    return policy;
  }
}
