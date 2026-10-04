// Drizzle tables. Every table has a workspace_id column; every query filters by it.
import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const notes = sqliteTable(
  "notes",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    title: text("title").notNull(),
    body: text("body"),
  },
  (table) => ({
    notesWorkspaceTitleUnique: uniqueIndex("notes_workspace_title_unique").on(table.workspaceId, table.title),
  }),
);
