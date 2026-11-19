import assert from "node:assert/strict";
import { mkdtempDisposableSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  collectCorpus,
  digest,
  loadFromCheckout,
  writeEvidence,
} from "./evidence.mjs";

const [manifest, output] = process.argv.slice(2);
assert.ok(
  manifest && output,
  "用法：probe.mjs <冻结契约与内容.tsv> <结果.tsv>",
);
const root = process.cwd();
const serverRequire = createRequire(join(root, "apps/server/package.json"));
const { createApp } = await loadFromCheckout("apps/server/src/app.ts");
const { createTestDb } = await loadFromCheckout(
  "apps/server/src/db/test-utils.ts",
);
const {
  importCommitOkSchema,
  importPreviewBatchDataSchema,
  importPreviewOkSchema,
} = await loadFromCheckout("packages/contract/src/index.ts");
const { serve } = await import(
  pathToFileURL(serverRequire.resolve("@hono/node-server")).href
);

function checkSchema(schema, body, label) {
  assert.ok(schema.safeParse(body).success, `${label} 响应不符合契约`);
}

const corpus = collectCorpus(manifest);
const { files, foreignRef, missingRef, declared } = corpus;

const db = createTestDb();
const data = mkdtempDisposableSync(join(tmpdir(), "m02-preview-"));
let app;
let server;
try {
  const address = await new Promise((ready, fail) => {
    server = serve(
      {
        hostname: "127.0.0.1",
        port: 0,
        fetch: (...args) => app.fetch(...args),
      },
      ready,
    );
    server.once("error", fail);
  });
  const origin = `http://127.0.0.1:${address.port}`;
  app = createApp({
    db,
    dataDir: data.path,
    isProduction: false,
    logger: serverRequire("pino")({ enabled: false }),
    publicUrl: origin,
  });
  async function request(path, input, cookie) {
    const headers = { origin };
    if (input !== undefined) headers["content-type"] = "application/json";
    if (cookie !== undefined) headers.cookie = cookie;
    const response = await fetch(`${origin}/api/${path}`, {
      headers,
      ...(input === undefined
        ? {}
        : { method: "POST", body: JSON.stringify(input) }),
    });
    return {
      status: response.status,
      body: await response.json(),
      cookies: response.headers.getSetCookie(),
    };
  }

  async function authenticate(mode, loginName) {
    const auth = await request(`public/teacher/${mode}`, {
      loginName,
      password: "synthetic-m02-preview-pass",
    });
    assert.equal(auth.status, 200, `${mode} 未成功`);
    const cookie = auth.cookies
      .find((line) => line.startsWith("tutor_session="))
      ?.split(";")[0];
    assert.ok(cookie);
    return cookie;
  }

  await authenticate("setup", "teacher");
  const teacher = await authenticate("login", "teacher");
  const me = await request("teacher/me", undefined, teacher);
  assert.equal(me.status, 200);
  assert.equal(me.body.data.loginName, "teacher");
  const foreign = await authenticate("register", "teacher-other");
  const foreignMe = await request("teacher/me", undefined, foreign);
  assert.equal(foreignMe.status, 200);
  assert.notEqual(foreignMe.body.data.id, me.body.data.id);

  process.env.NEW_CONTENT_ENABLED = "true";
  const seed = await request(
    "teacher/import/commit",
    {
      filename: "other-teacher.md",
      markdown: `---\nkind: practice\nunit: 他域合成资料\n---\n\n::::material{id=${missingRef}}\n他域材料。\n::::\n\n::::question{type=judge}\n1+1=2。[[正确]]\n::::\n`,
    },
    foreign,
  );
  assert.equal(seed.status, 200, "他域材料准备失败");
  checkSchema(importCommitOkSchema, seed.body, "他域材料准备");
  assert.equal(
    db.$client
      .prepare(
        "SELECT COUNT(*) AS n FROM materials WHERE id = ? AND teacher_id = ?",
      )
      .get(missingRef, foreignMe.body.data.id).n,
    1,
  );

  function storage() {
    return {
      rows: Object.fromEntries(
        [
          "lectures",
          "units",
          "questions",
          "materials",
          "question_groups",
          "question_group_members",
          "material_refs",
          "courses",
          "library_folders",
          "course_items",
          "imports",
        ].map((table) => [
          table,
          db.$client.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
        ]),
      ),
      files: readdirSync(data.path, { recursive: true }).sort(),
    };
  }
  const changes = () =>
    db.$client.prepare("SELECT total_changes() AS n").get().n;
  const before = storage();
  const changesBefore = changes();
  const previewInput = ({ path, markdown }) => ({
    filename: basename(path),
    markdown,
  });
  const preview = (file, cookie = teacher) =>
    request("teacher/import/preview", previewInput(file), cookie);
  const batch = (batchFiles) =>
    request(
      "teacher/import/preview-batch",
      { autoFolderBySubdir: true, files: batchFiles },
      teacher,
    );
  const anonymous = await request(
    "teacher/import/preview",
    previewInput(declared),
  );
  assert.equal(anonymous.status, 401);

  const owner = await preview(foreignRef, foreign);
  assert.equal(owner.status, 200);
  checkSchema(importPreviewOkSchema, owner.body, "同域材料预览");
  assert.ok(
    !owner.body.data.issues.some(({ code }) => code === "UNKNOWN_MATERIAL_REF"),
  );

  const opened = [];
  for (const file of files) {
    const wire = await preview(file);
    assert.equal(wire.status, 200, file.path);
    checkSchema(importPreviewOkSchema, wire.body, file.path);
    opened.push(wire);
  }
  const all = await batch(files);
  assert.equal(all.status, 200);
  assert.equal(all.body.ok, true);
  checkSchema(importPreviewBatchDataSchema, all.body.data, "批量预览");
  assert.deepEqual(
    all.body.data.files.map(({ path }) => path),
    files.map(({ path }) => path),
  );

  process.env.NEW_CONTENT_ENABLED = "false";
  const closed = [];
  for (const [index, file] of files.entries()) {
    const wire = await preview(file);
    if (wire.status === 200) {
      assert.equal(digest(wire.body), digest(opened[index].body), file.path);
    } else {
      assert.equal(wire.status, 403, file.path);
      assert.equal(wire.body.error, "NEW_CONTENT_DISABLED", file.path);
      assert.ok(wire.body._usages.length > 0, file.path);
    }
    closed.push(wire);
  }
  const gateIndex = closed.findIndex(
    ({ status }, index) =>
      status === 403 && files[index].path.startsWith("samples/qm/valid-"),
  );
  const gateControl = files[gateIndex];
  assert.ok(gateControl);
  const blockedBatch = await batch([declared, gateControl]);
  assert.equal(blockedBatch.status, 403);
  assert.equal(blockedBatch.body.error, "NEW_CONTENT_DISABLED");
  assert.deepEqual(blockedBatch.body._usages, closed[gateIndex].body._usages);

  const after = storage();
  assert.equal(digest(after), digest(before), "预览改变了内容、留档或文件");
  const sessionRenewals = opened.length + closed.length + 3;
  assert.equal(
    changes() - changesBefore,
    sessionRenewals,
    "预览仅应经鉴权守卫续期会话",
  );

  writeEvidence(output, {
    corpus,
    opened,
    closed,
    all,
    blockedBatch,
    gateControl,
    anonymous,
    owner,
    sessionRenewals,
    after,
  });
} finally {
  try {
    if (server?.listening)
      await new Promise((done, fail) =>
        server.close((error) => (error ? fail(error) : done())),
      );
  } finally {
    db.$client.close();
    data.remove();
  }
}
