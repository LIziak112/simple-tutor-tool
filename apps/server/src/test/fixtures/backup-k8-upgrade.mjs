import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempDisposableSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKUP_KERNEL_ARTIFACT,
  BACKUP_KERNEL_DATABASE,
  BACKUP_KERNEL_MANIFEST,
  backupKernelManifestSchema,
  teacherAttemptDetailOkSchema,
} from "@tutor/contract";
import { ZipArchive } from "archiver";
import Database from "better-sqlite3";
import pino from "pino";
import { createApp } from "../../app.ts";
import { runBackfills } from "../../db/backfill.ts";
import { createDbHandle } from "../../db/client.ts";
import { runMigrations } from "../../db/migrate.ts";
import { zipToBackupBuffer } from "../backup-fixtures.ts";
import { nodePeerBindings } from "../node-peer.ts";
import { extractSessionToken, loginStudent } from "../note-world.ts";

const [sourceDirectory, generation = "K8"] = process.argv.slice(2);
assert.ok(sourceDirectory, "请传入独立的 K8 或 K9 合成数据目录");
const source = {
  K8: {
    revision: "520f7e24f4d67c6f1d200e7d999033efc94052a9",
    artifact:
      "3b565090f38b16dea6051cf71c63b3ebfa331291da9ccaf42e19549f162cde1d",
    schema: 12,
    student: "合成甲",
    score: 50,
  },
  K9: {
    revision: "4020ef9fddb70e2832386d08e22895d1fac8cc20",
    artifact:
      "c78a36d1812d3e2d337177dbdb79d50af7c43cf9d0621ffd80f8be0b03d7ae73",
    schema: 13,
    student: "合成乙",
    score: 0,
  },
}[generation];
assert.ok(source, "只接受已验的 K8 或 K9 合成来源");
const archiveName = `synthetic-${generation.toLowerCase()}.zip`;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const artifact = execFileSync("git", [
  "show",
  `${source.revision}:apps/server/vendor/learning-kernel-${source.artifact}.tgz`,
]);
assert.equal(hash(artifact), source.artifact);

const prepared = mkdtempDisposableSync(join(tmpdir(), "ownclass-k8-archive-"));
const target = mkdtempDisposableSync(join(tmpdir(), "ownclass-k8-target-"));
try {
  for (const name of ["tutor.db", BACKUP_KERNEL_DATABASE]) {
    const old = new Database(join(sourceDirectory, name), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      old.prepare("VACUUM INTO ?").run(join(prepared.path, name));
    } finally {
      old.close();
    }
  }
  copyFileSync(
    join(sourceDirectory, "secret.key"),
    join(prepared.path, "secret.key"),
  );
  const publishedFacts = (path) => {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      return db
        .prepare(`SELECT b.attempt_id AS id FROM kernel_attempt_bindings b
          JOIN attempts a ON a.id = b.attempt_id JOIN students s ON s.id = a.student_id
          WHERE s.login_name = ? AND a.status IN ('submitted','graded')`)
        .get(source.student);
    } finally {
      db.close();
    }
  };
  const attempt = publishedFacts(join(prepared.path, "tutor.db"));
  assert.ok(attempt);
  const product = readFileSync(join(prepared.path, "tutor.db"));
  const kernel = readFileSync(join(prepared.path, BACKUP_KERNEL_DATABASE));
  const stream = new ZipArchive();
  stream.append(product, { name: "tutor.db" });
  stream.append(kernel, { name: BACKUP_KERNEL_DATABASE });
  stream.append(artifact, { name: BACKUP_KERNEL_ARTIFACT });
  stream.append(readFileSync(join(prepared.path, "secret.key")), {
    name: "secret.key",
  });
  stream.append(
    JSON.stringify(
      backupKernelManifestSchema.parse({
        formatVersion: 1,
        productSha256: hash(product),
        kernelSha256: hash(kernel),
        kernelSchemaVersion: source.schema,
        kernelArtifactSha256: source.artifact,
      }),
    ),
    { name: BACKUP_KERNEL_MANIFEST },
  );
  const archive = zipToBackupBuffer({ stream, filename: archiveName });
  await stream.finalize();
  const bytes = new Uint8Array(await archive);

  const handle = createDbHandle(join(target.path, "tutor.db"), (db) => {
    runMigrations(db);
    runBackfills(db);
  });
  try {
    const app = (backupOperatorId) =>
      createApp({
        db: handle.db,
        dbHandle: handle,
        dataDir: target.path,
        backupOperatorId,
        publicUrl: "http://localhost:8787",
        logger: pino({ enabled: false }),
        isProduction: false,
      });
    const headers = { "content-type": "application/json" };
    const body = JSON.stringify({
      loginName: "teacher",
      password: "teacher-pass-8",
    });
    const bootstrap = await app().request("/api/public/teacher/setup", {
      method: "POST",
      headers,
      body,
    });
    assert.equal(bootstrap.status, 200);
    const {
      data: { id: observer },
    } = await bootstrap.clone().json();
    const zip = new FormData();
    zip.set("zip", new File([bytes], archiveName));
    zip.set("password", "teacher-pass-8");
    const restored = await app(observer).request(
      "/api/teacher/backup/restore",
      {
        method: "POST",
        headers: { cookie: `tutor_session=${extractSessionToken(bootstrap)}` },
        body: zip,
      },
    );
    assert.equal(restored.status, 200, await restored.clone().text());
    const restoredApp = app();
    const student = await loginStudent(restoredApp, source.student);
    const read = await restoredApp.request(
      `/api/student/attempts/${attempt.id}`,
      { headers: { cookie: student } },
    );
    assert.equal(read.status, 200, await read.clone().text());
    const { data: studentResult } = await read.json();
    assert.equal(studentResult.summary.total, 2);
    if (generation === "K8") assert.equal(studentResult.summary.answered, 2);
    const teacher = await restoredApp.request(
      "/api/public/teacher/login",
      { method: "POST", headers, body },
      nodePeerBindings("10.0.0.2"),
    );
    assert.equal(teacher.status, 200, await teacher.clone().text());
    const detail = await restoredApp.request(
      `/api/teacher/attempts/${attempt.id}`,
      { headers: { cookie: `tutor_session=${extractSessionToken(teacher)}` } },
    );
    assert.equal(detail.status, 200, await detail.clone().text());
    const { data: teacherResult } = teacherAttemptDetailOkSchema.parse(
      await detail.json(),
    );
    assert.equal(teacherResult.scoreAuto, source.score);
    const db = new Database(join(target.path, BACKUP_KERNEL_DATABASE), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const { version } = db
        .prepare("SELECT MAX(version) AS version FROM schema_migrations")
        .get();
      assert.equal(version, 13);
      console.log(
        JSON.stringify({
          restoreHttp: restored.status,
          studentHttp: read.status,
          teacherHttp: detail.status,
          teacherScore: teacherResult.scoreAuto,
          kernelBefore: source.schema,
          kernelAfter: version,
          kernelArtifactSha256: source.artifact,
        }),
      );
    } finally {
      db.close();
    }
  } finally {
    handle.close();
  }
} finally {
  target.remove();
  prepared.remove();
}
