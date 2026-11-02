import { useState, type FormEvent } from "react";
import type { OrgRole } from "@docleus/sdk";
import { ApiError, api } from "../lib/api.ts";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  ROLE_LABELS,
  type AuthMethods,
  type Me,
} from "../lib/auth.tsx";
import { navigate, withQuery } from "../lib/router.ts";
import { useLoad } from "../lib/use-load.ts";
import { ErrorView } from "./error-view.tsx";
import { Link } from "./link.tsx";
import { ProviderButtons } from "./login.tsx";
import { Time } from "./time.tsx";
import { AuthLayout } from "./auth-layout.tsx";

interface InvitationInfo {
  readonly org: { readonly id: string; readonly name: string };
  readonly role: OrgRole;
  readonly email: string | null | undefined;
  readonly expiresAt: number;
}

async function loadMe(): Promise<Me> {
  try {
    return await api<Me>("GET", "/api/me");
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 401) {
      return { user: null, isAdmin: false };
    }
    throw cause;
  }
}

function AcceptForm(props: { token: string; invitation: InvitationInfo }) {
  const [isAccepting, setIsAccepting] = useState(false);
  const [error, setError] = useState<unknown>();
  const accept = async () => {
    setIsAccepting(true);
    setError(undefined);
    try {
      const { org } = await api<{ org: { id: string } }>(
        "POST",
        `/api/invitations/${encodeURIComponent(props.token)}/accept`,
      );
      navigate(`/orgs/${org.id}`, { replace: true });
    } catch (cause) {
      setError(cause);
      setIsAccepting(false);
    }
  };
  return (
    <>
      <button type="button" onClick={accept} disabled={isAccepting}>
        {isAccepting ? "Accepting…" : "Accept invitation"}
      </button>
      {error !== undefined && <ErrorView error={error} />}
    </>
  );
}

function SignupForm(props: { token: string; invitation: InvitationInfo }) {
  const fixedEmail = props.invitation.email ?? undefined;
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
      await api("POST", "/api/auth/signup", {
        invitation: props.token,
        name,
        password,
        ...(fixedEmail === undefined && { email }),
      });
      navigate(`/orgs/${props.invitation.org.id}`, { replace: true });
    } catch (cause) {
      setError(cause);
      setIsSubmitting(false);
    }
  };
  return (
    <form
      className="stacked-form"
      onSubmit={submit}
      aria-label="Create account"
    >
      <label>
        Name
        <input
          required
          autoComplete="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      {fixedEmail === undefined ? (
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
      ) : (
        <p>
          Email: <strong>{fixedEmail}</strong>
        </p>
      )}
      <label>
        Password
        <input
          type="password"
          required
          autoComplete="new-password"
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={PASSWORD_MAX_LENGTH}
          aria-describedby="signup-password-hint"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      <p id="signup-password-hint" className="notice">
        At least {PASSWORD_MIN_LENGTH} characters.
      </p>
      <button type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Creating account…" : "Create account"}
      </button>
      {error !== undefined && <ErrorView error={error} />}
    </form>
  );
}

/** `/invitations/:token`: join an org, signing up first when signed out. */
export function InvitationView(props: { token: string }) {
  const { token } = props;
  const here = `/invitations/${encodeURIComponent(token)}`;
  const invitation = useLoad(token, () =>
    api<InvitationInfo>("GET", `/api/invitations/${encodeURIComponent(token)}`),
  );
  const me = useLoad("me", loadMe);
  const methods = useLoad("methods", () =>
    api<AuthMethods>("GET", "/api/auth/methods"),
  );

  const notFound =
    invitation.error instanceof ApiError && invitation.error.status === 404;
  const error = notFound ? undefined : (invitation.error ?? me.error);
  const user = me.data?.user;

  return (
    <AuthLayout title="Invitation">
      {notFound && (
        <p role="alert" className="error">
          This invitation does not exist, has expired, or was already used.
        </p>
      )}
      {error !== undefined && <ErrorView error={error} />}
      {invitation.data && me.data && (
        <>
          <p>
            You are invited to join <strong>{invitation.data.org.name}</strong>{" "}
            as {ROLE_LABELS[invitation.data.role].toLowerCase()}.
          </p>
          <p className="notice">
            {invitation.data.email ? `For ${invitation.data.email}. ` : ""}
            Expires <Time at={invitation.data.expiresAt} />.
          </p>
          {user ? (
            <>
              <p>Signed in as {user.email}.</p>
              <AcceptForm token={token} invitation={invitation.data} />
            </>
          ) : (
            <>
              <h2>Create an account</h2>
              <SignupForm token={token} invitation={invitation.data} />
              {methods.data && (
                <ProviderButtons
                  methods={methods.data}
                  query={{ invitation: token, return: here }}
                />
              )}
              <p>
                Already have an account?{" "}
                <Link href={withQuery("/login", { return: here })}>
                  Sign in
                </Link>
              </p>
            </>
          )}
        </>
      )}
    </AuthLayout>
  );
}
