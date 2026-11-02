import { useState } from "react";
import { api, errorOf, request } from "../lib/api.ts";
import { plural } from "../lib/format.ts";
import { useLoad } from "../lib/use-load.ts";
import { ErrorView } from "./error-view.tsx";
import { Dialog } from "./layers.tsx";

type PluginSource =
  | { readonly type: "path"; readonly path: string }
  | { readonly type: "tarball"; readonly filename?: string }
  | {
      readonly type: "git";
      readonly url: string;
      readonly ref: string;
      readonly commit: string;
    };

interface InstalledPlugin {
  readonly name: string;
  readonly version: string;
  readonly hasEditor: boolean;
  readonly isInstalled: boolean;
  readonly source?: PluginSource;
}

function installedMessage(plugin: InstalledPlugin): string {
  return `Installed ${plugin.name} ${plugin.version}. Enable it in an organization's plugin settings.`;
}

function describeSource(plugin: InstalledPlugin): string {
  const { source } = plugin;
  if (!source) return "Bundled";
  if (source.type === "path") return `Path ${source.path}`;
  if (source.type === "git") {
    return `Git ${source.url} ${source.ref} (${source.commit.slice(0, 7)})`;
  }
  return source.filename ? `Upload ${source.filename}` : "Upload";
}

type Install =
  | { readonly kind: "upload"; readonly file: File }
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "git"; readonly url: string; readonly ref: string };

async function install(input: Install): Promise<InstalledPlugin> {
  if (input.kind === "upload") {
    const response = await request(
      `/api/plugins/upload?filename=${encodeURIComponent(input.file.name)}`,
      {
        method: "POST",
        body: input.file,
        headers: { "content-type": "application/gzip" },
      },
    );
    if (!response.ok) throw await errorOf(response);
    return ((await response.json()) as { plugin: InstalledPlugin }).plugin;
  }
  const body =
    input.kind === "path"
      ? { type: "path", path: input.path }
      : { type: "git", url: input.url, ref: input.ref };
  const { plugin } = await api<{ plugin: InstalledPlugin }>(
    "POST",
    "/api/plugins",
    body,
  );
  return plugin;
}

