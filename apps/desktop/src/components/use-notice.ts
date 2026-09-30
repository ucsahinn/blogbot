import { useCallback, useState } from "react";

export type NoticeTone = "info" | "warning";

/**
 * A status message plus its tone. Failures used to render in the same teal
 * "success" style as confirmations; `warn` marks a message as needing
 * attention so the notice reads as a problem, not an acknowledgement.
 */
export function useNotice(initial = "") {
  const [state, setState] = useState<{ text: string; tone: NoticeTone }>({ text: initial, tone: "info" });
  const set = useCallback((text: string) => setState({ text, tone: "info" }), []);
  const warn = useCallback((text: string) => setState({ text, tone: "warning" }), []);
  return [state.text, set, warn, state.tone] as const;
}

export const noticeToneClass = (tone: NoticeTone): string => (tone === "warning" ? " is-warning" : "");
