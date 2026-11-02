import type { Scope } from "@docleus/sdk";
import { api } from "../lib/api.ts";
import { useLoad } from "../lib/use-load.ts";
import { ErrorView } from "./error-view.tsx";

interface PluginRow {
  readonly name: string;
  readonly version: string;
  readonly hasEditor: boolean;
  readonly enabled: boolean;
  readonly inherited?: boolean;
}

function apiBaseOf(scope: Scope): string | undefined {
  if (scope.kind === "org") return `/api/orgs/${scope.orgId}`;
  if (scope.kind === "space")
    return `/api/orgs/${scope.orgId}/spaces/${scope.spaceId}`;
  return undefined;
}

/** The plugins of an org (on or off) or a space (same as the org, on or off), with one control for both. */
export function PluginSettings(props: { scope: Scope; onChange?(): void }) {
  const base = apiBaseOf(props.scope);
  const plugins = useLoad(base ?? "", () =>
    api<{ plugins: PluginRow[] }>("GET", `${base}/plugins`),
  );
  const set = (plugin: string, enabled: boolean | null) => {
    api("PUT", `${base}/plugins`, { plugin, enabled }).then(() => {
      plugins.reload();
      props.onChange?.();
    }, plugins.reload);
  };
  if (plugins.error !== undefined) return <ErrorView error={plugins.error} />;
  const isSpace = props.scope.kind === "space";
  return (
    <table className="table tbl plugins" aria-label="Plugins">
      <tbody>
        {plugins.data?.plugins.map((plugin) => (
          <tr key={plugin.name}>
            <td>
              <strong>{plugin.name.replace(/^@[^/]+\/plugin-/, "")}</strong>
              <br />
              <span className="muted mono">{plugin.name}</span>
            </td>
            <td className="mono">{plugin.version}</td>
            <td className="act">
              <span
                className="seg"
                role="group"
                aria-label={`Enable ${plugin.name}`}
              >
                {(isSpace
                  ? (["inherit", "on", "off"] as const)
                  : (["on", "off"] as const)
                ).map((choice) => {
                  const current =
                    isSpace && plugin.enabled === plugin.inherited
                      ? "inherit"
                      : plugin.enabled
                        ? "on"
                        : "off";
                  return (
                    <button
                      key={choice}
                      type="button"
                      aria-pressed={current === choice}
                      title={
                        choice === "inherit"
                          ? `The organization has it ${plugin.inherited ? "on" : "off"}`
                          : undefined
                      }
                      onClick={() =>
                        current !== choice &&
                        set(
                          plugin.name,
                          choice === "inherit" ? null : choice === "on",
                        )
                      }
                    >
                      {choice === "inherit"
                        ? "Same as organization"
                        : choice === "on"
                          ? "On"
                          : "Off"}
                    </button>
                  );
                })}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