/** The instance's mounted plugins, with installs and uninstalls that apply without a restart. */
export function InstancePlugins() {
  const plugins = useLoad("instance-plugins", () =>
    api<{ plugins: InstalledPlugin[] }>("GET", "/api/plugins"),
  );
  const [file, setFile] = useState<File | undefined>();
  const [path, setPath] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [gitRef, setGitRef] = useState("main");
  const [isBusy, setIsBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<unknown>();
  const [isInstalling, setIsInstalling] = useState(false);
  const [source, setSource] = useState<"upload" | "path" | "git">("upload");

  const run = async (task: () => Promise<string>) => {
    setIsBusy(true);
    setStatus("");
    setError(undefined);
    try {
      setStatus(await task());
    } catch (cause) {
      setError(cause);
    } finally {
      setIsBusy(false);
      plugins.reload();
    }
  };
  const installNow = (value: Install) => {
    void run(async () => {
      const plugin = await install(value);
      setIsInstalling(false);
      setFile(undefined);
      setPath("");
      setGitUrl("");
      return installedMessage(plugin);
    });
  };
  const canInstall =
    source === "upload"
      ? file !== undefined
      : source === "path"
        ? path.trim() !== ""
        : gitUrl.trim() !== "" && gitRef.trim() !== "";
  const uninstall = (plugin: InstalledPlugin) => {
    if (!window.confirm(`Uninstall ${plugin.name}? Its settings are removed.`))
      return;
    void run(async () => {
      await api("DELETE", `/api/plugins/${encodeURIComponent(plugin.name)}`);
      return `Uninstalled ${plugin.name}.`;
    });
  };

  if (plugins.error !== undefined) return <ErrorView error={plugins.error} />;
  if (!plugins.data) return null;
  const sourceLabel = { upload: "Upload", path: "Server path", git: "Git" };
  return (
    <section className="section instance-plugins" aria-label="Plugins">
      <header>
        <h2>{plural(plugins.data.plugins.length, "plugin")}</h2>
        <span role="status" className="hint">
          {isBusy ? "Working…" : status}
        </span>
        <button
          type="button"
          className="btn is-primary"
          onClick={() => {
            setError(undefined);
            setIsInstalling(true);
          }}
        >
          Install a plugin…
        </button>
      </header>
      <table className="table tbl plugins" aria-label="Installed plugins">
        <thead>
          <tr>
            <th>Plugin</th>
            <th>Version</th>
            <th>Source</th>
            <th>
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {plugins.data.plugins.map((plugin) => (
            <tr key={plugin.name}>
              <td>
                <strong>{plugin.name.replace(/^@[^/]+\/plugin-/, "")}</strong>
                <br />
                <span className="muted mono">{plugin.name}</span>
              </td>
              <td className="mono">{plugin.version}</td>
              <td className="muted">{describeSource(plugin)}</td>
              <td className="act">
                {plugin.isInstalled && (
                  <button
                    type="button"
                    className="btn is-quiet"
                    disabled={isBusy}
                    aria-label={`Uninstall ${plugin.name}`}
                    onClick={() => uninstall(plugin)}
                  >
                    Uninstall
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!isInstalling && error !== undefined && (
        <div className="row">
          <ErrorView error={error} />
        </div>
      )}
      {isInstalling && (
        <Dialog
          title="Install a plugin"
          description="Runs in-process with full access. Install only plugins you trust."
          width={520}
          formLabel={
            source === "upload"
              ? "Upload plugin"
              : source === "path"
                ? "Install from a path"
                : "Install from Git"
          }
          onClose={() => setIsInstalling(false)}
          onSubmit={() => {
            const value: Install | undefined =
              source === "upload"
                ? file && { kind: "upload", file }
                : source === "path"
                  ? path.trim()
                    ? { kind: "path", path: path.trim() }
                    : undefined
                  : gitUrl.trim() && gitRef.trim()
                    ? { kind: "git", url: gitUrl.trim(), ref: gitRef.trim() }
                    : undefined;
            if (value) installNow(value);
          }}
          footer={
            <>
              <button
                type="button"
                className="btn"
                onClick={() => setIsInstalling(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn is-primary"
                disabled={isBusy || !canInstall}
              >
                {isBusy ? "Installing…" : "Install"}
              </button>
            </>
          }
        >
          <span className="seg" role="group" aria-label="Source">
            {(["upload", "path", "git"] as const).map((each) => (
              <button
                key={each}
                type="button"
                aria-pressed={source === each}
                onClick={() => setSource(each)}
              >
                {sourceLabel[each]}
              </button>
            ))}
          </span>
          {source === "upload" && (
            <label className="field">
              <span>Tarball (.tgz)</span>
              <input
                className="input"
                type="file"
                accept=".tgz,application/gzip"
                onChange={(event) => setFile(event.target.files?.[0])}
              />
            </label>
          )}
          {source === "path" && (
            <label className="field">
              <span>Server path</span>
              <input
                className="input mono"
                value={path}
                placeholder="/srv/docleus/plugins/my-plugin"
                onChange={(event) => setPath(event.target.value)}
              />
            </label>
          )}
          {source === "git" && (
            <>
              <label className="field">
                <span>Git URL</span>
                <input
                  className="input mono"
                  value={gitUrl}
                  placeholder="https://github.com/acme/plugin-stamp.git"
                  onChange={(event) => setGitUrl(event.target.value)}
                />
              </label>
              <label className="field">
                <span>Ref</span>
                <input
                  className="input mono"
                  value={gitRef}
                  onChange={(event) => setGitRef(event.target.value)}
                />
              </label>
            </>
          )}
          {error !== undefined && <ErrorView error={error} />}
        </Dialog>
      )}
    </section>
  );
}
