import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertPostgreSqlRuntime,
  materializeRuntimeSymlinks,
  parsePostgreSqlRuntimeLock,
  sealPostgreSqlRuntime,
  type PostgreSqlRuntimeLock,
  type PostgreSqlRuntimeTarget,
} from "./postgresql-runtime.js";
import { runPostgresCommand } from "./smoke-postgresql-runtime.js";

const roots: string[] = [];

async function temporary(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "schedule-pg-runtime-"));
  roots.push(root);
  return root;
}

function processExists(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPidWhenReady(pidFile: string): Promise<number> {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const value = await readFile(pidFile, "utf8").catch(() => "");
    const processId = Number(value);
    if (Number.isInteger(processId) && processId > 0) return processId;
    await delay(25);
  }
  throw new Error("Synthetic descendant did not report its PID.");
}

async function waitForProcessExit(processId: number): Promise<boolean> {
  const deadline = Date.now() + 2000;
  while (processExists(processId) && Date.now() < deadline) await delay(25);
  return !processExists(processId);
}

function forceProcessExit(processId: number | undefined): void {
  if (processId !== undefined && processExists(processId)) process.kill(processId, "SIGKILL");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function lock(): PostgreSqlRuntimeLock {
  return parsePostgreSqlRuntimeLock({
    schemaVersion: 1,
    postgresql: {
      version: "17.10",
      url: "https://ftp.postgresql.org/pub/source/v17.10/postgresql-17.10.tar.gz",
      sha256: "a".repeat(64),
    },
    linuxDependencies: {
      openssl: {
        version: "3.5.7",
        url: "https://github.com/openssl/openssl/releases/download/openssl-3.5.7/openssl-3.5.7.tar.gz",
        sha256: "b".repeat(64),
      },
      zlib: {
        version: "1.3.2",
        url: "https://github.com/madler/zlib/releases/download/v1.3.2/zlib-1.3.2.tar.gz",
        sha256: "c".repeat(64),
      },
    },
    windowsDependencies: {
      vcpkgBaseline: "d".repeat(40),
      triplet: "x64-windows-static-md",
      mesonVersion: "1.9.1",
      ninjaVersion: "1.13.0",
      winFlexBison: {
        version: "2.5.24",
        url: "https://github.com/lexxmark/winflexbison/releases/download/v2.5.24/win_flex_bison-2.5.24.zip",
        sha256: "e".repeat(64),
      },
    },
  });
}

async function fakeRuntime(root: string, target: PostgreSqlRuntimeTarget): Promise<void> {
  const suffix = target === "windows-x64" ? ".exe" : "";
  const files = [
    ...["initdb", "pg_ctl", "pg_dump", "pg_isready", "pg_restore", "postgres", "psql"].map(
      (tool) => `bin/${tool}${suffix}`,
    ),
    "share/postgresql.conf.sample",
    "share/extension/pgcrypto.control",
    "share/extension/pgcrypto--1.3.sql",
    target === "windows-x64" ? "lib/pgcrypto.dll" : "lib/pgcrypto.so",
    "LICENSES/PostgreSQL.txt",
    "LICENSES/OpenSSL.txt",
    "LICENSES/zlib.txt",
  ];
  for (const relative of files) {
    const fullPath = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, relative);
  }
}

