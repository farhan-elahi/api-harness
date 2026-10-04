// Zod at every boundary: validate() for params/query/body, respond() for responses.
import type { Context, ValidationTargets } from "hono";
import { validator } from "hono/validator";
import type { z } from "zod";
import { problem } from "./problem.ts";

export const validate = <T extends keyof ValidationTargets, S extends z.ZodType>(target: T, schema: S) =>
  validator(target, (value, c) => {
    const r = schema.safeParse(value);
    if (!r.success)
      return problem(c, 422, "Validation failed", r.error.issues.map((i) => `${i.path.join(".") || target}: ${i.message}`).join("; "));
    return r.data as z.output<S>;
  });

export function respond<S extends z.ZodType>(c: Context, schema: S, data: z.input<S>, status: 200 | 201 = 200): Response {
  return c.json(schema.parse(data) as object, status);
}
