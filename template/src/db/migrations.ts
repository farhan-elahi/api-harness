// CREATE TABLE statements matching schema.ts, run in order at startup.
export const migrations: string[] = [
  `CREATE TABLE IF NOT EXISTS examples (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL)`,
];
