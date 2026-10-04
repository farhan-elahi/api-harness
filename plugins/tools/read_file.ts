import { readFileSync } from "node:fs";
import { defineTool, inRoot } from "../../core/sdk.ts";

const CAP = 200; // lines returned when no range is given

export default defineTool({
  name: "read_file",
  description: `Read a text file. Returns at most ${CAP} lines unless start/end (1-based, inclusive) are given.`,
  input: {
    type: "object",
    properties: { path: { type: "string" }, start: { type: "integer" }, end: { type: "integer" } },
    required: ["path"],
  },
  run: (input, { root }) => {
    const lines = readFileSync(inRoot(root, input.path), "utf8").split("\n");
    const start = Math.max(1, Number(input.start) || 1);
    const end = Math.min(lines.length, Number(input.end) || start + CAP - 1);
    const body = lines.slice(start - 1, end).map((l, i) => `${start + i}\t${l}`).join("\n");
    return end < lines.length ? `${body}\n…(${lines.length} lines total; pass start/end for more)` : body;
  },
});
