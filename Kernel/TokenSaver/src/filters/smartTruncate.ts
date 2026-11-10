import { SMART_TRUNCATE_HEAD, SMART_TRUNCATE_MIN_LINES, SMART_TRUNCATE_TAIL } from './constants.js';

/** Keep the head and tail of an unstructured blob; replace the middle with a count. */
export function smartTruncate(input: string): string {
  const lines = input.split('\n');
  if (lines.length < SMART_TRUNCATE_MIN_LINES) return input;

  const head = lines.slice(0, SMART_TRUNCATE_HEAD);
  const tail = lines.slice(lines.length - SMART_TRUNCATE_TAIL);
  const cut = lines.length - head.length - tail.length;
  return [...head, `... +${cut} lines truncated`, ...tail].join('\n');
}
