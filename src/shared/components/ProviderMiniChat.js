"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import { Button, Select } from "@/shared/components";
import {
  getProviderAlias,
  isAnthropicCompatibleProvider,
  isOpenAICompatibleProvider,
} from "@/shared/constants/providers";
import { buildReplayHistory, extractDelta } from "@/shared/utils/providerMiniChat";

export { extractDelta };

function normalizeModels(models) {
  if (!Array.isArray(models)) return [];
  const seen = new Set();
  const list = [];
  for (const entry of models) {
    const id = typeof entry === "string" ? entry : entry?.id;
    if (typeof id !== "string" || !id.trim() || seen.has(id)) continue;
    seen.add(id);
    list.push(id.trim());
  }
  return list;
}

function pickDefaultModel(modelIds, defaultModel) {
  const wanted = typeof defaultModel === "string"
    ? defaultModel
    : typeof defaultModel?.id === "string"
      ? defaultModel.id
      : "";
  if (wanted && modelIds.includes(wanted)) return wanted;
  return modelIds[0] || "";
}

/**
 * A small chat panel for one provider.
 *
 * The panel talks to the provider through /api/models/chat, which forwards the
 * turn to the gateway as an OpenAI-compatible stream. The answer is rendered
 * as it arrives; a refusal comes back in the provider's own words.
 */
