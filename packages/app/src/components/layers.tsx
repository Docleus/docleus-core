import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useHost } from "../lib/host.tsx";
import { useToasts } from "../lib/toasts.ts";

/** Where a layer opens: under an element, or at a pointer position. */
export type Anchor =
  | { readonly kind: "element"; readonly element: HTMLElement }
  | { readonly kind: "point"; readonly x: number; readonly y: number };

export function anchorOf(event: {
  currentTarget: EventTarget;
  clientX?: number;
  clientY?: number;
  type: string;
}): Anchor {
  if (event.type === "contextmenu") {
    return { kind: "point", x: event.clientX ?? 0, y: event.clientY ?? 0 };
  }
  return { kind: "element", element: event.currentTarget as HTMLElement };
}

const EDGE = 8;

/** Places `layer` under its anchor, flipped or shifted to stay on screen. */
function usePlacement(
  layer: RefObject<HTMLElement | null>,
  anchor: Anchor,
  align: "start" | "end",
): void {
  useLayoutEffect(() => {
    const element = layer.current;
    if (!element) return;
    const box = element.getBoundingClientRect();
    let x: number;
    let y: number;
    if (anchor.kind === "point") {
      x = anchor.x;
      y = anchor.y;
    } else {
      const rect = anchor.element.getBoundingClientRect();
      x = align === "end" ? rect.right - box.width : rect.left;
      y = rect.bottom + 4;
      if (y + box.height > innerHeight - EDGE && rect.top - box.height > EDGE) {
        y = rect.top - box.height - 4;
      }
    }
    x = Math.max(EDGE, Math.min(x, innerWidth - box.width - EDGE));
    y = Math.max(EDGE, Math.min(y, innerHeight - box.height - EDGE));
    element.style.left = `${Math.round(x)}px`;
    element.style.top = `${Math.round(y)}px`;
  }, [layer, anchor, align]);
}

/** Closes on Escape and on a press outside `layer` (and outside the anchor). */
function useDismiss(
  layer: RefObject<HTMLElement | null>,
  anchor: Anchor | undefined,
  onClose: () => void,
): void {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (layer.current?.contains(target)) return;
      if (anchor?.kind === "element" && anchor.element.contains(target)) return;
      close.current();
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close.current();
      }
    };
    // Deferred: the press that opened the layer must not close it.
    const timer = setTimeout(() => {
      document.addEventListener("pointerdown", onDown, true);
    });
    document.addEventListener("keydown", onKey, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [layer, anchor]);
}

/** Focus moves into the layer on open and back to the trigger on close. */
function useFocusReturn(
  layer: RefObject<HTMLElement | null>,
  initial: string,
): void {
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    layer.current?.querySelector<HTMLElement>(initial)?.focus();
    return () => {
      // Only when focus went nowhere: an action may have focused a field.
      const active = document.activeElement;
      const isLost = active === null || active === document.body;
      if (isLost && before?.isConnected) before.focus({ preventScroll: true });
    };
  }, [layer, initial]);
}

function moveFocus(container: HTMLElement, step: number): void {
  const items = [
    ...container.querySelectorAll<HTMLElement>(
      ".mi:not(:disabled), [role=option]",
    ),
  ];
  if (items.length === 0) return;
  const index = items.indexOf(document.activeElement as HTMLElement);
  const next =
    index < 0
      ? step > 0
        ? 0
        : items.length - 1
      : (index + step + items.length) % items.length;
  items[next]?.focus();
}

/** A menu of `.mi` items under an anchor. Arrow keys move between items. */
export function Menu(props: {
  anchor: Anchor;
  label: string;
  align?: "start" | "end";
  onClose(): void;
  children: ReactNode;
  width?: number;
}) {
  const layer = useRef<HTMLDivElement>(null);
  usePlacement(layer, props.anchor, props.align ?? "start");
  useDismiss(layer, props.anchor, props.onClose);
  useFocusReturn(layer, ".mi");
  const onKeyDown = (event: KeyboardEvent) => {
    if (!layer.current) return;
    if (event.key === "ArrowDown") moveFocus(layer.current, 1);
    else if (event.key === "ArrowUp") moveFocus(layer.current, -1);
    else if (event.key === "Tab") props.onClose();
    else return;
    event.preventDefault();
  };
  return createPortal(
    <div
      ref={layer}
      className="menu layer is-fixed"
      role="menu"
      aria-label={props.label}
      onKeyDown={onKeyDown}
      style={props.width === undefined ? undefined : { width: props.width }}
    >
      {props.children}
    </div>,
    document.body,
  );
}

