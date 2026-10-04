import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { defineTool, inRoot } from "../../core/sdk.ts";

export default defineTool({
  name: "write_file",
  description: "Create or overwrite a file with the full given content. Parent dirs are created.",
  input: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
  },
  run: (input, { root }) => {
    if (typeof input.content !== "string") throw new Error("content must be a string");
    const abs = inRoot(root, input.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, input.content);
    return `wrote ${input.path} (${input.content.split("\n").length} lines)`;
  },
});
