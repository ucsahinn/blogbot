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
  const confirmButton = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLElement | null>(null);

  useEffect(() => {
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    confirmButton.current?.focus();
    return () => {
      trigger.current?.focus();
    };
  }, []);

  return (
    <div className="confirmation-dialog-backdrop" onMouseDown={(event) => event.stopPropagation()}>
      <section
        className="confirmation-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirmation-dialog-title"
        aria-describedby="confirmation-dialog-detail"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) onCancel();
        }}
      >
        <p className="section-kicker">SON ONAY</p>
        <h2 id="confirmation-dialog-title">{title}</h2>
        <p id="confirmation-dialog-detail">{detail}</p>
        <div className="button-row">
          <button className="button button-secondary" type="button" disabled={busy} onClick={onCancel}>Vazgeç</button>
          <button ref={confirmButton} className="button button-danger" type="button" disabled={busy} onClick={onConfirm}>
            {busy ? "İşlem sürüyor…" : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
