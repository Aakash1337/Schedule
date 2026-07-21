import { type PortableArchiveManifestV1, withPreparedPortableArchive } from "./portable-archive.js";
import type { PortableColumnMap, PortablePayloadExpectations } from "./portable-payload.js";
import { readPortablePayload } from "./portable-payload.js";
import type { PortableMigrationIdentity } from "./portable-export.js";

export interface PortableImportResult {
  readonly activeDatabase: string;
  readonly previousDatabase: string;
  readonly archiveId: string;
  /** The database swap is durable. A later runtime restart failure must not trigger re-import. */
  readonly committed: true;
}

export interface PortableImportOperations {
  /** Rejects unsafe database identifiers before any database operation is attempted. */
  readonly assertDatabaseName: (databaseName: string) => void;
  readonly assertActiveDatabase: (databaseName: string) => Promise<void>;
  readonly schemaSignal: (databaseName: string) => Promise<string>;
  readonly migrationIdentity: () => Promise<PortableMigrationIdentity>;
  readonly columnCatalog: (databaseName: string) => Promise<PortableColumnMap>;
  readonly prepareStagingDatabase: (
    payloadPath: string,
    databaseName: string,
    expectedSchemaSignal: string,
    expectedData: PortablePayloadExpectations,
    onCreated: (identity: number) => void,
  ) => Promise<void>;
  readonly signalsMatch: (
    databaseName: string,
    expected: Pick<PortableArchiveManifestV1["data"], "contentSignals" | "sequenceSignals">,
  ) => Promise<boolean>;
  readonly promoteStagingDatabase: (
    stagingDatabase: string,
    previousDatabase: string,
    activeDatabase: string,
  ) => Promise<void>;
  readonly databaseIdentity: (databaseName: string) => Promise<number | null>;
  readonly cleanupStagingAfterFailure: (
    cause: unknown,
    databaseName: string,
    identity: number,
  ) => Promise<void>;
}

export interface ImportPortableScheduleDataOptions {
  readonly archivePath: string;
  readonly expectedArchiveId?: string;
  readonly expectedArchiveSha256?: string;
  readonly activeDatabase: string;
  readonly stagingDatabase: string;
  readonly previousDatabase: string;
}

export const portablePromotionOperations = [
  "mark-previous",
  "disable-active",
  "rename-active",
  "promote-staging",
  "enable-active",
] as const;

export type PortablePromotionOperation = (typeof portablePromotionOperations)[number];

export interface JournaledPortablePromotionOperations {
  readonly writePhase: (
    phase: `before-${PortablePromotionOperation}` | `after-${PortablePromotionOperation}`,
  ) => Promise<void>;
  readonly run: (operation: PortablePromotionOperation) => Promise<void>;
  readonly fault?: (point: string) => void | Promise<void>;
}

/** Executes independently committed promotion operations with a durable intent/result boundary. */
export async function runJournaledPortablePromotion(
  operations: JournaledPortablePromotionOperations,
): Promise<void> {
  for (const operation of portablePromotionOperations) {
    await operations.writePhase(`before-${operation}`);
    await operations.fault?.(`before-${operation}`);
    await operations.run(operation);
    await operations.fault?.(`after-operation:${operation}`);
    await operations.writePhase(`after-${operation}`);
    await operations.fault?.(`after-${operation}`);
  }
}

export function assertCompatiblePortableArchiveManifest(
  manifest: PortableArchiveManifestV1,
  schemaSignal: string,
  migration: PortableMigrationIdentity,
): void {
  const compatibility = manifest.compatibility;
  if (
    compatibility.schemaSignal !== schemaSignal ||
    compatibility.migrationCount !== migration.count ||
    compatibility.latestMigrationTag !== migration.latestTag ||
    compatibility.migrationFingerprint !== migration.fingerprint
  ) {
    throw new Error(
      "Portable archive was produced by an incompatible Schedule schema. Import it with the matching Schedule release, then upgrade normally.",
    );
  }
}

export function assertExpectedPortableArchiveId(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error("Portable archive identity changed after confirmation.");
  }
}

export function assertExpectedPortableArchiveSha256(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error("Portable archive bytes changed after confirmation.");
  }
}

/**
 * Restores a validated archive into an isolated staging database and promotes it only after the
 * restored data matches the archive manifest. Database creation, migration, promotion, and
 * identity-bound cleanup remain adapters so Compose and embedded desktop PostgreSQL share this
 * invariant-heavy path without shelling out from the package.
 */
export async function importPortableScheduleData(
  options: ImportPortableScheduleDataOptions,
  operations: PortableImportOperations,
): Promise<PortableImportResult> {
  const { archivePath, activeDatabase, stagingDatabase, previousDatabase } = options;
  for (const databaseName of [activeDatabase, stagingDatabase, previousDatabase]) {
    operations.assertDatabaseName(databaseName);
  }
  if (new Set([activeDatabase, stagingDatabase, previousDatabase]).size !== 3) {
    throw new Error("Portable import database roles must use distinct identifiers.");
  }

  return withPreparedPortableArchive(
    archivePath,
    async ({ payloadPath, manifest, archiveSha256 }) => {
      if (options.expectedArchiveSha256 !== undefined) {
        assertExpectedPortableArchiveSha256(archiveSha256, options.expectedArchiveSha256);
      }
      if (options.expectedArchiveId !== undefined) {
        assertExpectedPortableArchiveId(manifest.archiveId, options.expectedArchiveId);
      }
      await operations.assertActiveDatabase(activeDatabase);
      const [schemaSignal, migration, columns] = await Promise.all([
        operations.schemaSignal(activeDatabase),
        operations.migrationIdentity(),
        operations.columnCatalog(activeDatabase),
      ]);
      assertCompatiblePortableArchiveManifest(manifest, schemaSignal, migration);
      const expectedData = { ...manifest.data, columns };
      await readPortablePayload(payloadPath, expectedData);

      let stagingIdentity: number | null = null;
      try {
        await operations.prepareStagingDatabase(
          payloadPath,
          stagingDatabase,
          schemaSignal,
          expectedData,
          (identity) => {
            stagingIdentity = identity;
          },
        );
        if (!(await operations.signalsMatch(stagingDatabase, manifest.data))) {
          throw new Error(
            "Portable database content does not match the archive manifest after import.",
          );
        }
        await operations.promoteStagingDatabase(stagingDatabase, previousDatabase, activeDatabase);
      } catch (error) {
        if (stagingIdentity === null)
          stagingIdentity = await operations.databaseIdentity(stagingDatabase);
        if (stagingIdentity !== null) {
          await operations.cleanupStagingAfterFailure(error, stagingDatabase, stagingIdentity);
        }
        throw error;
      }
      return { activeDatabase, previousDatabase, archiveId: manifest.archiveId, committed: true };
    },
  );
}
