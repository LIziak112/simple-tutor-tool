import { expect, test } from "@playwright/test";

test("真实存储事务中止：错误可读，手动重试保留原稿并在刷新后恢复", {
  tag: ["@annotation"],
}, async ({ page }) => {
  await page.goto("/dev/question-base");
  const result = await page.evaluate(async () => {
    const moduleUrl = "/src/lib/kv-backend.ts";
    const { idbKVBackend } = (await import(moduleUrl)) as {
      idbKVBackend: (
        db: string,
        store: string,
      ) => {
        set: (key: string, value: unknown) => Promise<void>;
        get: (key: string) => Promise<unknown>;
      };
    };
    const backend = idbKVBackend("annotation-abort-regression", "drafts");
    const previous = { version: 1, strokes: [1], mutationId: "previous" };
    const latest = {
      version: 2,
      strokes: [1, 2],
      mutationId: "latest",
      png: new Blob(["原稿底图"], { type: "image/png" }),
    };
    await backend.set("稿件", previous);
    const put = IDBObjectStore.prototype.put;
    let abort = true;
    IDBObjectStore.prototype.put = function (
      value: unknown,
      key?: IDBValidKey,
    ) {
      const request =
        key === undefined ? put.call(this, value) : put.call(this, value, key);
      if (abort && this.transaction.db.name === "annotation-abort-regression") {
        abort = false;
        queueMicrotask(() => this.transaction.abort());
      }
      return request;
    };
    try {
      let message = "";
      try {
        await backend.set("稿件", latest);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      const afterFailure = await backend.get("稿件");
      await backend.set("稿件", latest);
      return { message, afterFailure, previous };
    } finally {
      IDBObjectStore.prototype.put = put;
    }
  });
  expect(result.message).toContain("本机存储");
  expect(result.message).not.toContain("null");
  expect(result.afterFailure).toEqual(result.previous);
  await page.reload();
  const restored = await page.evaluate(async () => {
    const moduleUrl = "/src/lib/kv-backend.ts";
    const { idbKVBackend } = (await import(moduleUrl)) as {
      idbKVBackend: (
        db: string,
        store: string,
      ) => { get: (key: string) => Promise<unknown> };
    };
    const value = (await idbKVBackend(
      "annotation-abort-regression",
      "drafts",
    ).get("稿件")) as {
      version: number;
      strokes: number[];
      mutationId: string;
      png: Blob;
    };
    return {
      version: value.version,
      strokes: value.strokes,
      mutationId: value.mutationId,
      png: await value.png.text(),
    };
  });
  expect(restored).toEqual({
    version: 2,
    strokes: [1, 2],
    mutationId: "latest",
    png: "原稿底图",
  });
});

test("本机原位稿：真实IndexedDB原子存PNG/布局/矢量，页面重启恢复且账号隔离", {
  tag: ["@annotation"],
}, async ({ page }) => {
  await page.goto("/dev/question-base");
  await page.getByRole("button", { name: "生成底图", exact: true }).click();
  await expect(page.getByTestId("layout-result")).toBeVisible({
    timeout: 30_000,
  });
  const saved = await page.evaluate(async () => {
    const moduleUrl = "/src/features/annotation/annotation-store.ts";
    const store = (await import(moduleUrl)) as {
      writeLocalAnnotationBase: (...args: unknown[]) => Promise<void>;
    };
    const image = document.querySelector<HTMLImageElement>(
      'img[alt="题面底图"]',
    );
    const result = document.querySelector('[data-testid="layout-result"]');
    if (!image || !result) throw new Error("底图夹具未就绪");
    const parsed = JSON.parse(result.textContent ?? "null") as {
      layout: { cssWidth: number; cssHeight: number; pixelRatio: number };
    };
    const png = await (await fetch(image.src)).blob();
    const doc = {
      version: 1,
      baseWidth: Math.ceil(parsed.layout.cssWidth * parsed.layout.pixelRatio),
      baseHeight: Math.ceil(parsed.layout.cssHeight * parsed.layout.pixelRatio),
      strokes: [
        {
          tool: "pen",
          color: "#dc2626",
          weight: 4,
          points: [{ x: 20, y: 20, p: 0.5, t: 0 }],
        },
      ],
    };
    await store.writeLocalAnnotationBase(
      { origin: location.origin, studentId: "idb-fixture-a" },
      {
        attemptId: "idb-attempt",
        questionId: "idb-question",
        phase: "scratch",
      },
      { png, layout: parsed.layout },
      doc,
    );
    return { size: png.size, layout: parsed.layout, doc };
  });
  await page.reload();
  const restored = await page.evaluate(async () => {
    const moduleUrl = "/src/features/annotation/annotation-store.ts";
    const store = (await import(moduleUrl)) as {
      getAnnotationRecord: (...args: unknown[]) => Promise<unknown>;
    };
    const scope = {
      attemptId: "idb-attempt",
      questionId: "idb-question",
      phase: "scratch",
    };
    const record = (await store.getAnnotationRecord(
      { origin: location.origin, studentId: "idb-fixture-a" },
      scope,
    )) as {
      localBase: { png: Blob; layout: unknown };
      doc: unknown;
      base: unknown;
    } | null;
    if (!record) throw new Error("页面重启丢失本机稿");
    return {
      size: record.localBase.png.size,
      type: record.localBase.png.type,
      layout: record.localBase.layout,
      doc: record.doc,
      base: record.base,
      otherStudent: await store.getAnnotationRecord(
        { origin: location.origin, studentId: "idb-fixture-b" },
        scope,
      ),
    };
  });
  expect(restored.size).toBe(saved.size);
  expect(restored.type).toBe("image/png");
  expect(restored.layout).toEqual(saved.layout);
  expect(restored.doc).toEqual(saved.doc);
  expect(restored.base).toBeNull();
  expect(restored.otherStudent).toBeNull();
});
