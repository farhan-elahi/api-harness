export const migrations: string[] = [
  "CREATE TABLE IF NOT EXISTS widgets (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL UNIQUE)",
  "CREATE TABLE IF NOT EXISTS logs (id TEXT PRIMARY KEY, message TEXT NOT NULL)",
];
