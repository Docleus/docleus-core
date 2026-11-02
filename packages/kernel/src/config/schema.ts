import { z } from "zod";

export const ConfigRowSchema = z.strictObject({
  id: z.string().min(1),
  plugin: z.string().min(1),
  config: z.unknown().optional(),
  disabled: z.boolean().optional(),
});

export const ConfigPatchRowSchema = z.strictObject({
  id: z.string().min(1),
  plugin: z.string().min(1).optional(),
  config: z.unknown().optional(),
  disabled: z.boolean().optional(),
});

export type ConfigRow = z.infer<typeof ConfigRowSchema>;
export type ConfigPatchRow = z.infer<typeof ConfigPatchRowSchema>;
