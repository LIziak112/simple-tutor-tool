import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import { drawStrokeWithPointerEvents } from "./helpers";
import {
  inspectLegacyRestoration,
  readLegacyAnnotation,
  seedLegacyAnnotations,
} from "./legacy-annotation-fixtures";
import { qmApi, startQmPair, stopQmPair } from "./qm-server";

test(
  "独立历史模板旧稿的恢复、作答与保稿",
  { tag: ["@annotation"] },
  async ({ browser }, testInfo) => {
    test.setTimeout(180_000);
    const ports =
      testInfo.project.name === "webkit"
        ? { serverPort: 18896, webPort: 15196 }
        : { serverPort: 18895, webPort: 15195 };
    const pair = await startQmPair(ports);
    const context = await browser.newContext({ baseURL: pair.webUrl });
    const request = await qmApi(pair);
    try {
      const page = await context.newPage();
      const seeded = await seedLegacyAnnotations(page, request, pair.webUrl);
      expect(
        seeded.cases.map(
          (entry) => entry.original.base?.layout?.renderVersion ?? 1,
        ),
      ).toEqual([2, 2, 3, 2, 1]);
      const fillLayout = seeded.cases[2]?.original.base?.layout;
      if (fillLayout?.renderVersion !== 3) throw new Error("填空旧稿不是 v3");
      expect(fillLayout.controls).toHaveLength(2);
      expect(
        seeded.cases[3]?.original.base?.layout?.compatibility,
      ).toBeUndefined();
      await page.setViewportSize({ width: 820, height: 1180 });
      await page.reload();
      for (const entry of seeded.cases) {
        const card = page.locator(
          `article[data-question-id="${entry.questionId}"]`,
        );
        await card.scrollIntoViewIfNeeded();
        const blocked = entry.kind === "v1";
        const canvas = card.locator('canvas[data-slot="annotation-canvas"]');
        if (blocked) {
          await expect(card.getByRole("alert").first()).toContainText(
            entry.kind === "v1"
              ? "缺少真实题面位置证据"
              : "偏差超过 10px 或区域不符",
          );
        } else {
          await expect(canvas).toBeVisible();
          await expect
            .poll(
              async () =>
                (await inspectLegacyRestoration(page, entry)).inkPixels,
            )
            .toBeGreaterThan(0);
          if (entry.kind !== "hash-only")
            expect(
              (await inspectLegacyRestoration(page, entry)).maxBlockEdgeDelta,
            ).toBeLessThanOrEqual(10);
        }
        await expect(card.getByRole("img", { name: /冻结原稿/ })).toHaveCount(
          0,
        );
        await expect(
          card.getByRole("button", { name: /进入作答|返回原稿/ }),
        ).toHaveCount(0);
        const before = await readLegacyAnnotation(page, entry);
        expect(before).toEqual(entry.original);
        if (!before.base?.downloadUrl) throw new Error("旧底图没有下载地址");
        const downloadUrl = before.base.downloadUrl;
        const hash = async () =>
          createHash("sha256")
            .update(await (await page.request.get(downloadUrl)).body())
            .digest("hex");
        expect(await hash()).toBe(entry.pngSha256);
        if (entry.kind === "matching") {
          await card.locator("select").first().selectOption({ index: 1 });
          await expect(card.locator("select").first()).not.toHaveValue("");
        } else if (entry.kind === "ordering") {
          await card.getByRole("button", { name: "加入排序" }).first().click();
          await expect(card).toContainText("已填 1/3 空");
        } else if (entry.kind === "fill") {
          const inputs = card.getByRole("textbox");
          await expect(inputs).toHaveCount(2);
          await inputs.first().fill("测试答案");
          await expect(inputs.first()).toHaveValue("测试答案");
        } else {
          await card.getByText("第一项", { exact: true }).click();
          await expect(card.getByRole("radio").first()).toBeChecked();
        }
        await card.getByRole("button", { name: /圈画题干/ }).click();
        if (blocked) {
          await expect(card.getByRole("alert").first()).toContainText(
            entry.kind === "v1"
              ? "缺少真实题面位置证据"
              : "偏差超过 10px 或区域不符",
          );
          expect(await readLegacyAnnotation(page, entry)).toEqual(before);
        } else {
          await expect(canvas).toHaveAttribute("data-input-enabled", "true");
          await drawStrokeWithPointerEvents(canvas);
          await expect
            .poll(
              async () =>
                (await readLegacyAnnotation(page, entry)).doc?.strokes.length,
            )
            .toBe(2);
          const after = await readLegacyAnnotation(page, entry);
          expect(after.doc?.strokes[0]).toEqual(before.doc?.strokes[0]);
          if (!after.base || !before.base) throw new Error("旧底图缺失");
          const { layout: _afterLayout, ...afterIdentity } = after.base;
          const { layout: _beforeLayout, ...beforeIdentity } = before.base;
          expect(afterIdentity).toEqual(beforeIdentity);
          if (entry.kind !== "hash-only")
            expect(after.base?.layout).toEqual(before.base?.layout);
          else {
            if (!after.base?.layout || !before.base?.layout)
              throw new Error("旧版布局缺失");
            const { compatibility: _afterEvidence, ...afterCore } =
              after.base.layout;
            const { compatibility: _beforeEvidence, ...beforeCore } =
              before.base.layout;
            expect(afterCore).toEqual(beforeCore);
          }
          await page
            .getByRole("button", { name: "完成标画", exact: true })
            .click();
        }
        expect(await hash()).toBe(entry.pngSha256);
      }
    } finally {
      await request.dispose();
      await context.close();
      stopQmPair();
    }
  },
);
