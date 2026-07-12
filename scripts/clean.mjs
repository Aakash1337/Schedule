import { readdir, rm } from "node:fs/promises";
import path from "node:path";

const roots = ["apps", "packages"];
const targets = [];

for (const root of roots) {
  const entries = await readdir(path.resolve(root), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory()) targets.push(path.resolve(root, entry.name, "dist"));
  }
}

await Promise.all(targets.map((target) => rm(target, { recursive: true, force: true })));
