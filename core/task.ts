// Tolerant task loader: YAML/JSON -> structured fields kept verbatim; anything else -> plain description.
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";

export type Task = {
  path: string;
  name: string;
  fields: Record<string, unknown>; // every field from the file, unknown ones included
  text: string; // what the model sees
};

export function loadTask(path: string): Task {
  const src = readFileSync(path, "utf8");
  const ext = extname(path).toLowerCase();
  let fields: Record<string, unknown> = {};
  if (ext === ".json" || ext === ".yaml" || ext === ".yml") {
    try {
      const parsed = ext === ".json" ? JSON.parse(src) : Bun.YAML.parse(src);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) fields = parsed as Record<string, unknown>;
    } catch {
      // unparseable structured file: fall through and treat as plain text
    }
  }
  return { path, name: basename(path, extname(path)), fields, text: src.trim() };
}
