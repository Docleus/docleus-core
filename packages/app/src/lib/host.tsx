import {
  createContext,
  useContext,
  useSyncExternalStore,
  type ComponentType,
} from "react";
import {
  DocleusError,
  type Context,
  type UiComponent,
  type UiSlots,
} from "@docleus/sdk";
import type { ToastStore } from "./toasts.ts";
import type { HostUiService } from "./ui-service.ts";
import type { createPluginLoader } from "./plugin-loader.ts";

export interface Host {
  readonly root: Context;
  readonly ui: HostUiService;
  readonly loader: ReturnType<typeof createPluginLoader>;
  readonly toasts: ToastStore;
}

export const HostContext = createContext<Host | undefined>(undefined);

export function useHost(): Host {
  const host = useContext(HostContext);
  if (!host)
    throw new DocleusError("app/no-host", "useHost() outside of <HostContext>");
  return host;
}

/** Re-renders when registrations change. */
export function useUiVersion(): number {
  const { ui } = useHost();
  return useSyncExternalStore(ui.subscribe, ui.version);
}

export function useSlot<Slot extends keyof UiSlots>(slot: Slot) {
  const { ui } = useHost();
  useUiVersion();
  return ui.slot(slot);
}

/** Plugin components are typed without React in the SDK. */
export function asComponent<Props>(component: UiComponent<Props>) {
  return component as unknown as ComponentType<Props>;
}
