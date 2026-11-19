import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { serve } from "@hono/node-server";
import { chromium, expect } from "@playwright/test";
import {
  attemptDraftOkSchema,
  attemptResultOkSchema,
  attemptStartOkSchema,
} from "@tutor/contract";
import { Hono } from "hono";
import { createSpaStatic, defaultWebDistDir } from "../../static.ts";
import { assignKernelFixture, setupAssignment } from "./product-fixture.ts";
import { createRealServiceFixture } from "./real-service-fixture.mjs";

const legacyRevision = "49a3fb0721c16cf9a2ba4f3d1f4fe89c471e3908";
const candidateRevision = "963c0bd861e451557d5c1f776d8bc739036db797";
const cli = process.argv.slice(2);
const keepV2 = cli.includes("--keep-v2");
const inputs = cli.filter((value) => value !== "--keep-v2");
const oldRoot = resolve(
  inputs[0] ?? join(tmpdir(), "ownclass-v2-compat-reference-49a3fb07"),
);
const candidateDist =
  inputs[1] === undefined ? defaultWebDistDir : resolve(inputs[1]);
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
assert.equal(git("-C", oldRoot, "rev-parse", "HEAD"), legacyRevision);
git(
  "diff",
  "--quiet",
  candidateRevision,
  "--",
  "apps/server",
  "apps/web",
  "packages",
  ":(exclude)apps/server/src/test/m04-p1/**",
);

function productionArtifact(root, revision) {
  const index = readFileSync(join(root, "index.html"), "utf8");
  const entry = /<script\b[^>]*\bsrc="([^"]+\.js)"/u.exec(index)?.[1];
  assert.ok(entry?.startsWith("/assets/index-"), "缺少生产入口");
  return {
    revision,
    entry,
    entrySha256: createHash("sha256")
      .update(readFileSync(join(root, entry)))
      .digest("hex"),
    middleware: createSpaStatic({ distDir: root }),
  };
}

const old = productionArtifact(join(oldRoot, "apps/web/dist"), legacyRevision);
const candidate = productionArtifact(candidateDist, candidateRevision);
assert.notEqual(old.entry, candidate.entry, "无法区分两次生产页面");
const profile = mkdtempSync(join(tmpdir(), "ownclass-m04-draft-browser-"));
const service = await createRealServiceFixture();
let current = old;
let watchedAttempt;
let blockAnswers = true;
const requests = [];
const lifecycle = [];
const web = new Hono();
web.all("/api/*", async (c) => {
  const inbound = c.req.raw;
  const { pathname, search } = new URL(inbound.url);
  const body =
    inbound.method === "GET" || inbound.method === "HEAD"
      ? undefined
      : await inbound.arrayBuffer();
  const tracked =
    watchedAttempt !== undefined &&
    pathname.startsWith(`/api/student/attempts/${watchedAttempt}/`) &&
    ((inbound.method === "PUT" && pathname.includes("/answers/")) ||
      (inbound.method === "POST" && pathname.endsWith("/submit")));
  const entry = tracked
    ? {
        revision: current.revision,
        method: inbound.method,
        path: pathname,
        payload: JSON.parse(new TextDecoder().decode(body)),
      }
    : null;
  const response =
    blockAnswers && tracked && inbound.method === "PUT"
      ? c.json(
          {
            ok: false,
            error: "PROBE_OFFLINE",
            message: "合成演练模拟答案传输失败",
          },
          503,
        )
      : await service.app.request(pathname + search, {
          method: inbound.method,
          headers: inbound.headers,
          body,
          redirect: "manual",
        });
  if (entry) requests.push({ ...entry, status: response.status });
  if (
    watchedAttempt !== undefined &&
    (pathname === "/api/student/attempts/opened" ||
      pathname === `/api/student/attempts/${watchedAttempt}` ||
      pathname === `/api/student/attempts/${watchedAttempt}/activate` ||
      /^\/api\/student\/assignments\/[^/]+\/attempt$/u.test(pathname))
  ) {
    const info = await response
      .clone()
      .json()
      .catch(() => null);
    lifecycle.push({
      revision: current.revision,
      method: inbound.method,
      path: pathname,
      status: response.status,
      error: info?.error ?? null,
      attempt: info?.data?.attempt?.id ?? info?.data?.id ?? null,
      phase: info?.data?.attempt?.phase ?? info?.data?.phase ?? null,
    });
  }
  return response;
});
web.use("*", (c, next) => current.middleware(c, next));
const proxy = serve({ fetch: web.fetch, hostname: "127.0.0.1", port: 0 });
if (!proxy.listening) await once(proxy, "listening");
const address = proxy.address();
assert.ok(address && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}`;
const output = {
  origin,
  profile,
  keepV2,
  dataDir: service.dataDir,
  requests,
  lifecycle,
  stage: "boot",
};
let browser;

async function newPage(artifact) {
  browser = await chromium.launchPersistentContext(profile, {
    ...(process.env.CI ? {} : { channel: "msedge" }),
    headless: true,
  });
  const page = browser.pages()[0] ?? (await browser.newPage());
  await page.goto(`${origin}/s/home`);
  const loaded = await page.evaluate(() =>
    [...document.scripts].map((script) => script.getAttribute("src")),
  );
  assert.ok(loaded.includes(artifact.entry), "浏览器未加载指定发布产物");
  const { middleware: _middleware, ...publicArtifact } = artifact;
  return { page, publicArtifact, loaded };
}

async function login(page, name) {
  if (!page.url().endsWith("/s/login")) await page.goto(`${origin}/s/login`);
  await page.locator("#student-login-name").fill(name);
  await page.locator("#student-password").fill("stu-pass-6");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.waitForURL("**/s/home");
  await expect(
    page.getByRole("heading", { name: /^我的作业(?: \d+)?$/u }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: `${name}，你好`, exact: true }),
  ).toBeVisible();
}

async function logout(page) {
  await page.goto(`${origin}/s/home`);
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await page.waitForURL("**/s/login");
}

const option = (page) =>
  page
    .getByRole("article", { name: "第 1 题", exact: true })
    .getByRole("radio", { name: "选项 B" });

async function openAssignment(page, id, label) {
  const [response] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/student/assignments/${id}/attempt` &&
        response.request().method() === "POST",
    ),
    (async () => {
      await page.goto(`${origin}/s/assignments/${id}`);
      if (label !== undefined)
        await page.getByRole("button", { name: label, exact: true }).click();
    })(),
  ]);
  assert.equal(response.status(), 200, await response.text());
  return attemptStartOkSchema.parse(await response.json()).data;
}