describe("PostgreSQL runtime lock", () => {
  it("accepts the exact supported source and tool schema", () => {
    expect(lock().postgresql.version).toBe("17.10");
  });

  it("rejects unknown fields and noncanonical sources", () => {
    const value = structuredClone(lock()) as unknown as Record<string, unknown>;
    value.extra = true;
    expect(() => parsePostgreSqlRuntimeLock(value)).toThrow("invalid schema");

    const changed = structuredClone(lock()) as unknown as { postgresql: { url: string } };
    changed.postgresql.url = "https://example.com/postgresql.tar.gz";
    expect(() => parsePostgreSqlRuntimeLock(changed)).toThrow("canonical releases");
  });

  it("keeps the committed source, vcpkg, and workflow pins aligned", async () => {
    const committed = parsePostgreSqlRuntimeLock(
      JSON.parse(await readFile("postgresql-runtime.lock.json", "utf8")) as unknown,
    );
    const runtimeSources = JSON.parse(await readFile("runtime-sources.lock.json", "utf8")) as {
      artifacts: Array<{ component: string; version: string; sha256: string }>;
    };
    const postgresqlSources = runtimeSources.artifacts.filter(
      (artifact) => artifact.component === "postgresql",
    );
    expect(postgresqlSources).toHaveLength(2);
    expect(
      postgresqlSources.every(
        (artifact) =>
          artifact.version === committed.postgresql.version &&
          artifact.sha256 === committed.postgresql.sha256,
      ),
    ).toBe(true);
    const vcpkg = JSON.parse(await readFile("scripts/postgresql-runtime/vcpkg.json", "utf8")) as {
      "builtin-baseline": string;
      dependencies: Array<string | { host?: boolean; name: string }>;
    };
    expect(vcpkg["builtin-baseline"]).toBe(committed.windowsDependencies.vcpkgBaseline);
    expect(vcpkg.dependencies).toContainEqual({ name: "pkgconf", host: true });
    const workflow = await readFile(".github/workflows/postgresql-runtime.yml", "utf8");
    expect(workflow).toContain(`ref: ${committed.windowsDependencies.vcpkgBaseline}`);
    const actionRefs = [...workflow.matchAll(/\buses:\s+[^@\s]+@([^\s]+)/gu)].map(
      (match) => match[1],
    );
    expect(actionRefs.length).toBeGreaterThan(0);
    expect(actionRefs.every((reference) => /^[a-f0-9]{40}$/u.test(reference ?? ""))).toBe(true);
    const requirements = await readFile(
      "scripts/postgresql-runtime/windows-requirements.txt",
      "utf8",
    );
    expect(requirements).toContain(`meson==${committed.windowsDependencies.mesonVersion} `);
    expect(requirements).toContain(`ninja==${committed.windowsDependencies.ninjaVersion} `);
    const windowsBuilder = await readFile("scripts/build-postgresql-runtime-windows.ps1", "utf8");
    const linuxBuilder = await readFile("scripts/build-postgresql-runtime-linux.sh", "utf8");
    const smoke = await readFile("scripts/smoke-postgresql-runtime.ts", "utf8");
    expect(linuxBuilder).toContain('make -j"$JOBS" install_dev LIBS= INSTALL_LIBS=');
    expect(linuxBuilder).not.toContain("make install_sw");
    expect(smoke).toContain('["-D", data, "-l", serverLog, "-w", "start"]');
    expect(smoke).toContain('writeFile(serverLog, "", { mode: 0o600 })');
    expect(windowsBuilder).toContain("sysconfig.get_path('scripts')");
    expect(windowsBuilder).toContain("importlib.metadata as m");
    expect(windowsBuilder).toContain("$env:PATH = $ScriptsItem.FullName");
    expect(windowsBuilder).toContain("& $MesonExecutable setup");
    expect(windowsBuilder).toContain("& $NinjaExecutable --version");
    expect(windowsBuilder).toContain("$env:PKG_CONFIG = $PkgconfItem.FullName");
    expect(windowsBuilder).toContain("--exists openssl zlib");
    expect(windowsBuilder).toContain('$_.Extension -in @(".exe", ".dll")');
    expect(windowsBuilder).toContain('$_.Extension -in @(".lib", ".pdb")');
    expect(windowsBuilder).toContain('"BUILD-VCPKG-STATUS.txt"');
    expect(windowsBuilder).not.toMatch(/-Include \*\.(?:exe|dll|lib|pdb)/u);
    expect(windowsBuilder).toContain("[BitConverter]::ToUInt16($Bytes, $PeOffset + 4) -eq 0x8664");
    expect(windowsBuilder).not.toContain("dumpbin.exe /nologo /headers");
    expect(windowsBuilder).toContain("api-ms-win-.*|ext-ms-win-.*");
    expect(windowsBuilder).not.toContain("api-ms-win-|ext-ms-win-|kernel32");
    expect(windowsBuilder).toContain(
      `-Dc_link_args=['crypt32.lib','ws2_32.lib','advapi32.lib','user32.lib']`,
    );
    expect(windowsBuilder).toContain(
      '$Lock.windowsDependencies.ninjaVersion + ".git.kitware.jobserver-pipe-1"',
    );
    expect(windowsBuilder).not.toMatch(/&\s+meson\b|&\s+ninja\b/iu);
    expect(workflow.match(/^\s+- "scripts\/acquire-desktop-runtime-sources\.ts"$/gmu)).toHaveLength(
      2,
    );
  });
});

