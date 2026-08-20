import { useEffect, useRef } from "react";
import { Icon } from "../icons";
import { formatMessage, useI18n } from "../i18n";

export function ConfirmClear({
  count,
  busy,
  onCancel,
  onConfirm,
}: {
  count: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { locale, messages } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [
        ...dialogRef.current.querySelectorAll<HTMLElement>(
          "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])",
        ),
      ];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, [onCancel]);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onCancel();
      }}
      role="presentation"
    >
      <div
        aria-describedby="clear-description"
        aria-labelledby="clear-title"
        aria-modal="true"
        className="modal-card"
        ref={dialogRef}
        role="dialog"
      >
        <span className="modal-icon">
          <Icon name="trash" />
        </span>
        <h2 id="clear-title">{messages.confirmClear.title}</h2>
        <p id="clear-description">
          {formatMessage(
            count === 1
              ? messages.confirmClear.bodyOne
              : messages.confirmClear.bodyOther,
            { count: new Intl.NumberFormat(locale).format(count) },
          )}
        </p>
        <div className="modal-actions">
          <button
            className="button-secondary"
            disabled={busy}
            onClick={onCancel}
            ref={cancelRef}
            type="button"
          >
            {messages.common.cancel}
          </button>
          <button
            className="button-danger"
            disabled={busy}
            onClick={onConfirm}
            type="button"
          >
            {busy ? messages.confirmClear.clearing : messages.confirmClear.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
