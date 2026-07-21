import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { configureBackupRepositoryRoot, main } from "../packages/database/src/backup-database.js";

configureBackupRepositoryRoot(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));

export * from "../packages/database/src/backup-database.js";

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(path.resolve(entryPoint)).href) {
  await main();
}
