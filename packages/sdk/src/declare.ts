import type { Context } from "@docleus/kernel";

/**
 * How listeners of an event run: `emit` (all, sync, results ignored),
 * `waterfall` (each transforms the value), `parallel` (all, concurrently),
 * `serial` (all, in order) or `bail` (until one returns a value).
 *
 * @stability experimental
 */
export type DispatchMode =
  "emit" | "waterfall" | "parallel" | "serial" | "bail";
/**
 * Whether an extension point may still change (`experimental`) or follows
 * semantic versioning (`stable`).
 *
 * @stability experimental
 */
export type Stability = "experimental" | "stable";

/**
 * Declares an event: its name, dispatch mode, stability and description.
 * Listed in the extension catalog.
 *
 * @stability experimental
 */
export interface EventDeclaration<Name extends string = string> {
  readonly kind: "event";
  readonly name: Name;
  readonly mode: DispatchMode;
  readonly stability: Stability;
  readonly description: string;
}

/**
 * Declares a service by its `ctx` key, with the service type carried in `T`.
 * Listed in the extension catalog.
 *
 * @stability experimental
 */
export interface ServiceDeclaration<Name extends string = string, T = unknown> {
  readonly kind: "service";
  readonly name: Name;
  readonly stability: Stability;
  readonly description: string;
  readonly _type?: T;
}

/**
 * An event or service declaration.
 *
 * @stability experimental
 */
export type ExtensionPoint = EventDeclaration | ServiceDeclaration;

/**
 * Declares an event. Use the result with {@link dispatch} and list it in
 * the extension points of the package that owns it.
 *
 * @stability experimental
 */
export function defineEvent<const Name extends string>(
  declaration: Omit<EventDeclaration<Name>, "kind">,
): EventDeclaration<Name> {
  return { kind: "event", ...declaration };
}

/**
 * Declares a service whose value has type `T`.
 *
 * @stability experimental
 */
export function defineService<T, const Name extends string = string>(
  declaration: Omit<ServiceDeclaration<Name, T>, "kind" | "_type">,
): ServiceDeclaration<Name, T> {
  return { kind: "service", ...declaration };
}

type Dispatcher = (name: string, ...args: unknown[]) => unknown;

/**
 * Dispatches `event` with the mode it was declared with.
 *
 * @stability experimental
 */
export function dispatch(
  ctx: Context,
  event: EventDeclaration,
  ...args: unknown[]
): unknown {
  const method = (ctx as unknown as Record<DispatchMode, Dispatcher>)[
    event.mode
  ];
  return method.call(ctx, event.name, ...args);
}

/**
 * Provides `value` as `service` on `ctx`. Returns a function that withdraws
 * it; the provision is also undone when `ctx` is disposed.
 *
 * @stability experimental
 */
export function provideService<T>(
  ctx: Context,
  service: ServiceDeclaration<string, T>,
  value: T,
): () => void {
  return ctx.provide(service.name, value);
}

/**
 * The current value of `service` on `ctx`. Throws when no plugin provides it.
 *
 * @stability experimental
 */
export function useService<T>(
  ctx: Context,
  service: ServiceDeclaration<string, T>,
): T {
  const value = ctx.get(service.name) as T | undefined;
  if (value === undefined) {
    throw new Error(`service "${service.name}" is not available`);
  }
  return value;
}