export default function ProviderMiniChat({
  providerId,
  providerName,
  models,
  defaultModel,
  connections,
  onClose,
}) {
  const modelIds = useMemo(() => normalizeModels(models), [models]);
  const [pickedModel, setPickedModel] = useState("");
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef(null);
  const transcriptRef = useRef(null);
  const idRef = useRef(0);

  // The model list can arrive after the panel mounts, so the picked model is
  // only honoured while it is still on offer; otherwise the default wins.
  const selectedModel = useMemo(() => {
    if (pickedModel && modelIds.includes(pickedModel)) return pickedModel;
    return pickDefaultModel(modelIds, defaultModel);
  }, [pickedModel, modelIds, defaultModel]);

  // Leaving the page mid-turn must abort the request, otherwise the fetch keeps
  // running and the reader loop keeps calling setState on an unmounted panel.
  useEffect(() => () => {
    abortRef.current?.abort();
  }, []);

  useEffect(() => {
    const element = transcriptRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages]);

  // The storage alias is what the gateway routes on: compatible providers keep
  // their own id, every other provider routes under its alias.
  const storageAlias = useMemo(() => {
    const id = typeof providerId === "string" ? providerId : "";
    const isCompatible = isOpenAICompatibleProvider(id) || isAnthropicCompatibleProvider(id);
    return isCompatible ? id : getProviderAlias(id);
  }, [providerId]);

  const usableConnections = useMemo(() => {
    if (!Array.isArray(connections)) return [];
    return connections.filter((connection) => connection && connection.isActive !== false);
  }, [connections]);

  const authKinds = useMemo(() => {
    const kinds = new Set();
    for (const connection of usableConnections) {
      if (typeof connection.authType === "string" && connection.authType.trim()) {
        kinds.add(connection.authType.trim());
      }
    }
    return Array.from(kinds);
  }, [usableConnections]);

  const hasConnection = usableConnections.length > 0;
  const hasModels = modelIds.length > 0;
  const canChat = hasConnection && hasModels;
  const label = providerName || storageAlias || providerId || "provider";

  const updateLastAssistant = useCallback((patch) => {
    setMessages((previous) => {
      const next = [...previous];
      const last = next[next.length - 1];
      if (!last || last.role !== "assistant") return previous;
      next[next.length - 1] = { ...last, ...patch };
      return next;
    });
  }, []);

  const handleSend = useCallback(async () => {
    const text = draft.trim();
    if (!text || isStreaming || !selectedModel) return;

    const userMessage = { id: `mc-${(idRef.current += 1)}`, role: "user", content: text };
    const history = buildReplayHistory([...messages, userMessage]);

    setMessages((previous) => [
      ...previous,
      userMessage,
      { id: `mc-${(idRef.current += 1)}`, role: "assistant", content: "", status: "streaming" },
    ]);
    setDraft("");

    const controller = new AbortController();
    abortRef.current = controller;
    setIsStreaming(true);

    try {
      const response = await fetch("/api/models/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({
          model: `${storageAlias}/${selectedModel}`,
          messages: history,
          maxTokens: 1024,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        const message = typeof data?.error === "string" && data.error.trim()
          ? data.error
          : `The request failed (HTTP ${response.status})`;
        updateLastAssistant({ status: "error", error: message });
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        updateLastAssistant({ status: "error", error: "The provider returned no stream." });
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let rawBody = "";
      let assistantText = "";
      let frameError = "";
      let streamEnded = false;

      while (!streamEnded) {
        const { value, done } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;
        rawBody += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const frame = extractDelta(trimmed.slice(5));
          if (frame.error) {
            frameError = frame.error;
            break;
          }
          if (frame.text) {
            assistantText += frame.text;
            updateLastAssistant({ content: assistantText });
          }
          if (frame.done) {
            streamEnded = true;
            break;
          }
        }
        if (frameError) break;
      }

      if (frameError) {
        updateLastAssistant({ status: "error", error: frameError });
      } else if (!assistantText) {
        // Not every refusal arrives as an SSE frame — some providers answer
        // with a plain body. Read the provider's own words out of it.
        const plain = extractDelta(rawBody);
        if (plain.error) {
          updateLastAssistant({ status: "error", error: plain.error });
        } else {
          updateLastAssistant({ status: "done", content: plain.text });
        }
      } else {
        updateLastAssistant({ status: "done", content: assistantText });
      }
    } catch (error) {
      if (error?.name === "AbortError") {
        // Stopped on purpose — keep whatever already arrived.
        updateLastAssistant({ status: "done" });
      } else {
        updateLastAssistant({ status: "error", error: error?.message || "The request failed." });
      }
    } finally {
      abortRef.current = null;
      setIsStreaming(false);
    }
  }, [draft, isStreaming, messages, selectedModel, storageAlias, updateLastAssistant]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleKeyDown = useCallback((event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  return (
    <div className="rounded-xl border border-border bg-surface text-text-main overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          <span className="material-symbols-outlined text-[18px] text-text-muted shrink-0">forum</span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-text-primary truncate">Chat with {label}</p>
            <p className="text-[11px] text-text-muted truncate">
              {hasConnection
                ? `${usableConnections.length} connection${usableConnections.length === 1 ? "" : "s"}${authKinds.length ? ` · ${authKinds.join(", ")}` : ""}`
                : "No connection yet"}
            </p>
          </div>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close chat"
            className="p-1 rounded-[10px] text-text-muted hover:bg-surface-2 hover:text-text-main transition-colors"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        )}
      </div>

      {!hasConnection && (
        <div className="px-3 py-3">
          <p className="text-sm font-medium text-text-primary">No connection yet</p>
          <p className="text-xs text-text-muted mt-1">
            {label} has no usable connection, so a chat would have nowhere to go. Connect one on this
            page and the panel opens up.
          </p>
        </div>
      )}

      {hasConnection && !hasModels && (
        <div className="px-3 py-3">
          <p className="text-sm font-medium text-text-primary">No models yet</p>
          <p className="text-xs text-text-muted mt-1">
            {label} has no model to talk to. Fetch or add one on this page and the chat appears here.
          </p>
        </div>
      )}

      {canChat && (
        <div className="px-3 py-2 border-b border-border">
          <Select
            options={modelIds.map((id) => ({ value: id, label: id }))}
            value={selectedModel}
            onChange={(event) => setPickedModel(event.target.value)}
            placeholder="Select a model"
            disabled={isStreaming}
            selectClassName="py-1.5 text-xs"
            aria-label="Model"
          />
        </div>
      )}

      <div ref={transcriptRef} className="max-h-64 overflow-y-auto custom-scrollbar px-3 py-2 space-y-2">
        {messages.length === 0 && (
          <p className="text-xs text-text-muted">
            Ask {label} something — the answer streams in as it is produced.
          </p>
        )}

        {messages.map((message) => {
          const isUser = message.role === "user";
          const isStreamingMessage = message.status === "streaming";

          return (
            <div key={message.id} className={isUser ? "flex justify-end" : "flex justify-start"}>
              <div
                className={
                  isUser
                    ? "max-w-[85%] rounded-lg bg-surface-2 border border-border px-2.5 py-1.5 text-sm text-text-primary whitespace-pre-wrap break-words"
                    : "max-w-[90%] text-sm text-text-primary"
                }
              >
                <p className="text-[11px] text-text-muted mb-0.5">{isUser ? "You" : label}</p>
                {message.content ? (
                  <p className="whitespace-pre-wrap break-words">{message.content}</p>
                ) : isStreamingMessage ? (
                  <p className="text-text-muted">
                    <span className="material-symbols-outlined text-[14px] animate-pulse">progress_activity</span>
                  </p>
                ) : null}

                {message.status === "error" && message.error && (
                  <div className="mt-1 flex items-start gap-1.5 rounded-lg bg-danger/10 border border-danger/20 px-2 py-1.5">
                    <span className="material-symbols-outlined text-[14px] text-danger mt-0.5 shrink-0">error</span>
                    <p className="text-xs text-danger whitespace-pre-wrap break-words">{message.error}</p>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex items-end gap-2 border-t border-border p-2">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          rows={2}
          placeholder={canChat ? `Message ${label}` : "Not available"}
          disabled={!canChat || isStreaming}
          className="flex-1 w-full px-3 py-2 bg-surface-2 border border-border rounded-lg text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-primary resize-none disabled:opacity-50 disabled:cursor-not-allowed custom-scrollbar"
        />
        <div className="flex items-center gap-1.5 shrink-0">
          {isStreaming && (
            <Button variant="secondary" size="sm" icon="stop" onClick={handleStop}>
              Stop
            </Button>
          )}
          <Button
            size="sm"
            icon="send"
            onClick={handleSend}
            disabled={!canChat || isStreaming || !draft.trim()}
          >
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}

ProviderMiniChat.propTypes = {
  providerId: PropTypes.string.isRequired,
  providerName: PropTypes.string,
  models: PropTypes.arrayOf(
    PropTypes.oneOfType([
      PropTypes.string,
      PropTypes.shape({ id: PropTypes.string, name: PropTypes.string }),
    ]),
  ),
  defaultModel: PropTypes.oneOfType([
    PropTypes.string,
    PropTypes.shape({ id: PropTypes.string }),
  ]),
  connections: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string,
      provider: PropTypes.string,
      authType: PropTypes.string,
      name: PropTypes.string,
      email: PropTypes.string,
    }),
  ),
  onClose: PropTypes.func,
};
