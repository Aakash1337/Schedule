/**
 * Private, immutable file snapshots shared by portable archive readers.
 * Kept separate from the archive frame so installed runtimes never need root scripts.
 */
export {
  withPreparedRestoreArchive,
  type PreparedRestoreArchive,
  type RestoreArchivePreparationOptions,
} from "./backup-database.js";
