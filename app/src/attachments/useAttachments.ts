import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  attachmentLimitProblem,
  attachmentMeta,
  pastedTextItem,
  type AttachmentItem,
} from "@yadi/core";
import {
  attachmentErrorMessage,
  tauriAttachmentApi,
  type AttachmentApi,
  type Extracted,
} from "./api";

export interface AttachmentError {
  id: number;
  message: string;
}

export interface UseAttachments {
  items: AttachmentItem[];
  errors: AttachmentError[];
  /** A file is being dragged over the window. */
  dragging: boolean;
  remove(id: string): void;
  dismissError(id: number): void;
}

const MAX_ERRORS = 3;

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * Attachments of this session, kept in memory only. Files arrive by drag and drop (Tauri's
 * file-drop event gives paths) or by paste (files and text). `enabled` is false when adding makes
 * no sense (setup, hidden, or while the prompt is being made).
 */
export function useAttachments(
  enabled: boolean,
  send: (event: { type: "ATTACHMENTS_SET"; items: unknown[] }) => void,
  api: AttachmentApi = tauriAttachmentApi,
): UseAttachments {
  const [items, setItems] = useState<AttachmentItem[]>([]);
  const [errors, setErrors] = useState<AttachmentError[]>([]);
  const [dragging, setDragging] = useState(false);
  const itemsRef = useRef<AttachmentItem[]>([]);
  const enabledRef = useRef(enabled);
  const nextId = useRef(1);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const sendRef = useRef(send);
  const apiRef = useRef(api);
  enabledRef.current = enabled;
  sendRef.current = send;
  apiRef.current = api;

  const commit = useCallback((next: AttachmentItem[]) => {
    itemsRef.current = next;
    setItems(next);
    sendRef.current({ type: "ATTACHMENTS_SET", items: attachmentMeta(next) });
  }, []);

  const fail = useCallback((message: string) => {
    setErrors((prev) => [...prev, { id: nextId.current++, message }].slice(-MAX_ERRORS));
  }, []);

  const addItem = useCallback(
    (item: AttachmentItem) => {
      const problem = attachmentLimitProblem(itemsRef.current, item.size);
      if (problem) return fail(problem);
      commit([...itemsRef.current, item]);
    },
    [commit, fail],
  );

  const addExtracted = useCallback(
    (x: Extracted) =>
      addItem({
        id: `a${nextId.current++}`,
        name: x.name,
        type: x.type_label,
        size: x.size_bytes,
        text: x.text,
        truncated: x.truncated,
      }),
    [addItem],
  );

  /** One at a time, so the limits are checked against what is really attached. */
  const enqueue = useCallback((work: () => Promise<void>) => {
    queue.current = queue.current.then(work).catch(() => {});
  }, []);

  const addPaths = useCallback(
    (paths: string[]) => {
      for (const path of paths) {
        enqueue(async () => {
          // The count can be checked before reading; the sizes need the file.
          const early = attachmentLimitProblem(itemsRef.current, 0);
          if (early) return fail(early);
          try {
            addExtracted(await apiRef.current.fromPath(path));
          } catch (e) {
            fail(attachmentErrorMessage(e));
          }
        });
      }
    },
    [addExtracted, enqueue, fail],
  );

  const addFile = useCallback(
    (file: File) => {
      enqueue(async () => {
        // A file that is too big is refused before it is read.
        const early = attachmentLimitProblem(itemsRef.current, file.size);
        if (early) return fail(early);
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          addExtracted(await apiRef.current.fromBytes(file.name || "attachment", bytes));
        } catch (e) {
          fail(attachmentErrorMessage(e));
        }
      });
    },
    [addExtracted, enqueue, fail],
  );

  // Drag and drop (the webview reports real file paths).
  useEffect(() => {
    let off: (() => void) | undefined;
    let gone = false;
    let webview: ReturnType<typeof getCurrentWebview>;
    try {
      webview = getCurrentWebview();
    } catch {
      return; // not running inside Tauri (a plain browser): paste still works
    }
    webview
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") {
          setDragging(enabledRef.current);
        } else if (p.type === "leave") {
          setDragging(false);
        } else if (p.type === "drop") {
          setDragging(false);
          if (enabledRef.current) addPaths(p.paths);
          else fail("Wait until the prompt is ready, then add files.");
        }
      })
      .then(
        (unlisten) => (gone ? unlisten() : (off = unlisten)),
        () => {},
      );
    return () => {
      gone = true;
      off?.();
    };
  }, [addPaths, fail]);

  // Paste: files, or text (not while typing in an editor, where paste must work as usual).
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isEditable(e.target) || !enabledRef.current) return;
      const data = e.clipboardData;
      if (!data) return;
      const files = Array.from(data.files ?? []);
      if (files.length > 0) {
        e.preventDefault();
        files.forEach(addFile);
        return;
      }
      const text = data.getData("text/plain");
      if (text.trim() === "") return;
      e.preventDefault();
      const item = pastedTextItem(`a${nextId.current++}`, text);
      if (item) addItem(item);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [addFile, addItem]);

  // A new session starts: the Controller asks us to forget everything.
  useEffect(() => {
    const pending = listen("app:attachments-clear", () => {
      itemsRef.current = [];
      setItems([]);
      setErrors([]);
    });
    return () => void pending.then((unlisten) => unlisten());
  }, []);

  const remove = useCallback(
    (id: string) => commit(itemsRef.current.filter((a) => a.id !== id)),
    [commit],
  );
  const dismissError = useCallback(
    (id: number) => setErrors((prev) => prev.filter((e) => e.id !== id)),
    [],
  );

  return { items, errors, dragging, remove, dismissError };
}
