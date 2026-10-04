// ts-morph program for the project under work (underscore = not a plugin). Fresh per call: files change between turns.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Project } from "ts-morph";

export function project(root: string): Project {
  const tsconfig = join(root, "tsconfig.json");
  if (!existsSync(tsconfig)) throw new Error("no tsconfig.json in the project");
  return new Project({ tsConfigFilePath: tsconfig });
}
