import { useState, type FormEvent } from "react";
import { api } from "../lib/api.ts";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  useMe,
} from "../lib/auth.tsx";
import { ErrorView } from "./error-view.tsx";

function PasswordForm(props: { hasPassword: boolean; onChanged(): void }) {
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<unknown>();
  const isMismatch = confirmation !== "" && confirmation !== password;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password !== confirmation) return;
    setIsSaving(true);
    setStatus("");
    setError(undefined);
    try {
      await api("PUT", "/api/me/password", {
        ...(props.hasPassword && { current }),
        password,
      });
      setCurrent("");
      setPassword("");
      setConfirmation("");
      setStatus("Password changed. Other sessions were signed out.");
      props.onChanged();
    } catch (cause) {
      setError(cause);
    } finally {
      setIsSaving(false);
    }
  };
  return (
    <form
      className="stacked-form"
      onSubmit={submit}
      aria-label={props.hasPassword ? "Change password" : "Set a password"}
    >
      {props.hasPassword && (
        <label>
          Current password
          <input
            type="password"
            required
            autoComplete="current-password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
          />
        </label>
      )}
      <label>
        New password
        <input
          type="password"
          required
          autoComplete="new-password"
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={PASSWORD_MAX_LENGTH}
          aria-describedby="account-password-hint"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      <p id="account-password-hint" className="notice">
        At least {PASSWORD_MIN_LENGTH} characters.
      </p>
      <label>
        Confirm new password
        <input
          type="password"
          required
          autoComplete="new-password"
          aria-invalid={isMismatch}
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        />
      </label>
      {isMismatch && (
        <p role="alert" className="error">
          The passwords do not match.
        </p>
      )}
      <button type="submit" disabled={isSaving || isMismatch}>
        {isSaving ? "Saving…" : "Save password"}
      </button>
      <span role="status" className="notice">
        {status}
      </span>
      {error !== undefined && <ErrorView error={error} />}
    </form>
  );
}

/** The signed-in user's account: profile details and password. */
export function AccountView(props: { onChange(): void }) {
  const me = useMe();
  const user = me?.user;
  if (!user) return null;
  return (
    <div className="settings acct">
      <h1>Account</h1>
      <section className="section" aria-label="Profile">
        <header>
          <h2>Profile</h2>
        </header>
        <div className="row">
          <div className="label">
            <strong>Name</strong>
          </div>
          <div className="control">{user.name}</div>
        </div>
        <div className="row">
          <div className="label">
            <strong>Email</strong>
          </div>
          <div className="control">{user.email}</div>
        </div>
      </section>
      <section className="section" aria-label="Password">
        <header>
          <h2>{user.hasPassword ? "Change password" : "Set a password"}</h2>
        </header>
        <div className="section-body">
          {!user.hasPassword && (
            <p className="notice">
              You sign in through a provider. A password lets you also sign in
              with your email.
            </p>
          )}
          <PasswordForm
            hasPassword={user.hasPassword}
            onChanged={props.onChange}
          />
        </div>
      </section>
    </div>
  );
}
