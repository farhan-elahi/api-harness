import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const widgets = sqliteTable("widgets", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  name: text("name").notNull().unique(),
});

export const logs = sqliteTable("logs", { // ✗ tenant-isolation
  id: text("id").primaryKey(),
  message: text("message").notNull(),
});
