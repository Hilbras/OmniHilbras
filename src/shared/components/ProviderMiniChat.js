"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import { Button, Input, Select } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import {
  getProviderAlias,
  isAnthropicCompatibleProvider,
  isOpenAICompatibleProvider,
} from "@/shared/constants/providers";
import {
  buildReplayHistory,
  extractDelta,
  formatCount,
  formatCredits,
  formatDuration,
  parseMarkdown,
} from "@/shared/utils/providerMiniChat";

export { extractDelta };

const STORAGE_PREFIX = "omnihilbras:provider-mini-chat:";
const DEFAULT_MAX_TOKENS = "1024";
const MAX_MAX_TOKENS = 32768;

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

/* ------------------------------------------------------------------ *
 * Answer rendering
 *
 * The parser returns data, never HTML, so every string below reaches the
 * browser as a React child. React escapes it, which is why a model answer
 * can never inject markup into the dashboard — there is no HTML in the
 * pipeline to sanitise.
 * ------------------------------------------------------------------ */

const SPAN_CLASS = {
  text: "",
  bold: "font-semibold",
  italic: "italic",
  code: "rounded border border-border bg-surface-2 px-1 py-0.5 font-mono text-[0.9em]",
  strike: "line-through",
};

function MarkdownSpans({ spans }) {
  if (!Array.isArray(spans) || spans.length === 0) return null;
  return spans.map((span, index) => {
    if (span.type === "text") return <span key={index}>{span.text}</span>;
    return <span key={index} className={SPAN_CLASS[span.type] || ""}>{span.text}</span>;
  });
}

function CodeBlock({ lang, code }) {
  const { copied, copy } = useCopyToClipboard();
  const id = useId();
  const isCopied = copied === id;

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border bg-surface-2">
      <div className="flex items-center justify-between border-b border-border bg-surface px-2 py-1">
        <span className="font-mono text-[10px] uppercase tracking-wide text-text-muted">
          {lang || "text"}
        </span>
        <button
          type="button"
          onClick={() => copy(code, id)}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-text-muted transition-colors hover:bg-surface-3 hover:text-text-main"
        >
          <span className="material-symbols-outlined text-[14px]">
            {isCopied ? "check" : "content_copy"}
          </span>
          {isCopied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="custom-scrollbar overflow-x-auto px-2 py-1.5">
        <code className="font-mono text-[12px] text-text-primary">{code}</code>
      </pre>
    </div>
  );
}

function MarkdownBlocks({ blocks }) {
  if (!Array.isArray(blocks) || blocks.length === 0) return null;

  return blocks.map((block, index) => {
    switch (block.type) {
      case "heading": {
        const Tag = `h${Math.min(Math.max(block.level || 1, 1), 6)}`;
        return (
          <Tag key={index} className="mt-2 text-[13px] font-semibold text-text-primary first:mt-0">
            <MarkdownSpans spans={block.spans} />
          </Tag>
        );
      }
      case "code":
        return <CodeBlock key={index} lang={block.lang} code={block.code} />;
      case "list": {
        const ListTag = block.ordered ? "ol" : "ul";
        return (
          <ListTag
            key={index}
            className={`my-1 list-inside space-y-1 pl-4 ${block.ordered ? "list-decimal" : "list-disc"}`}
          >
            {block.items.map((item, itemIndex) => (
              <li key={itemIndex} className="marker:text-text-muted">
                <MarkdownBlocks blocks={item.blocks} />
              </li>
            ))}
          </ListTag>
        );
      }
      case "quote":
        return (
          <blockquote key={index} className="my-1 border-l-2 border-border pl-2 text-text-muted">
            <p className="whitespace-pre-wrap break-words">
              <MarkdownSpans spans={block.spans} />
            </p>
          </blockquote>
        );
      case "rule":
        return <hr key={index} className="my-2 border-border" />;
      default:
        return (
          <p key={index} className="my-1 whitespace-pre-wrap break-words">
            <MarkdownSpans spans={block.spans} />
          </p>
        );
    }
  });
}

function RenderedAnswer({ content }) {
  const blocks = useMemo(() => parseMarkdown(content), [content]);
  return <MarkdownBlocks blocks={blocks} />;
}

