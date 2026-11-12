import type { RouteContext } from './route-context.js';
import { readJsonBody, invalidRequest, sendJson } from '../core/http.js';
import { ProviderError } from '../core/provider-error.js';
import { attachRequestId } from '../core/request-context.js';
import { getExplicitProviderId, getExplicitConnectionId, toPublicAttempt } from './inference.js';
import type { AudioSpeechRequest, AudioTranscriptionRequest } from '../core/types.js';

const notImplemented = (name: string) => new ProviderError('NOT_SUPPORTED', `${name} is not implemented yet.`, { publicMessage: `${name} is not implemented yet.` });

export async function handleMediaRoute(ctx: RouteContext): Promise<boolean> {
  const { request, response, url, service, options, origin, signal } = ctx;

  if (request.method === 'POST' && url.pathname === '/v1/audio/speech') {
    const body = await readJsonBody(request, options.maxBodyBytes ?? 1_000_000);
    if (typeof body !== 'object' || body === null) throw invalidRequest('Request body must be a JSON object.');
    const record = body as Record<string, unknown>;
    const model = record.model;
    if (typeof model !== 'string' || !model.trim()) throw invalidRequest('model must be a non-empty string.');
    const input = record.input;
    if (typeof input !== 'string' || !input.trim()) throw invalidRequest('input must be a non-empty string.');
    const parsed: AudioSpeechRequest = { model: model.trim(), input: input.trim() };
    if (typeof record.voice === 'string') (parsed as { voice?: string }).voice = record.voice;
    if (typeof record.response_format === 'string') (parsed as { responseFormat?: AudioSpeechRequest['responseFormat'] }).responseFormat = record.response_format as AudioSpeechRequest['responseFormat'];
    if (typeof record.speed === 'number') (parsed as { speed?: number }).speed = record.speed;
    if (typeof record.user === 'string') (parsed as { user?: string }).user = record.user;

    const explicitConnectionId = getExplicitConnectionId(request, body);
    const audioRequest = explicitConnectionId === undefined ? parsed : { ...parsed, connectionId: explicitConnectionId };
    const explicitProviderId = getExplicitProviderId(request, body);
    const scope = service.startScope(audioRequest.model, explicitProviderId);

    const startedAt = Date.now();
    try {
      const responseBody = await service.audioWithFailover(audioRequest, explicitProviderId, signal, scope);
      const serving = responseBody.attempts.find((attempt) => attempt.ok);
      response.statusCode = 200;
      response.setHeader('Content-Type', responseBody.response.contentType);
      response.setHeader('X-Request-Id', scope.id);
      response.end(Buffer.from(responseBody.response.audio));
    } catch (error) {
      const details = error instanceof ProviderError ? error.details : undefined;
      const ledger: unknown[] =
        typeof details === 'object' && details !== null && Array.isArray((details as { attempts?: unknown }).attempts)
          ? ((details as { attempts: unknown[] }).attempts)
          : [];
      throw attachRequestId(error, scope);
    }
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/v1/audio/transcriptions') {
    const body = await readJsonBody(request, options.maxBodyBytes ?? 1_000_000);
    if (typeof body !== 'object' || body === null) throw invalidRequest('Request body must be a JSON object.');
    const record = body as Record<string, unknown>;
    const model = record.model;
    if (typeof model !== 'string' || !model.trim()) throw invalidRequest('model must be a non-empty string.');
    const audio = record.audio;
    if (typeof audio !== 'string' || !audio.trim()) throw invalidRequest('audio must be a non-empty base64 string.');
    const parsed: AudioTranscriptionRequest = { model: model.trim(), audio: audio.trim() };
    if (typeof record.language === 'string') (parsed as { language?: string }).language = record.language;
    if (typeof record.prompt === 'string') (parsed as { prompt?: string }).prompt = record.prompt;
    if (typeof record.response_format === 'string') (parsed as { responseFormat?: AudioTranscriptionRequest['responseFormat'] }).responseFormat = record.response_format as AudioTranscriptionRequest['responseFormat'];
    if (typeof record.temperature === 'number') (parsed as { temperature?: number }).temperature = record.temperature;

    const explicitConnectionId = getExplicitConnectionId(request, body);
    const transcriptionRequest = explicitConnectionId === undefined ? parsed : { ...parsed, connectionId: explicitConnectionId };
    const explicitProviderId = getExplicitProviderId(request, body);
    const scope = service.startScope(transcriptionRequest.model, explicitProviderId);

    try {
      const responseBody = await service.transcribeWithFailover(transcriptionRequest, explicitProviderId, signal, scope);
      const serving = responseBody.attempts.find((attempt) => attempt.ok);
      sendJson(response, 200, {
        text: responseBody.response.text,
        ...(responseBody.response.language !== undefined ? { language: responseBody.response.language } : {}),
        ...(responseBody.response.duration !== undefined ? { duration: responseBody.response.duration } : {}),
        provider: responseBody.response.providerId,
        gateway: { requestId: scope.id, ...(responseBody.attempts.length > 1 ? { attempts: responseBody.attempts.map(toPublicAttempt) } : {}) },
      }, origin);
    } catch (error) {
      throw attachRequestId(error, scope);
    }
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/v1/search') {
    throw notImplemented('Search');
  }
  return false;
}
