import { ProviderError } from './errors.js';

export type SseEvent = {
  event?: string;
  data: string;
  id?: string;
};

export async function* parseSseStream(source: AsyncIterable<string>): AsyncIterable<SseEvent> {
  let buffer = '';
  let dataLines: string[] = [];
  let eventName: string | undefined;
  let eventId: string | undefined;

  const dispatch = (): SseEvent | undefined => {
    if (dataLines.length === 0) {
      eventName = undefined;
      eventId = undefined;
      return undefined;
    }

    const event: SseEvent = {
      data: dataLines.join('\n'),
      ...(eventName ? { event: eventName } : {}),
      ...(eventId ? { id: eventId } : {}),
    };
    dataLines = [];
    eventName = undefined;
    eventId = undefined;
    return event;
  };

  const processLine = (line: string): SseEvent | undefined => {
    if (line === '') return dispatch();
    if (line.startsWith(':')) return undefined;

    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'data') dataLines.push(value);
    if (field === 'event') eventName = value;
    if (field === 'id') eventId = value;
    return undefined;
  };

  for await (const chunk of source) {
    buffer += chunk;
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
      buffer = buffer.slice(newlineIndex + 1);
      const event = processLine(line);
      if (event) yield event;
      newlineIndex = buffer.indexOf('\n');
    }
  }

  if (buffer) {
    const event = processLine(buffer.replace(/\r$/, ''));
    if (event) yield event;
  }

  const finalEvent = dispatch();
  if (finalEvent) yield finalEvent;
}

export function parseSseJson<T>(event: SseEvent, providerId?: string): T | undefined {
  if (!event.data || event.data === '[DONE]') return undefined;

  try {
    return JSON.parse(event.data) as T;
  } catch (error) {
    throw new ProviderError('INVALID_RESPONSE', 'Provider stream contained invalid JSON.', {
      providerId,
      cause: error,
    });
  }
}
