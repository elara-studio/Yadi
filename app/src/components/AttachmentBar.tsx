import { formatAttachmentSize } from "@yadi/core";
import type { UseAttachments } from "../attachments/useAttachments";

/** Chips for the attached files, friendly errors, and the "drop files here" overlay. */
export function AttachmentBar({ items, errors, dragging, remove, dismissError }: UseAttachments) {
  return (
    <>
      {dragging && (
        <div className="drop-overlay" role="status">
          Drop files to attach them
        </div>
      )}
      {errors.map((e) => (
        <div className="attachment-error" role="alert" key={e.id}>
          <span>{e.message}</span>
          <button type="button" aria-label="Dismiss" onClick={() => dismissError(e.id)}>
            ×
          </button>
        </div>
      ))}
      {items.length > 0 && (
        <ul className="attachment-chips" aria-label="Attachments">
          {items.map((a) => (
            <li className="chip" key={a.id}>
              <span className="chip-name" title={a.name}>
                {a.name}
              </span>
              <span className="chip-meta">
                {a.type} · {formatAttachmentSize(a.size)}
                {a.truncated ? " · cut" : ""}
              </span>
              <button
                type="button"
                className="chip-remove"
                aria-label={`Remove ${a.name}`}
                onClick={() => remove(a.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