async function localDraft(page, studentId, attemptId) {
  return page.evaluate(
    async ({ studentId, attemptId }) => {
      const name = "tutor-drafts";
      if (!(await indexedDB.databases()).some((db) => db.name === name))
        return null;
      const request = indexedDB.open(name);
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const key = `draft:${JSON.stringify([location.origin, studentId, attemptId])}`;
        const read = db
          .transaction("drafts", "readonly")
          .objectStore("drafts")
          .get(key);
        return await new Promise((resolve, reject) => {
          read.onsuccess = () => resolve(read.result ?? null);
          read.onerror = () => reject(read.error);
        });
      } finally {
        db.close();
      }
    },
    { studentId, attemptId },
  );
}

function kernelFacts(id) {
  using db = new DatabaseSync(join(service.dataDir, "learning-kernel.sqlite"), {
    readOnly: true,
  });
  const counts = db
    .prepare(`SELECT
    (SELECT COUNT(*) FROM activities WHERE id=?) AS activities,
    (SELECT COUNT(*) FROM works WHERE activity_id=? AND question_id IS NOT NULL) AS works,
    (SELECT COUNT(*) FROM submissions s JOIN step_attempts a ON a.id=s.step_attempt_id WHERE a.activity_id=?) AS submissions,
    (SELECT COUNT(*) FROM automatic_verdicts v JOIN submissions s ON s.id=v.submission_id
       JOIN step_attempts a ON a.id=s.step_attempt_id WHERE a.activity_id=?) AS verdicts,
    (SELECT COUNT(*) FROM completions WHERE activity_id=?) AS completions
  `)
    .get(id, id, id, id, id);
  const versions = db
    .prepare(`SELECT w.id AS workId, w.question_id AS questionId,
    v.version, v.selection, (SELECT o.operation_id FROM choice_draft_operations o
      WHERE o.work_id=w.id AND o.revision=v.version) AS operationId
    FROM works w JOIN work_versions v ON v.work_id=w.id
    WHERE w.activity_id=? AND w.question_id IS NOT NULL ORDER BY w.question_id, v.version
  `)
    .all(id)
    .map(({ selection, ...row }) => ({ ...row, ...JSON.parse(selection) }));
  return { ...counts, versions };
}

