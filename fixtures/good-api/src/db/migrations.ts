export const migrations: string[] = [
  `CREATE TABLE IF NOT EXISTS examples (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    UNIQUE (workspace_id, title)
  )`,
];
