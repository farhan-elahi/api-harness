// Every path a tool touches stays inside the project root and off secret files (.env*, *.pem, *.key, .git/).
import { isAbsolute, relative, resolve } from "node:path";
import { allow, block, defineHook, isSecretPath } from "../../core/sdk.ts";

export default defineHook({
  name: "path-guard",
  beforeTool: ({ call, root }) => {
    const paths = [call?.input.path, ...(Array.isArray(call?.input.files) ? call.input.files : [])].filter((p) => p !== undefined);
    for (const p of paths) {
      if (typeof p !== "string") return block(`path must be a string, got ${JSON.stringify(p)}`);
      const rel = relative(root, resolve(root, p));
      if (rel.startsWith("..") || isAbsolute(rel)) return block(`${p} is outside the project root`);
      if (isSecretPath(rel)) return block(`${p} is a secret file`);
    }
    return allow;
  },
});
