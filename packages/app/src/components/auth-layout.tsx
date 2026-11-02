import type { ReactNode } from "react";

/**
 * Sign-in, setup and invitation: the form on the left, a sample page on the
 * right so the first screen already shows what the product makes.
 */
export function AuthLayout(props: {
  title: string;
  sub?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="split">
      <main className="form-col">
        <a className="mark" href="/">
          Docleus
        </a>
        <div className="inner">
          <div>
            <h1>{props.title}</h1>
            {props.sub !== undefined && <p className="sub">{props.sub}</p>}
            {props.children}
          </div>
        </div>
        <p className="foot">Self-hosted documentation.</p>
      </main>
      <aside className="proof" aria-hidden="true">
        <div className="sheet">
          <h2>Deploying to production</h2>
          <p>
            Merge to main, then publish the handbook. Readers get the new page
            the moment the site rebuilds.
          </p>
          <p>
            Every change is a draft first, so nothing goes live by accident.
          </p>
        </div>
        <p className="cap">Pages, drafts and sites in one place.</p>
      </aside>
    </div>
  );
}
