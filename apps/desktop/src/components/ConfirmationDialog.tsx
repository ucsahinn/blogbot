import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

interface ConfirmationDialogProps {
  title: string;
  detail: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const focusableSelector =
  "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])";

/**
 * A real modal: the dialog renders outside the app root, the app root is
 * `inert` while it is open (so neither a backdrop click nor Tab can reach the
 * page behind it), Escape works wherever focus is, and focus stays in the
 * dialog while both buttons are busy.
 */
export function ConfirmationDialog({
  title,
  detail,
  confirmLabel,
  busy = false,
  onConfirm,
  onCancel
}: ConfirmationDialogProps) {
  const dialog = useRef<HTMLElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const cancelRef = useRef(onCancel);
  const busyRef = useRef(busy);
  useEffect(() => {
    cancelRef.current = onCancel;
    busyRef.current = busy;
  }, [onCancel, busy]);

  useEffect(() => {
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const appRoot = document.getElementById("root");
    const wasInert = appRoot?.inert ?? false;
    if (appRoot) appRoot.inert = true;
    cancelButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) {
        event.preventDefault();
        cancelRef.current();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (appRoot) appRoot.inert = wasInert;
      trigger.current?.focus();
    };
  }, []);

  // Both buttons disable while the action runs; keep focus on the dialog
  // itself instead of letting it fall to <body>.
  useEffect(() => {
    if (busy && dialog.current && !dialog.current.contains(document.activeElement)) {
      dialog.current.focus();
    }
    if (busy && document.activeElement instanceof HTMLButtonElement && document.activeElement.disabled) {
      dialog.current?.focus();
    }
  }, [busy]);

  return createPortal(
    <div
      className="confirmation-dialog-backdrop"
      onMouseDown={(event) => {
        event.stopPropagation();
        // A backdrop click must not move focus out of the dialog.
        if (event.target === event.currentTarget) event.preventDefault();
      }}
    >
      <section
        ref={dialog}
        className="confirmation-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-busy={busy}
        aria-labelledby="confirmation-dialog-title"
        aria-describedby="confirmation-dialog-detail"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [])];
          if (focusable.length === 0) {
            event.preventDefault();
            return;
          }
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (!first || !last) return;
          if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <p className="section-kicker">SON ONAY</p>
        <h2 id="confirmation-dialog-title">{title}</h2>
        <p id="confirmation-dialog-detail">{detail}</p>
        <div className="button-row">
          <button ref={cancelButton} className="button button-secondary" type="button" disabled={busy} onClick={onCancel}>Vazgeç</button>
          <button className="button button-danger" type="button" disabled={busy} onClick={onConfirm}>
            {busy ? "İşlem sürüyor…" : confirmLabel}
          </button>
        </div>
      </section>
    </div>,
    document.body
  );
}
