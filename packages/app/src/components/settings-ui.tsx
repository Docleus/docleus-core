import { useEffect, type ReactNode } from "react";
import { ErrorView } from "./error-view.tsx";

/** A settings section: a titled box of label/control rows. */
export function Section(props: {
  id?: string;
  title: ReactNode;
  aside?: ReactNode;
  isDanger?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      id={props.id}
      className={`section${props.isDanger ? " is-danger" : ""}`}
      aria-label={typeof props.title === "string" ? props.title : undefined}
    >
      <header>
        <h2>{props.title}</h2>
        {props.aside}
      </header>
      {props.children}
    </section>
  );
}

/** One label/control row of a {@link Section}. */
export function Row(props: {
  label: ReactNode;
  hint?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="row">
      <div className="label">
        {props.htmlFor ? (
          <label htmlFor={props.htmlFor}>
            <strong>{props.label}</strong>
          </label>
        ) : (
          <strong>{props.label}</strong>
        )}
        {props.hint !== undefined && <small>{props.hint}</small>}
      </div>
      <div className="control">{props.children}</div>
    </div>
  );
}

/** The bar under a form with unsaved changes. */
export function SaveBar(props: {
  isBusy: boolean;
  onDiscard(): void;
  error?: unknown;
}) {
  return (
    <footer className="savebar">
      {props.error !== undefined ? (
        <ErrorView error={props.error} />
      ) : (
        <span className="muted">Unsaved changes</span>
      )}
      <button type="button" className="btn" onClick={props.onDiscard}>
        Discard
      </button>
      <button type="submit" className="btn is-primary" disabled={props.isBusy}>
        Save changes
      </button>
    </footer>
  );
}

/** Scrolls to `#<section>` once the settings have rendered. */
export function useScrollToSection(section: string, isReady: boolean): void {
  useEffect(() => {
    if (!isReady) return;
    const id = section || location.hash.slice(1);
    if (id) document.getElementById(id)?.scrollIntoView({ block: "start" });
  }, [section, isReady]);
}
