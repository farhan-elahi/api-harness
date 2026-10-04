// Cursor pagination: order by id, fetch limit + 1, cursor = opaque last id.
import { z } from "zod";
import { ProblemError } from "./problem.ts";

export const cursorQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const page = <S extends z.ZodType>(item: S) => z.object({ data: z.array(item), next_cursor: z.string().nullable() });

export const encodeCursor = (id: string): string => Buffer.from(id).toString("base64url");

export function decodeCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined;
  const id = Buffer.from(cursor, "base64url").toString();
  if (!id || encodeCursor(id) !== cursor) throw new ProblemError(422, "Validation failed", "cursor: invalid");
  return id;
}

// rows must be fetched with .limit(limit + 1).
export function paginate<T extends { id: string }>(rows: T[], limit: number): { data: T[]; next_cursor: string | null } {
  const data = rows.slice(0, limit);
  const last = data.at(-1);
  return { data, next_cursor: rows.length > limit && last ? encodeCursor(last.id) : null };
}
