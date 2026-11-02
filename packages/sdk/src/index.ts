/**
 * The Cordis context a plugin receives in `apply`. Every registration goes
 * through it, so that it is undone when the plugin unloads.
 *
 * @stability experimental
 */
export { Context } from "@docleus/kernel";
/**
 * Base class of Cordis services. Use it only to implement a service.
 *
 * @stability experimental
 */
export { Service } from "@docleus/kernel";
/**
 * The error every Docleus API throws, with a stable `code` such as
 * `content/not-found`.
 *
 * @stability experimental
 */
export { DocleusError } from "@docleus/kernel";
export * from "./audit.ts";
export * from "./catalog.ts";
export * from "./declare.ts";
export * from "./editor-document.ts";
export * from "./manifest.ts";
export * from "./plugin.ts";
/**
 * The whole kernel, for code that needs Cordis internals the SDK does not
 * wrap. Not covered by any stability promise.
 *
 * @stability experimental
 */
export * as unstable_kernel from "@docleus/kernel";
export * from "./extension-points.ts";
export * from "./context.ts";
export * from "./services/index.ts";
export * from "./time.ts";
export * from "./track-caller.ts";
export * from "./zod.ts";
