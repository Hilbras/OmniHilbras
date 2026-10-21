"use client";

import { useState } from "react";
import PropTypes from "prop-types";

/**
 * Inline alias editor.
 *
 * An alias is a second name for a model ("claude-fast" → "anthropic/claude-opus-4.7"),
 * so a model row carries its alias as a badge and can create or rename it in
 * place. Renaming drops the old key — otherwise the model would answer to two
 * names and the replaced one would linger.
 */
export default function ModelAliasEditor({ alias, onSetAlias, onClearAlias, size = "md" }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const buttonClass = size === "sm"
    ? "grid h-6 w-6 place-items-center rounded text-muted transition-colors hover:bg-surface hover:text-gold-text disabled:opacity-40"
    : "grid h-8 w-8 place-items-center rounded-lg text-muted transition-colors hover:bg-surface hover:text-gold-text disabled:opacity-40";
  const iconSize = size === "sm" ? "text-[13px]" : "text-[15px]";

  const start = () => {
    setDraft(alias || "");
    setOpen(true);
  };

  const cancel = () => {
    setOpen(false);
    setDraft("");
  };

  const save = async () => {
    const next = draft.trim();
    if (!next) return;
    try {
      await onSetAlias(next);
      // The old key points at the same model; leaving it would keep the model
      // reachable under a name the user just replaced.
      if (alias && alias !== next) await onClearAlias?.();
    } catch {
      // The page surfaces the failure; the editor stays open for a retry.
      return;
    }
    setOpen(false);
    setDraft("");
  };

  if (open) {
    return (
      <span className="flex items-center gap-1">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") cancel();
          }}
          placeholder="alias"
          aria-label="Model alias"
          autoFocus
          className="w-24 rounded-md border border-line bg-surface px-1.5 py-1 font-mono text-[10px] text-text outline-none focus:border-gold"
        />
        <button
          type="button"
          onClick={save}
          disabled={!draft.trim()}
          aria-label="Save alias"
          title="Save alias"
          className={buttonClass}
        >
          <span className={`material-symbols-outlined ${iconSize}`} aria-hidden="true">check</span>
        </button>
        <button
          type="button"
          onClick={cancel}
          aria-label="Cancel alias"
          title="Cancel"
          className={buttonClass}
        >
          <span className={`material-symbols-outlined ${iconSize}`} aria-hidden="true">close</span>
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={start}
      aria-label={alias ? `Rename alias ${alias}` : "Set an alias"}
      title={alias ? `Rename alias (${alias})` : "Set an alias"}
      className={buttonClass}
    >
      <span className={`material-symbols-outlined ${iconSize}`} aria-hidden="true">label</span>
    </button>
  );
}

ModelAliasEditor.propTypes = {
  alias: PropTypes.string,
  onSetAlias: PropTypes.func.isRequired,
  onClearAlias: PropTypes.func,
  size: PropTypes.oneOf(["sm", "md"]),
};
