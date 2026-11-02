import type { Scope } from "./scope.ts";

/** A filter for scoped dispatch, returned by `installations.scope`. */
export interface DispatchScope {
  /** Whether hooks registered by `plugin` should run in this scope. */
  allows(plugin: string): boolean;
}

/**
 * Plugin installation, per-org and per-space enablement, settings, and scoped dispatch.
 *
 * @stability experimental
 */
export interface InstallationsService {
  /** Idempotent. */
  install(plugin: string): Promise<void>;
  /** Removes the plugin and all of its enablement and settings. */
  uninstall(plugin: string): Promise<void>;
  isInstalled(plugin: string): Promise<boolean>;
  listInstalled(): Promise<string[]>;
  /** `enabled: undefined` clears the override so the scope inherits again. Throws at instance scope or when the plugin is not installed. */
  setEnabled(
    plugin: string,
    scope: Scope,
    enabled: boolean | undefined,
  ): Promise<void>;
  /**
   * Space overrides org; org overrides the default of disabled. At instance scope an installed
   * plugin counts as enabled. A plugin that is not installed is never enabled.
   */
  isEnabled(plugin: string, scope: Scope): Promise<boolean>;
  /** `settings: undefined` clears them at this scope. Throws at instance scope or when the plugin is not installed. */
  setSettings(plugin: string, scope: Scope, settings: unknown): Promise<void>;
  /** The settings of the nearest scope that defines them, searching space, then org. */
  getSettings(plugin: string, scope: Scope): Promise<unknown>;
  /**
   * A synchronous filter for dispatching in `scope`. Installed plugins pass only when enabled;
   * plugins that are not installed (core and test plugins) always pass. Pass the result as the
   * first argument of a dispatch (`ctx.emit(filter, name, ...args)`); a listener belongs to the
   * nearest named plugin that registered it, matched against the installed name.
   */
  scope(
    scope: Scope,
  ): Promise<DispatchScope & { readonly [filter: symbol]: unknown }>;
}