/** One row of a {@link Menu}. */
export function MenuItem(props: {
  icon?: string;
  hint?: ReactNode;
  isDanger?: boolean;
  isActive?: boolean;
  role?: "menuitem" | "menuitemradio";
  disabled?: boolean;
  onSelect(): void;
  children: ReactNode;
}) {
  const role = props.role ?? "menuitem";
  return (
    <button
      type="button"
      className={`mi${props.isDanger ? " is-danger" : ""}${props.isActive ? " is-active" : ""}`}
      role={role}
      {...(role === "menuitemradio" && { "aria-checked": !!props.isActive })}
      disabled={props.disabled}
      onClick={props.onSelect}
    >
      {props.icon !== undefined && (
        <span className="g">
          <span className={`ic ${props.icon}`} />
        </span>
      )}
      <span className="ell">{props.children}</span>
      {props.hint !== undefined && <span className="k">{props.hint}</span>}
    </button>
  );
}

/** A popover with a header, sections (`.pb`) and an optional footer. */
export function Popover(props: {
  anchor: Anchor;
  label: string;
  title: ReactNode;
  footer?: ReactNode;
  onClose(): void;
  children: ReactNode;
}) {
  const layer = useRef<HTMLDivElement>(null);
  usePlacement(layer, props.anchor, "end");
  useDismiss(layer, props.anchor, props.onClose);
  useFocusReturn(layer, "button, a[href], input");
  return createPortal(
    <div
      ref={layer}
      className="pop layer is-fixed"
      role="dialog"
      aria-label={props.label}
    >
      <header>
        <h2>{props.title}</h2>
      </header>
      {props.children}
      {props.footer !== undefined && <footer>{props.footer}</footer>}
    </div>,
    document.body,
  );
}

/**
 * A modal dialog over a scrim. With `onSubmit` it is a form; Escape and a
 * press on the scrim close it.
 */
export function Dialog(props: {
  title: ReactNode;
  description?: ReactNode;
  role?: "dialog" | "alertdialog";
  onClose(): void;
  onSubmit?(): void;
  footer: ReactNode;
  children?: ReactNode;
  width?: number;
  /** The form's own accessible name, when it should differ from the title. */
  formLabel?: string;
}) {
  const layer = useRef<HTMLDivElement>(null);
  useDismiss(layer, undefined, props.onClose);
  useFocusReturn(layer, "input, textarea, select, .db button, footer button");
  const titleId = useId();
  const content = (
    <>
      <header>
        <h2 id={titleId}>{props.title}</h2>
        {props.description !== undefined && <p>{props.description}</p>}
      </header>
      {props.children !== undefined && (
        <div className="db">{props.children}</div>
      )}
      <footer>{props.footer}</footer>
    </>
  );
  return createPortal(
    <div className="scrim">
      <div
        ref={layer}
        className="dialog layer"
        role={props.role ?? "dialog"}
        aria-modal="true"
        aria-labelledby={titleId}
        style={props.width === undefined ? undefined : { width: props.width }}
      >
        {props.onSubmit ? (
          <form
            aria-label={props.formLabel ?? undefined}
            aria-labelledby={
              props.formLabel === undefined ? titleId : undefined
            }
            onSubmit={(event) => {
              event.preventDefault();
              props.onSubmit?.();
            }}
          >
            {content}
          </form>
        ) : (
          content
        )}
      </div>
    </div>,
    document.body,
  );
}

/** Opens a layer from an event; the same trigger closes it again. */
export function useLayer<T = undefined>() {
  const [open, setOpen] = useState<{ anchor: Anchor; value: T } | undefined>();
  return {
    open,
    show(anchor: Anchor, value: T) {
      setOpen((current) =>
        current?.anchor.kind === "element" &&
        anchor.kind === "element" &&
        current.anchor.element === anchor.element
          ? undefined
          : { anchor, value },
      );
    },
    close: () => setOpen(undefined),
  };
}

/** The toast stack; it also shows what plugins send through `ctx.ui.notify`. */
export function Toasts() {
  const { ui, toasts } = useHost();
  const list = useToasts(toasts);
  useEffect(() => ui.onNotice(toasts.show), [ui, toasts]);
  return createPortal(
    <div className="toasts" aria-live="polite">
      {list.map((toast) => (
        <div
          key={toast.id}
          className={`toast${toast.isLeaving ? " is-out" : ""}`}
          role="status"
        >
          <span>{toast.message}</span>
          {toast.action && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                toast.action?.run();
                toasts.dismiss(toast.id);
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      ))}
    </div>,
    document.body,
  );
}
