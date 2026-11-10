import type { ContentKind } from './types.js';

/**
 * Content routing, the part that makes compression safe.
 *
 * A JSON array and a log file both contain braces and timestamps; applying line deduplication to JSON
 * produces invalid JSON, and parsing a log as JSON produces nothing. The router is conservative: when a
 * detector is not sure, the content falls through to plain text.
 */

const logPattern = /\b(?:ERROR|FATAL|FAIL(?:ED|URE)?|WARN(?:ING)?|INFO|DEBUG|TRACE)\b|Traceback \(most recent call last\)|^\s+at .+\(.+:\d+:\d+\)/i;
const searchPattern = /(^|\n)[^\n:]+:\d+(?::\d+)?[: -]/;
const codePattern = /\b(?:import|export|function|class|interface|type|const|let|var|return|throw|async|await|def|fn|struct|impl)\b|[{};]\s*$/m;

export function detectContentKind(text: string): ContentKind {
  const trimmed = text.trim();
  if (!trimmed) return 'text';
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      JSON.parse(trimmed);
      return 'json';
    } catch {
      // A truncated JSON document is text, not JSON.
    }
  }
  const lines = trimmed.split('\n');
  const logLines = lines.filter((line) => logPattern.test(line)).length;
  if (logLines >= 2 || (lines.length > 20 && logLines >= 1)) return 'log';
  const searchLines = lines.filter((line) => searchPattern.test(line)).length;
  if (searchLines >= Math.max(2, lines.length * 0.15)) return 'search';
  const codeSignals = (trimmed.match(/\b(?:import|export|function|class|interface|type|const|let|var|return|throw|async|await|def|fn|struct|impl)\b/g) ?? []).length;
  if (codeSignals >= 3 && codePattern.test(trimmed)) return 'code';
  return 'text';
}

export function isLikelyBase64(text: string): boolean {
  if (text.length < 512) return false;
  const sample = text.slice(0, 256).replace(/\s+/g, '');
  return /^[A-Za-z0-9+/=]+$/.test(sample) && !/^[0-9]+$/.test(sample);
}
