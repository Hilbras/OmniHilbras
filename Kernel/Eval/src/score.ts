/**
 * Scoring for evaluation cases. Pure functions, no network, so a case can be tested without a model.
 *
 * The vocabulary is deliberately small: exact, contains, regex, JSON subset and a numeric tolerance.
 * An "LLM judge" is not a pass/fail authority here; a judge that scores a model with a model makes a
 * green run mean two models agreed, which is not the same as correct.
 */

export type Expectation =
  | { kind: 'exact'; value: string }
  | { kind: 'contains'; value: string; caseInsensitive?: boolean }
  | { kind: 'regex'; pattern: string; flags?: string }
  | { kind: 'json'; subset: unknown }
  | { kind: 'number'; value: number; tolerance?: number };

export type CaseResult = { passed: boolean; detail: string };

function deepSubset(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== 'object') return Object.is(actual, expected);
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length < expected.length) return false;
    return expected.every((item, index) => deepSubset(actual[index], item));
  }
  if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) return false;
  const record = actual as Record<string, unknown>;
  return Object.entries(expected as Record<string, unknown>).every(([key, value]) => deepSubset(record[key], value));
}

export function score(answer: string, expectation: Expectation): CaseResult {
  if (expectation.kind === 'exact') {
    return { passed: answer === expectation.value, detail: `exact match ${answer === expectation.value ? 'ok' : 'failed'}` };
  }
  if (expectation.kind === 'contains') {
    const haystack = expectation.caseInsensitive ? answer.toLowerCase() : answer;
    const needle = expectation.caseInsensitive ? expectation.value.toLowerCase() : expectation.value;
    return { passed: haystack.includes(needle), detail: `contains ${JSON.stringify(expectation.value)}: ${haystack.includes(needle)}` };
  }
  if (expectation.kind === 'regex') {
    const passed = new RegExp(expectation.pattern, expectation.flags ?? '').test(answer);
    return { passed, detail: `regex /${expectation.pattern}/ ${passed ? 'matched' : 'did not match'}` };
  }
  if (expectation.kind === 'json') {
    try {
      const parsed = JSON.parse(answer) as unknown;
      const passed = deepSubset(parsed, expectation.subset);
      return { passed, detail: passed ? 'json subset matched' : 'json subset did not match' };
    } catch {
      return { passed: false, detail: 'answer is not JSON' };
    }
  }
  const numeric = Number(answer.trim());
  const tolerance = expectation.tolerance ?? 0;
  const passed = Number.isFinite(numeric) && Math.abs(numeric - expectation.value) <= tolerance;
  return { passed, detail: `number ${numeric} vs ${expectation.value} ±${tolerance}` };
}