describe("PostgreSQL runtime sealing", () => {
  it("process-tree timeout terminates a live command and its descendant", async () => {
    const root = await temporary();
    const pidFile = path.join(root, "descendant.pid");
    const childSource = [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      'const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"],',
      '  { stdio: ["ignore", 1, 2], windowsHide: true });',
      `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      "setTimeout(() => {}, 10000);",
    ].join("\n");
    let descendant: number | undefined;
    try {
      const command = runPostgresCommand(process.execPath, ["-e", childSource], process.env, 3000);
      descendant = await readPidWhenReady(pidFile);
      await expect(command).rejects.toThrow("exceeded its 3000 ms limit");
      expect(await waitForProcessExit(descendant)).toBe(true);
    } finally {
      forceProcessExit(descendant);
    }
  });

  it("process-tree timeout fails safely when the root exited but a descendant retained pipes", async () => {
    const root = await temporary();
    const pidFile = path.join(root, "orphan.pid");
    const childSource = [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      'const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"],',
      '  { detached: true, stdio: ["ignore", 1, 2], windowsHide: true });',
      `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      "child.unref();",
    ].join("\n");
    let descendant: number | undefined;
    try {
      const command = runPostgresCommand(process.execPath, ["-e", childSource], process.env, 3000);
      descendant = await readPidWhenReady(pidFile);
      await expect(command).rejects.toThrow("exceeded its 3000 ms limit");
      expect(processExists(descendant)).toBe(true);
    } finally {
      forceProcessExit(descendant);
    }
  });

  it("process-tree timeout avoids retained pipes when output capture is disabled", async () => {
    const root = await temporary();
    const pidFile = path.join(root, "ignored-output-descendant.pid");
    const childSource = [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      'const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"],',
      '  { detached: true, stdio: ["ignore", 1, 2], windowsHide: true });',
      `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      "child.unref();",
    ].join("\n");
    let descendant: number | undefined;
    try {
      const started = Date.now();
      const command = runPostgresCommand(
        process.execPath,
        ["-e", childSource],
        process.env,
        3000,
        false,
      );
      descendant = await readPidWhenReady(pidFile);
      await expect(command).resolves.toEqual({ stdout: "", stderr: "" });
      expect(Date.now() - started).toBeLessThan(2000);
      expect(processExists(descendant)).toBe(true);
    } finally {
      forceProcessExit(descendant);
    }
  });

  it("bounds and redacts command failure diagnostics", async () => {
    const error = await runPostgresCommand(
      process.execPath,
      ["-e", `process.stderr.write(${JSON.stringify(os.tmpdir())}); process.exit(2)`],
      process.env,
    ).catch((failure: unknown) => failure);
    expect(String(error)).toContain("<temporary>");
    expect(String(error)).not.toContain(os.tmpdir());
  });

  it.each(["linux-x64", "windows-x64"] as const)(
    "seals and then verifies a deterministic %s inventory",
    async (target) => {
      const root = await temporary();
      await fakeRuntime(root, target);
      const first = await sealPostgreSqlRuntime(root, target, lock());
      const second = await assertPostgreSqlRuntime(root, target);
      expect(second).toEqual(first);
      expect(
        JSON.parse(await readFile(path.join(root, "RUNTIME-FILES.json"), "utf8")),
      ).toMatchObject({ schemaVersion: 1, target });
    },
  );

  it("fails closed on a missing required tool", async () => {
    const root = await temporary();
    await fakeRuntime(root, "linux-x64");
    await rm(path.join(root, "bin", "postgres"));
    await expect(sealPostgreSqlRuntime(root, "linux-x64", lock())).rejects.toThrow("bin/postgres");
  });

  it("requires the standard Linux pgcrypto install path accepted by the assembler", async () => {
    const root = await temporary();
    await fakeRuntime(root, "linux-x64");
    await mkdir(path.join(root, "lib", "postgresql"), { recursive: true });
    await rename(
      path.join(root, "lib", "pgcrypto.so"),
      path.join(root, "lib", "postgresql", "pgcrypto.so"),
    );
    await expect(sealPostgreSqlRuntime(root, "linux-x64", lock())).rejects.toThrow(
      "lib/pgcrypto.so",
    );
    expect(await readFile("scripts/build-desktop-runtime.ts", "utf8")).toContain(
      '"lib/pgcrypto.so"',
    );
  });

  it("materializes contained file links and rejects escaping links", async () => {
    if (process.platform === "win32") return;
    const root = await temporary();
    await mkdir(path.join(root, "lib"));
    await writeFile(path.join(root, "lib", "libpq.so.5.17"), "library");
    await symlink("libpq.so.5.17", path.join(root, "lib", "libpq.so.5"));
    await materializeRuntimeSymlinks(root);
    expect(await readFile(path.join(root, "lib", "libpq.so.5"), "utf8")).toBe("library");

    const outside = await temporary();
    await writeFile(path.join(outside, "secret"), "outside");
    await symlink(path.join(outside, "secret"), path.join(root, "lib", "escape"));
    await expect(materializeRuntimeSymlinks(root)).rejects.toThrow("contained regular file");
  });
});
