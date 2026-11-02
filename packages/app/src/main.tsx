import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Context } from "@docleus/sdk";
import { App } from "./components/app.tsx";
import { HostContext, type Host } from "./lib/host.tsx";
import { installMotion } from "./lib/motion.ts";
import { createPluginLoader } from "./lib/plugin-loader.ts";
import { createToastStore } from "./lib/toasts.ts";
import { createUiService } from "./lib/ui-service.ts";

const root = new Context();
const ui = createUiService(root);
root.provide("ui", ui);
const toasts = createToastStore();
const host: Host = { root, ui, loader: createPluginLoader(root), toasts };
installMotion(document);

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <HostContext value={host}>
        <App />
      </HostContext>
    </StrictMode>,
  );
}
