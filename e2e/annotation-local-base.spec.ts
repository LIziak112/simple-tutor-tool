import { expect, test } from "@playwright/test";

test("本机原位稿：真实IndexedDB原子存PNG/布局/矢量，页面重启恢复且账号隔离", async ({
  page,
}) => {
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