function hostFacts(id) {
  using db = new DatabaseSync(join(service.dataDir, "tutor.db"), {
    readOnly: true,
  });
  const { status, scoreAuto, scoreFinal } = db
    .prepare(
      "SELECT status, score_auto AS scoreAuto, score_final AS scoreFinal FROM attempts WHERE id=?",
    )
    .get(id);
  const counts = db
    .prepare(`SELECT
    (SELECT COUNT(*) FROM kernel_attempt_bindings WHERE attempt_id=?) AS bindings,
    (SELECT COUNT(*) FROM responses WHERE attempt_id=?) AS responses,
    (SELECT COUNT(*) FROM responses WHERE attempt_id=? AND (answer_json IS NOT NULL OR final_correct IS NOT NULL)) AS legacyAnswersOrGrades
  `)
    .get(id, id, id);
  return { status, scoreAuto, scoreFinal, ...counts };
}

try {
  const firstPid = await service.boot(true, {
    extraEnv: { NODE_ENV: "production", PUBLIC_URL: origin },
  });
  const world = await setupAssignment(service.app);
  const assignmentId = await assignKernelFixture(service.app, world);
  const question = "m04-p0-q1";
  const answer = { kind: "choice", index: 1 };

  output.stage = "old-browser-draft";
  const oldWindow = await newPage(old);
  output.legacy = {
    ...oldWindow.publicArtifact,
    loaded: oldWindow.loaded,
    firstPid,
  };
  await login(oldWindow.page, "合成甲");
  const started = await openAssignment(
    oldWindow.page,
    assignmentId,
    "开始作业",
  );
  watchedAttempt = started.id;
  output.attemptId = watchedAttempt;
  const oldPut = oldWindow.page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      new URL(response.url()).pathname.endsWith(`/answers/${question}`),
  );
  await option(oldWindow.page).locator("xpath=ancestor::label[1]").click();
  assert.equal((await oldPut).status(), 503);
  await expect(option(oldWindow.page)).toBeChecked();
  const status = oldWindow.page.getByTestId("draft-status");
  await expect(status).toHaveText(/已存本机，等待同步|离线，已存本机/);
  await expect
    .poll(() => localDraft(oldWindow.page, world.studentId, watchedAttempt))
    .toMatchObject({ answers: { [question]: answer } });
  const before = await localDraft(
    oldWindow.page,
    world.studentId,
    watchedAttempt,
  );
  assert.ok(before);
  assert.equal(before.answerDigests[question], undefined);
  const deniedPut = requests.find((request) => request.status === 503);
  assert.ok(deniedPut);
  assert.deepEqual(deniedPut.payload.answer, answer);
  assert.ok(before.answerMutationIds?.[question]);
  assert.equal(
    deniedPut.payload.mutationId,
    before.answerMutationIds[question],
  );
  output.before = {
    status: await status.textContent(),
    answer: before.answers[question],
    pendingMutationId: before.answerMutationIds[question],
    savedAt: before.savedAt,
    kernel: kernelFacts(watchedAttempt),
    host: hostFacts(watchedAttempt),
  };
  assert.deepEqual(output.before.kernel, {
    activities: 1,
    works: 0,
    submissions: 0,
    verdicts: 0,
    completions: 0,
    versions: [],
  });
  assert.equal(output.before.host.bindings, 1);
  assert.equal(output.before.host.legacyAnswersOrGrades, 0);
  await browser.close();
  browser = undefined;
  await service.stop();

  output.stage = "new-browser-other-account";
  current = keepV2 ? old : candidate;
  const nextPid = await service.boot(true, {
    extraEnv: { NODE_ENV: "production", PUBLIC_URL: origin },
  });
  assert.notEqual(nextPid, firstPid);
  const newWindow = await newPage(current);
  output.candidate = {
    ...newWindow.publicArtifact,
    loaded: newWindow.loaded,
    nextPid,
  };
  const { page } = newWindow;
  const recoveredLocal = await localDraft(
    page,
    world.studentId,
    watchedAttempt,
  );
  assert.deepEqual(recoveredLocal, before, "重开浏览器后未保留原待发记录");
  await logout(page);
  await login(page, "合成乙");
  blockAnswers = false;
  const marker = requests.length;
  const other = await openAssignment(page, assignmentId, "开始作业");
  assert.notEqual(other.id, watchedAttempt);
  await expect(option(page)).toBeEnabled();
  await expect(option(page)).not.toBeChecked();
  assert.equal(
    await localDraft(page, world.otherStudentId, watchedAttempt),
    null,
  );
  assert.deepEqual(requests.slice(marker), []);
  const foreign = `${origin}/api/student/attempts/${watchedAttempt}`;
  const rejectedGet = await page.request.get(foreign);
  const rejectedPut = await page.request.put(`${foreign}/answers/${question}`, {
    data: deniedPut.payload,
  });
  assert.equal(rejectedGet.status(), 403);
  assert.equal(rejectedPut.status(), 403);
  assert.equal((await rejectedGet.json()).data, undefined);
  assert.equal((await rejectedPut.json()).data, undefined);
  assert.deepEqual(kernelFacts(watchedAttempt), output.before.kernel);
  assert.equal(kernelFacts(other.id).works, 0);
  output.other = {
    ownChoiceUnchecked: true,
    read: rejectedGet.status(),
    write: rejectedPut.status(),
    ownerDraftSentAutomatically: false,
  };

  output.stage = "new-browser-owner-replay";
  await logout(page);
  await login(page, "合成甲");
  output.ownerPreOpen = {
    draft: await localDraft(page, world.studentId, watchedAttempt),
    kernel: kernelFacts(watchedAttempt),
  };
  const replayed = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        new URL(`${foreign}/answers/${question}`).pathname &&
      response.request().method() === "PUT",
  );
  const [resumed, saved] = await Promise.all([
    openAssignment(page, assignmentId, "开始作业"),
    replayed,
  ]);
  assert.equal(resumed.id, watchedAttempt);
  await expect(option(page)).toBeChecked();
  assert.equal(saved.status(), 200, await saved.text());
  assert.deepEqual(
    saved.request().postDataJSON(),
    deniedPut.payload,
    "待传答案没有沿同一意图复用",
  );
  await expect(page.getByTestId("draft-status")).toHaveText("全部已保存");
  const synced = await localDraft(page, world.studentId, watchedAttempt);
  assert.ok(synced?.answerDigests[question]);
  const fromServerResponse = await page.request.get(foreign);
  assert.equal(fromServerResponse.status(), 200);
  const live = attemptDraftOkSchema.parse(await fromServerResponse.json()).data;
  assert.deepEqual(live.drafts, { [question]: answer });
  assert.equal(live.draftRevisions?.[question], 1);
  output.recovered = {
    status: saved.status(),
    restoredBeforeAnyEdit: true,
    retryMode: "automatic",
    mutationId: saved.request().postDataJSON().mutationId,
    kernel: kernelFacts(watchedAttempt),
  };
  assert.equal(output.recovered.kernel.works, 1);
  assert.deepEqual(
    output.recovered.kernel.versions.map(
      ({ questionId, version, choice, operationId }) => ({
        questionId,
        version,
        choice,
        operationId,
      }),
    ),
    [
      {
        questionId: question,
        version: 1,
        choice: "1",
        operationId: deniedPut.payload.mutationId,
      },
    ],
  );

  output.stage = "candidate-confirmation";
  const submitted = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        new URL(`${foreign}/submit`).pathname &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "交卷", exact: true }).click();
  await page.getByRole("button", { name: "确认交卷", exact: true }).click();
  const confirmation = await submitted;
  assert.equal(confirmation.status(), 200, await confirmation.text());
  const result = attemptResultOkSchema.parse(await confirmation.json()).data;
  assert.equal(result.attempt.scoreAuto, 50);
  await expect(page.getByText("批改结果")).toBeVisible();
  output.confirmed = {
    status: confirmation.status(),
    score: result.attempt.scoreAuto,
    kernel: kernelFacts(watchedAttempt),
    host: hostFacts(watchedAttempt),
  };
  assert.deepEqual(output.confirmed.kernel, {
    ...output.recovered.kernel,
    submissions: 1,
    verdicts: 2,
    completions: 1,
  });
  assert.deepEqual(output.confirmed.host, {
    status: "graded",
    scoreAuto: null,
    scoreFinal: null,
    bindings: 1,
    responses: 2,
    legacyAnswersOrGrades: 0,
  });
  assert.equal(
    requests.filter(({ method, status }) => method === "PUT" && status === 200)
      .length,
    1,
  );
  assert.equal(
    requests.filter(({ method, status }) => method === "POST" && status === 200)
      .length,
    1,
  );
  output.stage = "passed";
} catch (error) {
  const page = browser?.pages()[0];
  if (page) {
    output.pageAtFailure = {
      path: new URL(page.url()).pathname,
      status: await page.getByTestId("draft-status").allTextContents(),
      alerts: await page.getByRole("alert").allTextContents(),
      screen: (
        await page
          .getByRole("main")
          .first()
          .ariaSnapshot({ timeout: 2_000 })
          .catch(() => "")
      ).slice(0, 3000),
    };
  }
  if (watchedAttempt !== undefined) {
    output.failureFacts = {
      kernel: kernelFacts(watchedAttempt),
      host: hostFacts(watchedAttempt),
    };
  }
  throw error;
} finally {
  console.log(JSON.stringify(output, null, 2));
  await browser?.close();
  await service.stop();
  const closed = once(proxy, "close");
  proxy.close();
  await closed;
}