/**
 * The facts about a turn: which model answered, how long it took, what it
 * cost and why it stopped. A tester cannot judge a model from the answer
 * alone — a one-word answer from a fast model and a one-word answer from a
 * slow one are very different things.
 */
function TurnMeta({ meta }) {
  if (!meta || typeof meta !== "object") return null;

  const parts = [];
  if (meta.model) parts.push(<span key="model" className="text-gold-text">{meta.model}</span>);
  if (typeof meta.latencyMs === "number") parts.push(formatDuration(meta.latencyMs));

  const usage = meta.usage;
  if (usage) {
    if (typeof usage.promptTokens === "number") parts.push(`↑ ${formatCount(usage.promptTokens)}`);
    if (typeof usage.completionTokens === "number") parts.push(`↓ ${formatCount(usage.completionTokens)}`);
  }

  if (meta.stopped) parts.push("stopped by you");
  else if (meta.finishReason) parts.push(meta.finishReason);

  const credits = formatCredits(usage);
  if (credits) parts.push(credits);

  if (parts.length === 0) return null;

  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[10px] text-text-muted">
      {parts.map((part, index) => (
        <span key={index} className="inline-flex items-center gap-1.5">
          {index > 0 && <span aria-hidden="true">·</span>}
          {part}
        </span>
      ))}
    </p>
  );
}

/* ------------------------------------------------------------------ *
 * Persistence helpers
 * ------------------------------------------------------------------ */

function normalizeStoredMessage(message, index) {
  if (!message || (message.role !== "user" && message.role !== "assistant")) return null;

  const status = message.status === "error"
    ? "error"
    : message.status === "streaming"
      // A stream cannot outlive the page: a turn that was still running when
      // the tab closed comes back as a stopped turn.
      ? "stopped"
      : "done";

  return {
    id: typeof message.id === "string" && message.id ? message.id : `mc-restored-${index}`,
    role: message.role,
    content: typeof message.content === "string" ? message.content : "",
    status,
    error: typeof message.error === "string" ? message.error : "",
    thinking: typeof message.thinking === "string" ? message.thinking : "",
    meta: message.meta && typeof message.meta === "object" ? message.meta : null,
  };
}

