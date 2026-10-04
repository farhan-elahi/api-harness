// Fixtures are overlays on template/: assemble one into a temp dir (template + overlay, node_modules symlinked).
// CLI: bun scripts/fixture.ts good-api  -> prints the assembled dir
import { cpSync, existsSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

export function assemble(name: string): string {
  const overlay = join(ROOT, "fixtures", name);
  if (!existsSync(overlay)) throw new Error(`no fixture: ${name}`);
  if (!existsSync(join(ROOT, "template/node_modules"))) throw new Error("template deps missing: run npm run setup");
  const dir = mkdtempSync(join(tmpdir(), `harness-${name}-`));
  cpSync(join(ROOT, "template"), dir, { recursive: true, filter: (src) => !src.includes("node_modules") });
  symlinkSync(join(ROOT, "template/node_modules"), join(dir, "node_modules"), "dir");
  cpSync(overlay, dir, { recursive: true });
  return dir;
}

if (import.meta.main) console.log(assemble(process.argv[2] ?? ""));
