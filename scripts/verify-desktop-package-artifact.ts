import { readdir } from "node:fs/promises";
import path from "node:path";

async function containsBundle(directory: string): Promise<boolean> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name === "bundle" && (await readdir(child)).length > 0)
      return true;
    if (entry.isDirectory() && (await containsBundle(child))) return true;
  }
  return false;
}

const target = path.resolve(process.argv[2] ?? "apps/desktop/src-tauri/target");
if (!(await containsBundle(target)))
  throw new Error("Tauri did not create a desktop bundle artifact.");