function maxStoredId(messages) {
  let max = 0;
  for (const message of messages) {
    const match = /^mc-(\d+)$/.exec(message.id || "");
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
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
  const [systemPrompt, setSystemPrompt] = useState("");
  const [maxTokens, setMaxTokens] = useState(DEFAULT_MAX_TOKENS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState("");
  const [showJump, setShowJump] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const abortRef = useRef(null);
  const transcriptRef = useRef(null);
  const stickRef = useRef(true);
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

  // The storage alias is what the gateway routes on: compatible providers keep
  // their own id, every other provider routes under its alias.
  const storageAlias = useMemo(() => {
    const id = typeof providerId === "string" ? providerId : "";
    const isCompatible = isOpenAICompatibleProvider(id) || isAnthropicCompatibleProvider(id);
    return isCompatible ? id : getProviderAlias(id);
  }, [providerId]);

  const storageKey = useMemo(
    () => `${STORAGE_PREFIX}${typeof providerId === "string" ? providerId : "unknown"}`,
    [providerId],
  );

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

  const maxTokensNumber = useMemo(() => {
    const parsed = Number(maxTokens);
    if (!Number.isFinite(parsed) || parsed <= 0) return Number(DEFAULT_MAX_TOKENS);
    return Math.min(Math.floor(parsed), MAX_MAX_TOKENS);
  }, [maxTokens]);

  const nextId = useCallback(() => `mc-${(idRef.current += 1)}`, []);

  const lastAssistantId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === "assistant") return messages[index].id;
    }
    return null;
  }, [messages]);

  /* ---------------------------------------------------------------- *
   * Persistence — the conversation outlives the page.
   * ---------------------------------------------------------------- */

  useEffect(() => {
    // The stored conversation is read one tick after mount instead of during
    // the first render: reading it there would hand React two different trees
    // and make it throw the server-rendered one away.
    const timer = setTimeout(() => {
      let stored = null;
      try {
        const raw = window.localStorage.getItem(storageKey);
        stored = raw ? JSON.parse(raw) : null;
      } catch {
        stored = null;
      }

      const restored = (Array.isArray(stored?.messages) ? stored.messages : [])
        .map(normalizeStoredMessage)
        .filter(Boolean);

      setMessages(restored);
      idRef.current = Math.max(idRef.current, maxStoredId(restored));
      setSystemPrompt(typeof stored?.system === "string" ? stored.system : "");
      setMaxTokens(typeof stored?.maxTokens === "string" && stored.maxTokens.trim()
        ? stored.maxTokens
        : DEFAULT_MAX_TOKENS);
      setPickedModel(typeof stored?.model === "string" ? stored.model : "");
      setDraft("");
      setEditingId(null);
      setEditDraft("");
      setHydrated(true);
    }, 0);

    return () => clearTimeout(timer);
  }, [storageKey]);

  useEffect(() => {
    // Nothing is written before the stored conversation has been read back,
    // otherwise the first render would overwrite it with an empty one.
    if (!hydrated) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify({
        messages,
        system: systemPrompt,
        maxTokens,
        model: pickedModel,
      }));
    } catch {
      // A full or blocked storage must never break the chat.
    }
  }, [hydrated, storageKey, messages, systemPrompt, maxTokens, pickedModel]);

  /* ---------------------------------------------------------------- *
   * Scrolling — follow the stream, but never fight the reader.
   * ---------------------------------------------------------------- */

  const handleTranscriptScroll = useCallback(() => {
    const element = transcriptRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    const atBottom = distance <= 24;
    stickRef.current = atBottom;
    setShowJump(!atBottom);
  }, []);

  useEffect(() => {
    const element = transcriptRef.current;
    if (!element || !stickRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [messages]);

  const handleJumpToLatest = useCallback(() => {
    const element = transcriptRef.current;
    if (element) element.scrollTop = element.scrollHeight;
    stickRef.current = true;
    setShowJump(false);
  }, []);

  /* ---------------------------------------------------------------- *
   * The turn itself
   * ---------------------------------------------------------------- */

  const runTurn = useCallback(async ({ history, assistantId, model }) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setIsStreaming(true);
    const startedAt = Date.now();

    const patchAssistant = (patch) => {
      setMessages((previous) => previous.map((message) => (
        message.id === assistantId ? { ...message, ...patch } : message
      )));
    };

    const buildMeta = (extra = {}) => ({
      model,
      latencyMs: Date.now() - startedAt,
      usage: null,
      finishReason: "",
      stopped: false,
      ...extra,
    });

    let content = "";
    let thinking = "";
    let usage = null;
    let finishReason = "";

    try {
      const response = await fetch("/api/models/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({
          model: `${storageAlias}/${model}`,
          messages: history,
          system: systemPrompt.trim() || undefined,
          maxTokens: maxTokensNumber,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        const message = typeof data?.error === "string" && data.error.trim()
          ? data.error
          : `The request failed (HTTP ${response.status})`;
        patchAssistant({ status: "error", error: message, meta: buildMeta() });
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        patchAssistant({
          status: "error",
          error: "The provider returned no stream.",
          meta: buildMeta(),
        });
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let rawBody = "";
      let frameError = "";
      let streamEnded = false;

      const consume = (line) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) return "continue";
        const frame = extractDelta(trimmed.slice(5));
        if (frame.error) {
          frameError = frame.error;
          return "stop";
        }
        if (frame.reasoning) {
          thinking += frame.reasoning;
          patchAssistant({ thinking });
        }
        if (frame.text) {
          content += frame.text;
          patchAssistant({ content });
        }
        if (frame.finishReason) finishReason = frame.finishReason;
        if (frame.usage) usage = frame.usage;
        if (frame.done) return "stop";
        return "continue";
      };

      while (!streamEnded) {
        const { value, done } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;
        rawBody += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";

        for (const line of lines) {
          const outcome = consume(line);
          if (outcome === "stop") {
            streamEnded = true;
            break;
          }
        }
        if (frameError) break;
      }

      // The last frame of a stream often has no trailing newline.
      if (!streamEnded && !frameError && buffer.trim()) consume(buffer);

      if (frameError) {
        patchAssistant({
          status: "error",
          error: frameError,
          content,
          thinking,
          meta: buildMeta({ usage, finishReason }),
        });
        return;
      }

      if (!content) {
        // Not every refusal arrives as an SSE frame — some providers answer
        // with a plain body. Read the provider's own words out of it.
        const plain = extractDelta(rawBody);
        if (plain.error) {
          patchAssistant({
            status: "error",
            error: plain.error,
            thinking,
            meta: buildMeta({ usage, finishReason }),
          });
          return;
        }
        content = plain.text;
        if (plain.finishReason) finishReason = plain.finishReason;
        if (plain.usage) usage = plain.usage;
      }

      patchAssistant({
        status: "done",
        content,
        thinking,
        meta: buildMeta({ usage, finishReason }),
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        // Stopped on purpose — keep whatever already arrived.
        patchAssistant({
          status: "stopped",
          content,
          thinking,
          meta: buildMeta({ usage, finishReason, stopped: true }),
        });
      } else {
        patchAssistant({
          status: "error",
          error: error?.message || "The request failed.",
          content,
          thinking,
          meta: buildMeta({ usage, finishReason }),
        });
      }
    } finally {
      abortRef.current = null;
      setIsStreaming(false);
    }
  }, [storageAlias, systemPrompt, maxTokensNumber]);

  const handleSend = useCallback(async () => {
    const text = draft.trim();
    if (!text || isStreaming || !selectedModel) return;

    const userMessage = { id: nextId(), role: "user", content: text };
    const assistantId = nextId();
    const history = buildReplayHistory([...messages, userMessage]);

    setMessages((previous) => [
      ...previous,
      userMessage,
      {
        id: assistantId,
        role: "assistant",
        content: "",
        thinking: "",
        status: "streaming",
        error: "",
        meta: null,
      },
    ]);
    setDraft("");
    stickRef.current = true;
    setShowJump(false);

    await runTurn({ history, assistantId, model: selectedModel });
  }, [draft, isStreaming, messages, nextId, runTurn, selectedModel]);

  const handleRegenerate = useCallback(async (assistantId) => {
    if (isStreaming || !selectedModel) return;
    const index = messages.findIndex((message) => message.id === assistantId);
    if (index < 0) return;

    // The same history as the first run: everything the model saw before it
    // answered, and nothing of the answer itself.
    const history = buildReplayHistory(messages.slice(0, index));
    setMessages((previous) => previous.map((message, position) => (position === index
      ? { ...message, content: "", thinking: "", status: "streaming", error: "", meta: null }
      : message)));
    stickRef.current = true;
    setShowJump(false);

    await runTurn({ history, assistantId, model: selectedModel });
  }, [isStreaming, messages, runTurn, selectedModel]);

  const handleRetry = useCallback(async (assistantId) => {
    if (isStreaming || !selectedModel) return;
    const index = messages.findIndex((message) => message.id === assistantId);
    if (index < 0) return;

    // The failed turn stays out of the history: its text is the provider's
    // report about the failure, not something the model said.
    const history = buildReplayHistory(messages.slice(0, index));
    setMessages((previous) => previous.map((message, position) => (position === index
      ? { ...message, content: "", thinking: "", status: "streaming", error: "", meta: null }
      : message)));

    await runTurn({ history, assistantId, model: selectedModel });
  }, [isStreaming, messages, runTurn, selectedModel]);

  const handleEditSave = useCallback(async () => {
    const text = editDraft.trim();
    if (!text || isStreaming || !selectedModel || !editingId) return;
    const index = messages.findIndex((message) => message.id === editingId);
    if (index < 0) return;

    // Editing a turn is a branch: everything said after it is dropped and
    // the model is asked again from the edited question.
    const branch = messages.slice(0, index + 1).map((message) => (message.id === editingId
      ? { ...message, content: text }
      : message));
    const history = buildReplayHistory(branch);
    const assistantId = nextId();

    setMessages([
      ...branch,
      {
        id: assistantId,
        role: "assistant",
        content: "",
        thinking: "",
        status: "streaming",
        error: "",
        meta: null,
      },
    ]);
    setEditingId(null);
    setEditDraft("");
    stickRef.current = true;
    setShowJump(false);

    await runTurn({ history, assistantId, model: selectedModel });
  }, [editDraft, editingId, isStreaming, messages, nextId, runTurn, selectedModel]);

  const startEditing = useCallback((message) => {
    setEditingId(message.id);
    setEditDraft(message.content);
  }, []);

  const cancelEditing = useCallback(() => {
    setEditingId(null);
    setEditDraft("");
  }, []);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleClear = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setDraft("");
    setEditingId(null);
    setEditDraft("");
    setShowJump(false);
    stickRef.current = true;
  }, []);

  const handleComposerKeyDown = useCallback((event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSend();
      return;
    }
    if (event.key === "ArrowUp" && !event.shiftKey && !draft.trim()) {
      // An empty composer plus ArrowUp edits the last question, the way a
      // terminal does.
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index].role === "user") {
          event.preventDefault();
          startEditing(messages[index]);
          return;
        }
      }
    }
  }, [draft, handleSend, messages, startEditing]);

  const handlePanelKeyDown = useCallback((event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      handleStop();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && (event.key === "k" || event.key === "K")) {
      event.preventDefault();
      handleClear();
    }
  }, [handleClear, handleStop]);

  return (
    <div
      className="overflow-hidden rounded-xl border border-border bg-surface text-text-main"
      onKeyDown={handlePanelKeyDown}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="material-symbols-outlined shrink-0 text-[18px] text-text-muted">forum</span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-text-primary">Chat with {label}</p>
            <p className="truncate text-[11px] text-text-muted">
              {hasConnection
                ? `${usableConnections.length} connection${usableConnections.length === 1 ? "" : "s"}${authKinds.length ? ` · ${authKinds.join(", ")}` : ""}`
                : "No connection yet"}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => setSettingsOpen((open) => !open)}
            aria-label="Settings"
            title="Settings"
            aria-expanded={settingsOpen}
            className={`p-1 rounded-[10px] transition-colors hover:bg-surface-2 hover:text-text-main ${settingsOpen ? "text-gold-text" : "text-text-muted"}`}
          >
            <span className="material-symbols-outlined text-[18px]">tune</span>
          </button>
          <button
            type="button"
            onClick={handleClear}
            aria-label="Clear conversation"
            title="Clear conversation"
            disabled={messages.length === 0}
            className="p-1 rounded-[10px] text-text-muted transition-colors hover:bg-surface-2 hover:text-text-main disabled:cursor-not-allowed disabled:opacity-40"
          >
            <span className="material-symbols-outlined text-[18px]">delete_sweep</span>
          </button>
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
      </div>

      {!hasConnection && (
        <div className="px-3 py-3">
          <p className="text-sm font-medium text-text-primary">No connection yet</p>
          <p className="mt-1 text-xs text-text-muted">
            {label} has no usable connection, so a chat would have nowhere to go. Connect one on this
            page and the panel opens up.
          </p>
        </div>
      )}

      {hasConnection && !hasModels && (
        <div className="px-3 py-3">
          <p className="text-sm font-medium text-text-primary">No models yet</p>
          <p className="mt-1 text-xs text-text-muted">
            {label} has no model to talk to. Fetch or add one on this page and the chat appears here.
          </p>
        </div>
      )}

      {canChat && (
        <div className="border-b border-border px-3 py-2">
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

      {settingsOpen && (
        <div className="space-y-2 border-b border-border px-3 py-2">
          <label
            htmlFor="provider-mini-chat-system"
            className="block text-[11px] font-medium text-text-primary"
          >
            System prompt
          </label>
          <textarea
            id="provider-mini-chat-system"
            value={systemPrompt}
            onChange={(event) => setSystemPrompt(event.target.value)}
            rows={2}
            placeholder="Sent ahead of the conversation as a system message."
            className="custom-scrollbar w-full resize-none rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-xs text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-primary"
          />
          <Input
            label="Max tokens"
            type="number"
            min={1}
            max={MAX_MAX_TOKENS}
            value={maxTokens}
            onChange={(event) => setMaxTokens(event.target.value)}
            hint="Sent as max_tokens."
          />
          <p className="text-[10px] text-text-muted">
            Enter sends · Shift+Enter newlines · Esc stops · Ctrl+K clears · ArrowUp edits the last question
          </p>
        </div>
      )}

      <div className="relative border-b border-border">
        <div
          ref={transcriptRef}
          onScroll={handleTranscriptScroll}
          className="custom-scrollbar max-h-64 space-y-2 overflow-y-auto px-3 py-2"
        >
          {messages.length === 0 && (
            <p className="text-xs text-text-muted">
              Ask {label} something — the answer streams in as it is produced.
            </p>
          )}

          {messages.map((message) => {
            const isUser = message.role === "user";
            const isStreamingMessage = message.status === "streaming";
            const isEditing = editingId === message.id;
            const isLastAssistant = !isUser && message.id === lastAssistantId;

            return (
              <div key={message.id} className={isUser ? "flex justify-end" : "flex justify-start"}>
                <div
                  className={
                    isUser
                      ? "max-w-[85%] rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-sm text-text-primary"
                      : "max-w-[92%] text-sm text-text-primary"
                  }
                >
                  <p className="mb-0.5 text-[11px] text-text-muted">{isUser ? "You" : label}</p>

                  {isEditing ? (
                    <div className="space-y-1.5">
                      <textarea
                        value={editDraft}
                        onChange={(event) => setEditDraft(event.target.value)}
                        rows={3}
                        autoFocus
                        className="custom-scrollbar w-full resize-none rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary"
                      />
                      <div className="flex items-center gap-1.5">
                        <Button size="xs" icon="send" onClick={handleEditSave} disabled={isStreaming || !editDraft.trim()}>
                          Save and resend
                        </Button>
                        <Button size="xs" variant="ghost" onClick={cancelEditing} disabled={isStreaming}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {isUser ? (
                        <p className="whitespace-pre-wrap break-words">{message.content}</p>
                      ) : message.content ? (
                        <RenderedAnswer content={message.content} />
                      ) : isStreamingMessage ? (
                        <p className="text-text-muted">
                          <span className="material-symbols-outlined animate-pulse text-[14px]">
                            progress_activity
                          </span>
                        </p>
                      ) : null}

                      {message.thinking ? (
                        <details className="mt-1 rounded-lg border border-border bg-surface-2">
                          <summary className="cursor-pointer px-2 py-1 text-[11px] text-text-muted transition-colors hover:text-text-primary">
                            Thinking · {formatCount(message.thinking.length)} chars
                          </summary>
                          <p className="whitespace-pre-wrap break-words px-2 pb-1.5 text-[12px] text-text-muted">
                            {message.thinking}
                          </p>
                        </details>
                      ) : null}

                      {message.status === "error" && message.error ? (
                        <div className="mt-1 flex items-start gap-1.5 rounded-lg border border-danger/20 bg-danger/10 px-2 py-1.5">
                          <span className="material-symbols-outlined mt-0.5 shrink-0 text-[14px] text-danger">
                            error
                          </span>
                          <p className="whitespace-pre-wrap break-words text-xs text-danger">{message.error}</p>
                        </div>
                      ) : null}

                      <TurnMeta meta={message.meta} />

                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        {message.status === "error" && (
                          <Button
                            size="xs"
                            variant="secondary"
                            icon="refresh"
                            onClick={() => handleRetry(message.id)}
                            disabled={isStreaming}
                          >
                            Retry
                          </Button>
                        )}
                        {isLastAssistant && message.status !== "error" && (
                          <Button
                            size="xs"
                            variant="ghost"
                            icon="refresh"
                            onClick={() => handleRegenerate(message.id)}
                            disabled={isStreaming}
                          >
                            Regenerate
                          </Button>
                        )}
                        {isUser && (
                          <Button
                            size="xs"
                            variant="ghost"
                            icon="edit"
                            onClick={() => startEditing(message)}
                            disabled={isStreaming}
                          >
                            Edit
                          </Button>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {showJump && (
          <button
            type="button"
            onClick={handleJumpToLatest}
            className="absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-surface px-2.5 py-1 text-[11px] text-text-primary shadow-sm transition-colors hover:bg-surface-2"
          >
            <span className="material-symbols-outlined text-[14px]">keyboard_double_arrow_down</span>
            Jump to latest
          </button>
        )}
      </div>

      <div className="flex items-end gap-2 border-t border-border p-2">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleComposerKeyDown}
          rows={2}
          placeholder={canChat ? `Message ${label}` : "Not available"}
          disabled={!canChat || isStreaming}
          className="custom-scrollbar w-full flex-1 resize-none rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
        />
        <div className="flex shrink-0 items-center gap-1.5">
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
