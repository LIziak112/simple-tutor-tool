import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join } from "node:path";
import { serve } from "@hono/node-server";
import pino from "pino";

const [dataDir, operator, interruption] = process.argv.slice(2);
if (interruption === "after-kernel-move") {
  const move = fs.renameSync;
  fs.renameSync = (from, to) => {
    move(from, to);
    if (
      dirname(String(to)) === dataDir &&
      basename(String(to)) === "learning-kernel.sqlite"
    ) {
      process.kill(process.pid, "SIGKILL");
    }
  };
  syncBuiltinESMExports();
}

const { createApp } = await import("../../app.ts");
const { runBackfills } = await import("../../db/backfill.ts");
const { createDbHandle } = await import("../../db/client.ts");
const { runMigrations } = await import("../../db/migrate.ts");
const { BACKUP_DIR_NAME, DB_FILE_NAME } = await import(
  "../../services/backup-service.ts"
);
const { registerBackupProcess } = await import(
  "../../services/backup-process-guard.ts"
);
const { verifyBackupDirectory } = await import(
  "../../services/backup-kernel-pair.ts"
);

registerBackupProcess(
  join(dataDir, BACKUP_DIR_NAME),
  DB_FILE_NAME,
  (directory) => verifyBackupDirectory(directory, DB_FILE_NAME),
);
const handle = createDbHandle(join(dataDir, DB_FILE_NAME), (db) => {
  runMigrations(db);
  runBackfills(db);
});
let app;
const server = serve(
  { hostname: "127.0.0.1", port: 0, fetch: (...args) => app.fetch(...args) },
  ({ port }) => {
    const origin = `http://127.0.0.1:${port}`;
    app = createApp({
      db: handle.db,
      dbHandle: handle,
      dataDir,
      backupOperatorId: operator,
      kernelAssignmentCreationEnabled: true,
      isProduction: false,
      logger: pino({ enabled: false }),
      publicUrl: origin,
    });
    process.send(origin);
  },
);
process.on("message", (message) => {
  if (message !== "stop") return;
  server.close(() => {
    handle.close();
    process.exit(0);
  });
  server.closeIdleConnections();
});
