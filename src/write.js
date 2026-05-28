import fs from "node:fs";
import path from "node:path";

export const writeSchema = {
  type: "object",
  required: ["file", "content"],
  properties: {
    file: { type: "string" },
    content: { type: "string" },
    force: { type: "boolean", default: false, description: "Required to overwrite an existing file." }
  }
};

export async function doWrite(args = {}) {
  const abs = path.resolve(args.file);
  const content = args.content ?? "";
  if (fs.existsSync(abs) && !args.force) {
    return {
      text: `Refusing to overwrite existing file ${args.file} without force: true`,
      meta: { mode: "write", bytes: 0 }
    };
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  const bytes = Buffer.byteLength(content, "utf8");
  return { text: `Wrote ${bytes} bytes to ${args.file}`, meta: { mode: "write", bytes } };
}
