import { useState, type FormEvent } from "react";
import { api } from "../lib/api.ts";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "../lib/auth.tsx";
import { navigate, useSearchParams } from "../lib/router.ts";
import { useLoad } from "../lib/use-load.ts";
import { ErrorView } from "./error-view.tsx";
import { Link } from "./link.tsx";
import { AuthLayout } from "./auth-layout.tsx";

function SetupForm() {
  const params = useSearchParams();
  const [token, setToken] = useState(params.get("token") ?? "");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<unknown>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setIsSubmitting(true);
    setError(undefined);
    try {
      await api("POST", "/api/setup", {
        token: token.trim(),
        name,
        email,
        password,
      });
      navigate("/", { replace: true });
    } catch (cause) {
      setError(cause);
      setIsSubmitting(false);
    }
  };
  return (
    <form className="stacked-form" onSubmit={submit} aria-label="Set up">
      <label>
        Setup token
        <input
          required
          autoComplete="off"
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
      </label>
      <p className="notice">
        The server printed the setup token in its log when it started.
      </p>
      <label>
        Name
        <input
          required
          autoComplete="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label>
        Email
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>
      <label>
        Password
        <input
          type="password"
          required
          autoComplete="new-password"
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={PASSWORD_MAX_LENGTH}
          aria-describedby="setup-password-hint"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      <p id="setup-password-hint" className="notice">
        At least {PASSWORD_MIN_LENGTH} characters.
      </p>
      <button type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Creating…" : "Create administrator"}
      </button>
      {error !== undefined && <ErrorView error={error} />}
    </form>
  );
}

/** First-run setup: creates the first user as an instance admin. */
export function Setup() {
  const setup = useLoad("setup", () =>
    api<{ required: boolean }>("GET", "/api/setup"),
  );
  return (
    <AuthLayout title="Set up Docleus">
      {setup.error !== undefined && <ErrorView error={setup.error} />}
      {setup.data?.required === false && (
        <p>
          This instance is already set up. <Link href="/login">Sign in</Link>
        </p>
      )}
      {setup.data?.required && (
        <>
          <p>
            Create the first account. It becomes the instance administrator.
          </p>
          <SetupForm />
        </>
      )}
    </AuthLayout>
  );
}
