"use client";

import { useState, useCallback, useRef } from "react";
import { copyToClipboard } from "./clipboard";

/**
 * Hook for copy to clipboard with feedback
 * @param {number} resetDelay - Time in ms before resetting copied state (default: 2000)
 * @returns {{ copied: string|null, copy: (text: string, id?: string) => Promise<boolean> }}
 */
export function useCopyToClipboard(resetDelay = 2000) {
  const [copied, setCopied] = useState(null);
  const timeoutRef = useRef(null);

  const copy = useCallback(async (text, id = "default") => {
    // The write is awaited: "Copied!" may only be shown once the clipboard
    // really holds the text, and a rejected write must not escape as an
    // unhandled rejection.
    const written = await copyToClipboard(text);
    if (!written) return false;

    setCopied(id);

    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    timeoutRef.current = setTimeout(() => {
      setCopied(null);
    }, resetDelay);

    return true;
  }, [resetDelay]);

  return { copied, copy };
}

