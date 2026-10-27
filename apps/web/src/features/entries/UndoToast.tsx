import "./entries.css";

import { dismissUndo, useUndoMessage } from "./undoToast.ts";

/** "Not counted in spending · Undo", above the tab bar. */
export function UndoToast() {
  const message = useUndoMessage();
  return (
    <div className="undo-toast-host" aria-live="polite">
      {message ? (
        <div className="undo-toast" key={message.id}>
          <span>{message.text}</span>
          <button
            type="button"
            className="undo-toast__undo"
            onClick={() => {
              message.undo();
              dismissUndo();
            }}
          >
            Undo
          </button>
        </div>
      ) : null}
    </div>
  );
}
