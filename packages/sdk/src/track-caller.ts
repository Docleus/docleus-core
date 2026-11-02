import { Service, type Context } from "@docleus/kernel";

/** A service object whose methods can read the calling plugin's context. */
export interface CallerAware {
  /**
   * The context of the plugin that accessed the service through `ctx.<key>`,
   * or the owner when the object is used directly.
   */
  readonly ctx: Context;
}

/**
 * Marks a plain service object so that, when another plugin reaches it
 * through `ctx.<key>`, `this.ctx` inside its methods is that plugin's
 * context. Use `this.ctx.effect(...)` for registrations so they are undone
 * when the registering plugin unloads, not when the provider does. Methods
 * that read `this` must be called as methods, not destructured.
 *
 * @stability experimental
 */
export function trackCaller<T extends object>(
  owner: Context,
  service: T & ThisType<T & CallerAware>,
): T & CallerAware {
  const tracked = Object.assign(service, { ctx: owner });
  Object.defineProperty(tracked, Service.tracker, {
    value: { property: "ctx", noShadow: true },
  });
  return tracked;
}
