import { useEffect, type ReactNode } from "react";
import { ApiError, api } from "../lib/api.ts";
import { MeContext, type Me } from "../lib/auth.tsx";
import { asComponent, useHost, useUiVersion } from "../lib/host.tsx";
import { matchPath, navigate, usePath, withQuery } from "../lib/router.ts";
import { useLoad } from "../lib/use-load.ts";
import { usePlugins } from "../lib/use-plugins.ts";
import { AccountView } from "./account.tsx";
import { ErrorView } from "./error-view.tsx";
import { Frame, frontendOf } from "./frame.tsx";
import { InvitationView } from "./invitation.tsx";
import { Login } from "./login.tsx";
import { OrgHome, OrgList } from "./orgs.tsx";
import { SettingsLayout } from "./settings.tsx";
import { Setup } from "./setup.tsx";
import { SpaceView } from "./space-view.tsx";

/** Full-page apps belong to no space, so every installed plugin's frontend loads. */
function Apps(props: { rest: string }) {
  const { ui } = useHost();
  useUiVersion();
  const plugins = usePlugins("/api/frontend");
  // An app's first path segment after its own name is usually the org.
  const [path = "", ...rest] = props.rest.split("/");
  const orgId = rest[0];
  const frame = (children: ReactNode) => (
    <Frame {...(orgId !== undefined && orgId !== "" && { orgId })}>
      {children}
    </Frame>
  );
  if (plugins.error !== undefined) {
    return frame(
      <div className="settings">
        <ErrorView error={plugins.error} />
      </div>,
    );
  }
  if (!plugins.isReady) return frame(<p className="loading">Loading…</p>);
  const app = ui.apps().find((candidate) => candidate.path === path);
  if (!app) {
    return frame(
      <div className="settings">
        <p role="alert">No app at /apps/{path}.</p>
      </div>,
    );
  }
  const Page = asComponent(app.component);
  return frame(<Page path={rest.join("/")} />);
}

function Routes(props: { path: string; onMeChange(): void }) {
  const { path } = props;
  let params: Record<string, string> | undefined;

  if (
    (params = matchPath("/orgs/:orgId/spaces/:spaceId/pages/:pageId", path))
  ) {
    return (
      <SpaceView
        key={`${params.orgId}/${params.spaceId}`}
        orgId={params.orgId ?? ""}
        spaceId={params.spaceId ?? ""}
        pageId={params.pageId ?? ""}
      />
    );
  }
  if ((params = matchPath("/orgs/:orgId/spaces/:spaceId/settings/*", path))) {
    return (
      <SpaceView
        key={`${params.orgId}/${params.spaceId}`}
        orgId={params.orgId ?? ""}
        spaceId={params.spaceId ?? ""}
        settings={params["*"] ?? ""}
      />
    );
  }
  if ((params = matchPath("/orgs/:orgId/spaces/:spaceId", path))) {
    return (
      <SpaceView
        key={`${params.orgId}/${params.spaceId}`}
        orgId={params.orgId ?? ""}
        spaceId={params.spaceId ?? ""}
      />
    );
  }
  if ((params = matchPath("/orgs/:orgId/settings/*", path))) {
    return (
      <SettingsLayout orgId={params.orgId ?? ""} section={params["*"] ?? ""} />
    );
  }
  if ((params = matchPath("/orgs/:orgId", path))) {
    return <OrgHome key={params.orgId} orgId={params.orgId ?? ""} />;
  }
  if ((params = matchPath("/settings/*", path))) {
    return <SettingsLayout orgId={undefined} section={params["*"] ?? ""} />;
  }
  if (path === "/account") {
    return (
      <Frame frontend={frontendOf(undefined)}>
        <AccountView onChange={props.onMeChange} />
      </Frame>
    );
  }
  if ((params = matchPath("/apps/*", path))) {
    return <Apps rest={params["*"] ?? ""} />;
  }
  if (path === "/") return <OrgList />;
  return (
    <Frame>
      <div className="settings">
        <p role="alert">Not found.</p>
      </div>
    </Frame>
  );
}

function toLogin(): void {
  navigate(
    withQuery("/login", { return: location.pathname + location.search }),
    {
      replace: true,
    },
  );
}

function SignedIn(props: { path: string }) {
  const me = useLoad("me", () => api<Me>("GET", "/api/me"));
  const isSignedOut =
    (me.error instanceof ApiError && me.error.status === 401) ||
    me.data?.user === null;
  useEffect(() => {
    if (isSignedOut) toLogin();
  }, [isSignedOut]);
  if (isSignedOut) return null;
  if (me.error !== undefined) return <ErrorView error={me.error} />;
  if (!me.data?.user) return null;
  return (
    <MeContext value={me.data}>
      <Routes path={props.path} onMeChange={me.reload} />
    </MeContext>
  );
}

export function App() {
  const path = usePath();
  if (path === "/login") return <Login />;
  if (path === "/setup") return <Setup />;
  const invitation = matchPath("/invitations/:token", path);
  if (invitation) return <InvitationView token={invitation.token ?? ""} />;
  return <SignedIn path={path} />;
}
