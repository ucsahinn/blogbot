import { useEffect, useRef } from "react";

interface ConfirmationDialogProps {
  title: string;
  detail: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

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

  useEffect(() => {
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelButton.current?.focus();
    return () => {
      trigger.current?.focus();
    };
  }, []);

  return (
    <div className="confirmation-dialog-backdrop" onMouseDown={(event) => event.stopPropagation()}>
      <section
        ref={dialog}
        className="confirmation-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirmation-dialog-title"
        aria-describedby="confirmation-dialog-detail"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) onCancel();
          if (event.key === "Tab") {
            const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])") ?? [])];
            if (focusable.length === 0) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (!first || !last) return;
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
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
    </div>
  );
}
