import { useState, type FormEvent } from "react";
import { ApiError, api } from "../lib/api.ts";
import type { AuthMethods } from "../lib/auth.tsx";
import {
  navigate,
  safeReturnPath,
  useSearchParams,
  withQuery,
} from "../lib/router.ts";
import { LANDING } from "../lib/last-place.ts";
import { useLoad } from "../lib/use-load.ts";
import { ErrorView } from "./error-view.tsx";
import { Redirect } from "./redirect.tsx";
import { AuthLayout } from "./auth-layout.tsx";

const REDIRECT_ERRORS: Readonly<Record<string, string>> = {
  "oidc-signup-required":
    "There is no account for this sign-in yet. Ask an administrator for an invitation.",
  "oidc-email-unverified":
    "An account with this email exists, but the provider has not verified the email, so it cannot be linked.",
  "oidc-failed": "Signing in with the provider failed. Try again.",
};

const API_ERRORS: Readonly<Record<string, string>> = {
  "auth/invalid-credentials": "Wrong email or password.",
  "auth/rate-limited": "Too many failed attempts. Wait a while and try again.",
};

/** A readable message for an `?error=` code that a sign-in redirect set. */
export function redirectErrorMessage(code: string): string {
  return REDIRECT_ERRORS[code] ?? `Sign-in failed (${code}).`;
}

function SignInError(props: { error: unknown }) {
  const { error } = props;
  const message =
    error instanceof ApiError && error.code !== undefined
      ? API_ERRORS[error.code]
      : undefined;
  if (message === undefined) return <ErrorView error={error} />;
  return (
    <p role="alert" className="error">
      {message}
    </p>
  );
}

export function ProviderButtons(props: {
  methods: AuthMethods;
  query: Readonly<Record<string, string>>;
}) {
  if (props.methods.providers.length === 0) return null;
  return (
    <ul className="providers">
      {props.methods.providers.map((provider) => (
        <li key={provider.id}>
          <a
            className="button"
            href={withQuery(provider.display.href, props.query)}
          >
            Sign in with {provider.display.label}
          </a>
        </li>
      ))}
    </ul>
  );
}

function PasswordForm(props: { returnTo: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<unknown>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setIsSubmitting(true);
    setError(undefined);
    try {
      await api("POST", "/api/auth/login", { email, password });
      navigate(props.returnTo, { replace: true });
    } catch (cause) {
      setError(cause);
      setIsSubmitting(false);
    }
  };
  return (
    <form onSubmit={submit} aria-label="Sign in with password">
      <label>
        Email
        <input
          type="email"
          name="email"
          autoComplete="username"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>
      <label>
        Password
        <input
          type="password"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      <button type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Signing in…" : "Sign in"}
      </button>
      {error !== undefined && <SignInError error={error} />}
    </form>
  );
}

function DevForm(props: { returnTo: string }) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<unknown>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    try {
      await api("POST", "/api/auth/dev-login", { email });
      navigate(props.returnTo, { replace: true });
    } catch (cause) {
      setError(cause);
    }
  };
  return (
    <form onSubmit={submit} aria-label="Development sign-in">
      <p className="notice">
        Development login: any email signs in as an instance admin.
      </p>
      <label>
        Email
        <input
          type="email"
          name="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>
      <button type="submit">Sign in</button>
      {error !== undefined && <ErrorView error={error} />}
    </form>
  );
}

export function Login() {
  const params = useSearchParams();
  // Without a return path, sign-in lands where the user left off.
  const returnTo = params.has("return")
    ? safeReturnPath(params.get("return"))
    : LANDING;
  const redirectError = params.get("error");
  const methods = useLoad("methods", () =>
    api<AuthMethods>("GET", "/api/auth/methods"),
  );
  if (methods.data?.setupRequired) return <Redirect to="/setup" />;
  const hasAnyMethod =
    methods.data !== undefined &&
    (methods.data.password ||
      methods.data.dev ||
      methods.data.providers.length > 0);

  return (
    <AuthLayout title="Sign in to Docleus">
      {redirectError && (
        <p role="alert" className="error">
          {redirectErrorMessage(redirectError)}
        </p>
      )}
      {methods.error !== undefined && <ErrorView error={methods.error} />}
      {methods.data && (
        <>
          <ProviderButtons
            methods={methods.data}
            query={{ return: returnTo }}
          />
          {methods.data.providers.length > 0 &&
            (methods.data.password || methods.data.dev) && (
              <p className="or">or</p>
            )}
          {methods.data.password && <PasswordForm returnTo={returnTo} />}
          {methods.data.dev && <DevForm returnTo={returnTo} />}
          {!hasAnyMethod && (
            <p>No sign-in method is configured on this instance.</p>
          )}
        </>
      )}
    </AuthLayout>
  );
}
