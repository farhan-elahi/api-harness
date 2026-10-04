import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    title: text("title").notNull(),
    body: text("body"),
  },
  (t) => [uniqueIndex("tasks_workspace_title").on(t.workspaceId, t.title)],
);
