import { useSyncExternalStore } from "react";
import type { UiNotice } from "@docleus/sdk";

/** A toast on screen. `isLeaving` is set for the exit animation before removal. */
export interface Toast extends UiNotice {
  readonly id: number;
  readonly isLeaving: boolean;
}

const SHOWN_MS = 6000;
const LEAVE_MS = 160;
const MAX_SHOWN = 3;

/** The toasts of the app: one stack, bottom-left, newest last. */
export interface ToastStore {
  show(notice: UiNotice): void;
  dismiss(id: number): void;
  subscribe(onChange: () => void): () => void;
  list(): readonly Toast[];
}

export function createToastStore(): ToastStore {
  let toasts: readonly Toast[] = [];
  let next = 1;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  const set = (update: readonly Toast[]) => {
    toasts = update;
    changed();
  };

  function dismiss(id: number): void {
    if (!toasts.some((toast) => toast.id === id && !toast.isLeaving)) return;
    set(
      toasts.map((toast) =>
        toast.id === id ? { ...toast, isLeaving: true } : toast,
      ),
    );
    setTimeout(() => set(toasts.filter((toast) => toast.id !== id)), LEAVE_MS);
  }

  return {
    show(notice) {
      const id = next++;
      const kept = toasts.filter((toast) => !toast.isLeaving);
      for (const old of kept.slice(0, Math.max(0, kept.length - MAX_SHOWN + 1)))
        dismiss(old.id);
      set([...toasts, { ...notice, id, isLeaving: false }]);
      setTimeout(() => dismiss(id), SHOWN_MS);
    },
    dismiss,
    subscribe(onChange) {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    list: () => toasts,
  };
}

export function useToasts(store: ToastStore): readonly Toast[] {
  return useSyncExternalStore(store.subscribe, store.list);
}
