import type { Context } from "@docleus/kernel";
import { z } from "zod";
import type { ServiceDeclaration } from "./declare.ts";

type ServiceRef = string | ServiceDeclaration;

/**
 * What a plugin passes to {@link definePlugin}: its name, an optional zod
 * config schema, the services it injects and provides, and `apply`.
 *
 * @stability experimental
 */
export interface PluginDefinition<Schema extends z.ZodType> {
  name: string;
  config?: Schema;
  inject?: readonly ServiceRef[];
  provides?: readonly ServiceRef[];
  apply(ctx: Context, config: z.output<Schema>): void | Promise<void>;
}

/**
 * A plugin in the form the kernel loads.
 *
 * @stability experimental
 */
export interface DocleusPlugin<Config = unknown> {
  readonly name: string;
  readonly Config?: z.ZodType;
  readonly inject?: string[];
  readonly provide?: string[];
  apply(ctx: Context, config: Config): void | Promise<void>;
}

const nameOf = (ref: ServiceRef): string =>
  typeof ref === "string" ? ref : ref.name;

/**
 * Builds a plugin from its definition. A missing config is parsed as `{}`,
 * so schema defaults apply.
 *
 * @stability experimental
 */
export function definePlugin<Schema extends z.ZodType>(
  definition: PluginDefinition<Schema>,
): DocleusPlugin<z.output<Schema>> {
  return {
    name: definition.name,
    apply: definition.apply,
    ...(definition.config && {
      Config: z.preprocess((value) => value ?? {}, definition.config),
    }),
    ...(definition.inject && { inject: definition.inject.map(nameOf) }),
    ...(definition.provides && { provide: definition.provides.map(nameOf) }),
  };
}
