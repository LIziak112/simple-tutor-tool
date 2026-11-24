import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readLockedBackupArtifact } from "../src/services/backup-kernel-artifact.ts";

const { filename, bytes } = readLockedBackupArtifact();
const destination = fileURLToPath(new URL("../dist/vendor/", import.meta.url));
mkdirSync(destination, { recursive: true });
writeFileSync(join(destination, filename), bytes);
