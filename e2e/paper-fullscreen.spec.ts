import { gzipSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import {
  attemptDraftDataSchema,
  inkDocSchema,
  noteDocSchema,
} from "../packages/contract/src/index";
import {
  addCourseMemberViaApi,
  attachLeakMonitor,
  createCourseViaApi,
  drawStrokeWithPointerEvents,
  getStudentViaApi,
  openChoicePractice,
  setCourseItemVisible,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

test("草稿与正式手写：同画布全屏保留撤销历史、十次切换和空稿无副作用", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    const listeners = new Set<EventListenerOrEventListenerObject>();
    const add = EventTarget.prototype.addEventListener;
    const remove = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function (
      type,
      callback,
      options,
    ) {
      if (this === window && type === "blur" && callback)
        listeners.add(callback);
      add.call(this, type, callback, options);
    };
    EventTarget.prototype.removeEventListener = function (
      type,
      callback,
      options,
    ) {
      if (this === window && type === "blur" && callback)
        listeners.delete(callback);
      remove.call(this, type, callback, options);
    };
    Object.defineProperty(window, "paperBlurListenerCount", {
      value: () => listeners.size,
    });
  });
  await teacherApiLogin(request);
  const suffix = uniqueSuffix();
  const courseName = `纸面课程${suffix}`;
  const unitName = `纸面练习${suffix}`;
  const courseId = await createCourseViaApi(request, courseName);
  const markdown = [
    "---",
    "kind: practice",
    `unit: ${unitName}`,
    "---",
    "",
    '::::question{type=judge difficulty=1 knowledge="判断"}',
    "零是正数。[[错误]]",
    "::::",
    "",
    '::::question{type=solve difficulty=1 knowledge="历史手写"}',
    "继续记录计算过程。",
    ":::answer",
    "2",
    ":::",
    "::::",
    "",
    '::::question{type=solve difficulty=1 knowledge="计算"}',
    "计算 $1+1$ 并写出过程。",
    ":::answer",
    "2",
    ":::",
    "::::",
    "",
  ].join("\n");
  const imported = await request.post("/api/teacher/import/commit", {
    data: { markdown, filename: `${unitName}.md`, courseId },
  });
  expect(imported.ok(), await imported.text()).toBe(true);
  await setCourseItemVisible(request, courseId, unitName, true);
  const loginName = `paper-${suffix}`;
  await request.post("/api/teacher/students", {
    data: { displayName: "纸面测试生", loginName },
  });
  const student = await getStudentViaApi(request, loginName);
  await addCourseMemberViaApi(request, courseId, student.id);
  const leak = attachLeakMonitor(page);
  await page.goto(`/s/${student.linkToken}`);
  await page.waitForURL("**/s/home");
  const attemptId = await openChoicePractice(
    page,
    courseId,
    courseName,
    unitName,
    3,
  );
  const detail = await page.request.get(`/api/student/attempts/${attemptId}`);
  const envelope = (await detail.json()) as { data: unknown };
  const data = attemptDraftDataSchema.parse(envelope.data);
  const questions = data.units.flatMap((unit) => unit.questions);
  for (const kind of ["scratch", "formal"] as const) {
    const index = kind === "scratch" ? 1 : 2;
    const card = page.locator(`article[aria-label="第 ${index} 题"]`);
    await card
      .getByRole("button", { name: kind === "scratch" ? /草稿纸/ : /手写作答/ })
      .click();
    const canvas = card.locator('[data-slot="ink-pad-canvas"] canvas');
    await expect(canvas).toBeVisible();
    const identity = await canvas.elementHandle();
    const openFullscreen = async () => {
      await card
        .getByRole("button", {
          name: kind === "scratch" ? /草稿纸全屏/ : /全屏作答/,
        })
        .click();
      await expect(
        page.getByRole("dialog", {
          name: kind === "scratch" ? /草稿纸全屏/ : "全屏作答",
        }),
      ).toBeVisible();
    };
    const closeFullscreen = async () => {
      await page.getByRole("button", { name: "退出全屏" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    };
    let lastRead: unknown;
    const count = async () => {
      const document = await page.evaluate(
        async ({ attemptId, questionId, kind, studentId }) => {
          const name = kind === "formal" ? "tutor-drafts" : "tutor-notes";
          const store = kind === "formal" ? "drafts" : "notes";
          const key =
            kind === "formal"
              ? `draft:${JSON.stringify([location.origin, studentId, attemptId])}`
              : JSON.stringify([
                  "note",
                  location.origin,
                  studentId,
                  attemptId,
                  questionId,
                  "scratch",
                ]);
          const record = await new Promise<unknown>((resolve, reject) => {
            const opening = indexedDB.open(name);
            opening.onerror = () => reject(opening.error);
            opening.onsuccess = () => {
              const db = opening.result;
              const tx = db.transaction(store);
              const reading = tx.objectStore(store).get(key);
              let value: unknown;
              reading.onsuccess = () => {
                value = reading.result;
              };
              tx.oncomplete = () => {
                db.close();
                resolve(value);
              };
              tx.onerror = () => {
                db.close();
                reject(tx.error);
              };
            };
          });
          if (!record || typeof record !== "object") return null;
          const fields = record as Record<string, unknown>;
          if (kind === "scratch") return fields.doc;
          const inks = fields.inks;
          return inks && typeof inks === "object"
            ? (inks as Record<string, unknown>)[questionId]
            : null;
        },
        {
          attemptId,
          questionId: questions[index - 1]?.id ?? "",
          kind,
          studentId: student.id,
        },
      );
      if (!document) return -1;
      lastRead = document;
      if (kind === "scratch")
        return noteDocSchema.parse(document).ink.strokes.length;
      const ink = inkDocSchema.parse(document);
      return ink.engine === "atrament" ? ink.data.strokes.length : -1;
    };
    const beforeEmpty = await count();
    await openFullscreen();
    await closeFullscreen();
    await expect(card.getByText("未填写", { exact: true })).toBeVisible();
    expect(await count()).toBe(beforeEmpty);
    for (let stroke = 0; stroke < 3; stroke++)
      await drawStrokeWithPointerEvents(canvas);
    await expect.poll(count).toBe(3);
    await card.getByRole("button", { name: "撤销", exact: true }).click();
    await expect.poll(count).toBe(2);
    const storedStrokes = () => {
      if (kind === "scratch") return noteDocSchema.parse(lastRead).ink.strokes;
      const ink = inkDocSchema.parse(lastRead);
      if (ink.engine !== "atrament") throw new Error("新稿不应切换引擎");
      return ink.data.strokes;
    };
    const beforeStrokes = storedStrokes();
    await openFullscreen();
    if (kind === "scratch") {
      await card.getByRole("button", { name: /更多操作/ }).click();
      await page.getByRole("menuitem", { name: "重做" }).click();
    } else {
      await card.getByRole("button", { name: /更多操作/ }).click();
      await page.getByRole("menuitem", { name: "重做", exact: true }).click();
    }
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect.poll(count).toBe(3);
    await drawStrokeWithPointerEvents(canvas);
    await expect.poll(count).toBe(4);
    await page.screenshot({
      path: testInfo.outputPath(`${kind}-fullscreen.png`),
    });
    await closeFullscreen();
    const listenerCount = () =>
      page.evaluate(() =>
        (
          window as unknown as Window & { paperBlurListenerCount(): number }
        ).paperBlurListenerCount(),
      );
    const beforeListeners = await listenerCount();
    for (let toggle = 0; toggle < 10; toggle++) {
      await openFullscreen();
      await closeFullscreen();
    }
    expect(
      await canvas.evaluate(
        (element, original) => element === original,
        identity,
      ),
    ).toBe(true);
    await expect.poll(count).toBe(4);
    expect(await listenerCount()).toBe(beforeListeners);
    expect(storedStrokes().slice(0, 2)).toEqual(beforeStrokes);
    await card.getByRole("button", { name: "撤销", exact: true }).click();
    await expect.poll(count).toBe(3);
    const viewport = page.viewportSize();
    await page.setViewportSize({ width: 320, height: 800 });
    await openFullscreen();
    const toolbar = page.getByRole("toolbar").filter({ visible: true });
    await expect(toolbar.getByRole("button")).toHaveCount(5);
    for (const button of await toolbar.getByRole("button").all()) {
      const box = await button.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(44);
      expect(box?.x).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(320);
    }
    await expect
      .poll(() =>
        canvas.evaluate((element) => {
          const canvas = element as HTMLCanvasElement;
          const pixels =
            canvas
              .getContext("2d")
              ?.getImageData(0, 0, canvas.width, canvas.height).data ?? [];
          let count = 0;
          for (let index = 3; index < pixels.length; index += 4)
            if ((pixels[index] ?? 0) > 0) count++;
          return count;
        }),
      )
      .toBeGreaterThan(10);
    await page.screenshot({
      path: testInfo.outputPath(`${kind}-fullscreen-320.png`),
    });
    await closeFullscreen();
    if (viewport) await page.setViewportSize(viewport);
    await expect(card.locator('[data-slot="ink-pad"]')).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(canvas).toBeHidden();
    await expect(canvas).toHaveAttribute("data-input-enabled", "false");
  }
  const legacyQuestion = questions[2];
  if (!legacyQuestion) throw new Error("缺少历史手写夹具");
  const legacy = inkDocSchema.parse({
    engine: "excalidraw",
    version: 1,
    updatedAt: 1,
    data: {
      scene: {
        elements: [
          {
            id: "legacy-stroke",
            type: "freedraw",
            x: 50,
            y: 50,
            width: 80,
            height: 30,
            points: [
              [0, 0],
              [80, 30],
            ],
            pressures: [0.5, 0.5],
            simulatePressure: false,
            strokeColor: "#e03131",
            strokeWidth: 2,
            opacity: 100,
            version: 1,
            versionNonce: 1,
            seed: 1,
            isDeleted: false,
          },
        ],
      },
    },
  });
  const upload = await page.request.put(
    `/api/student/attempts/${attemptId}/ink/${legacyQuestion.id}`,
    {
      multipart: {
        strokes: {
          name: "strokes.json.gz",
          mimeType: "application/gzip",
          buffer: gzipSync(JSON.stringify(legacy)),
        },
        snapshot: {
          name: "snapshot.png",
          mimeType: "image/png",
          buffer: Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
            "base64",
          ),
        },
      },
    },
  );
  expect(upload.ok(), await upload.text()).toBe(true);
  await page.reload();
  const legacyCard = page.locator('article[aria-label="第 3 题"]');
  await legacyCard.getByRole("button", { name: /手写作答/ }).click();
  await expect(legacyCard.getByText(/全屏模式下创建/)).toBeVisible();
  await legacyCard
    .getByRole("button", { name: "全屏作答", exact: true })
    .click();
  await expect(legacyCard.locator(".excalidraw canvas").first()).toBeVisible();
  await expect(legacyCard.locator(".excalidraw")).toHaveCount(1);
  const legacyIdentity = await legacyCard
    .locator(".excalidraw")
    .elementHandle();
  await page.getByRole("button", { name: "退出全屏" }).click();
  await legacyCard
    .getByRole("button", { name: "全屏作答", exact: true })
    .click();
  expect(
    await legacyCard
      .locator(".excalidraw")
      .evaluate((element, original) => element === original, legacyIdentity),
  ).toBe(true);
  await page.getByRole("button", { name: "退出全屏" }).click();
  expect(leak.violations()).toEqual([]);
});
