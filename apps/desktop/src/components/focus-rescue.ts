/**
 * Keeps keyboard focus inside the workspace when the control that held it
 * disables or unmounts itself (e.g. "Seçimi temizle", a wizard "Geri" on the
 * first step, a schedule summary replaced by its editor, "Bu revizyonu
 * onayla" turning into "Revizyon onaylı"). Without this, focus fell to
 * <body> and the next Tab restarted from the top of the page (WCAG 2.4.3).
 *
 * Browsers do not reliably fire focusout when a focused button becomes
 * disabled, so the last focused control is tracked and checked after each
 * activation. Focus the user moved elsewhere on purpose is left alone.
 */
const FOCUSABLE =
  "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])";

function isDisabled(element: Element): boolean {
  return "disabled" in element && Boolean((element as HTMLButtonElement).disabled);
}

export function findFocusRescueTarget(lost: Element, ancestors: Element[]): HTMLElement | null {
  const scopes = lost.isConnected ? [lost.parentElement, ...ancestors] : ancestors;
  for (const scope of scopes) {
    if (!scope || !scope.isConnected) continue;
    const target = [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)].find(
      (candidate) => candidate !== lost && candidate.getClientRects().length > 0
    );
    if (target) return target;
  }
  return null;
}

export function installFocusRescue(root: Document = document): () => void {
  let last: { element: HTMLElement; ancestors: Element[] } | null = null;

  const onFocusIn = (event: FocusEvent) => {
    if (!(event.target instanceof HTMLElement) || event.target === root.body) return;
    const ancestors: Element[] = [];
    for (let node = event.target.parentElement; node && node !== root.body; node = node.parentElement) {
      ancestors.push(node);
    }
    last = { element: event.target, ancestors };
  };

  const check = () => {
    const active = root.activeElement;
    if (active && active !== root.body) return;
    if (!last) return;
    const { element, ancestors } = last;
    if (element.isConnected && !isDisabled(element)) return;
    findFocusRescueTarget(element, ancestors)?.focus();
  };
  // Two frames: one for the event handler's state update, one for React's
  // commit that disables or replaces the control.
  const schedule = () => requestAnimationFrame(() => requestAnimationFrame(check));
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") schedule();
  };

  root.addEventListener("focusin", onFocusIn);
  root.addEventListener("click", schedule, true);
  root.addEventListener("keydown", onKeyDown, true);
  root.addEventListener("focusout", schedule);
  return () => {
    root.removeEventListener("focusin", onFocusIn);
    root.removeEventListener("click", schedule, true);
    root.removeEventListener("keydown", onKeyDown, true);
    root.removeEventListener("focusout", schedule);
  };
}
