import { expect, type Locator, test } from "@playwright/test";
import {
  HANDWRITTEN_QUESTION_TYPES,
  type QuestionProcessEvent,
  questionProcessReadSchema,
  questionTypeSchema,
} from "../packages/contract/src";
import { questionProcessFixture } from "./fixtures/question-process";
import {
  addCourseMemberViaApi,
  createCourseViaApi,
  drawStrokeWithPointerEvents,
  getStudentViaApi,
  openChoicePractice,
  setCourseItemVisible,
  uniqueSuffix,
} from "./helpers";
import { qmApi, qmTeacherLogin, startQmPair, stopQmPair } from "./qm-server";

async function mark(card: Locator) {
  await card.getByRole("button", { name: /圈画题干/ }).click();
  const canvas = card.locator('canvas[data-slot="annotation-canvas"]');
  await expect(canvas).toHaveAttribute("data-input-enabled", "true");
  await drawStrokeWithPointerEvents(canvas);
  await card
    .page()
    .getByRole("button", { name: "完成标画", exact: true })
    .click();
}

test(
  "普通练习十种题型保存作答变化并进入教师单题回放",
  {
    tag: ["@student", "@teacher", "@annotation"],
  },
  async ({ browser }, info) => {
    test.setTimeout(180_000);
    const pair = await startQmPair(
      info.project.name === "webkit"
        ? { serverPort: 18894, webPort: 15194 }
        : { serverPort: 18893, webPort: 15193 },
      true,
    );
    const request = await qmApi(pair);
    const studentContext = await browser.newContext({ baseURL: pair.webUrl });
    const page = await studentContext.newPage();
    try {
      await qmTeacherLogin(request);
      const suffix = uniqueSuffix();
      const courseName = `过程验收课${suffix}`;
      const unit = `过程验收卷${suffix}`;
      const course = await createCourseViaApi(request, courseName);
      const imported = await request.post("/api/teacher/import/commit", {
        data: {
          markdown: questionProcessFixture(unit, suffix),
          filename: `${unit}.md`,
          courseId: course,
        },
      });
      expect(imported.ok(), await imported.text()).toBe(true);
      await setCourseItemVisible(request, course, unit, true);
      const loginName = `process-${suffix}`;
      const studentRes = await request.post("/api/teacher/students", {
        data: { displayName: "过程验收学生", loginName },
      });
      expect(studentRes.ok()).toBe(true);
      const student = await getStudentViaApi(request, loginName);
      await addCourseMemberViaApi(request, course, student.id);
      await page.goto(`/s/${student.linkToken}`);
      await page.waitForURL("**/s/home");
      await page.setViewportSize({ width: 1240, height: 920 });
      const attempt = await openChoicePractice(
        page,
        course,
        courseName,
        unit,
        10,
      );
      const question = (n: number) =>
        page.getByRole("article", { name: `第 ${n} 题`, exact: true });
      await page.getByRole("button", { name: "练习更多" }).click();
      await page.getByRole("menuitem", { name: "做题过程记录" }).click();
      await page.getByRole("button", { name: "开启过程记录" }).click();
      await expect(page.getByText("过程已同步", { exact: true })).toBeVisible();
      await page.keyboard.press("Escape");

      let putCount = 0;
      page.on("request", (req) => {
        if (req.method() === "PUT" && req.url().includes("/question-process"))
          putCount++;
      });
      const baselineCard = question(1);
      await baselineCard.locator("[data-paper-trigger]").click();
      const baselineCanvas = baselineCard.locator(
        'canvas[data-slot="ink-canvas"], canvas[data-slot="feel-wet"]',
      );
      await drawStrokeWithPointerEvents(baselineCanvas, 1, 100);
      await drawStrokeWithPointerEvents(baselineCanvas, 19);
      await page.waitForTimeout(2000);
      expect(putCount).toBeGreaterThan(0);
      expect(putCount).toBeLessThanOrEqual(2);
      await baselineCard
        .locator('[data-slot="note-layer"]')
        .getByRole("button", { name: /更多/ })
        .click();
      await page
        .getByRole("menuitem", { name: "清空草稿纸", exact: true })
        .click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "清空", exact: true })
        .click();
      await baselineCard.locator("[data-paper-trigger]").click();
      const rows: Array<{ type: string; id: string }> = [];
      for (let n = 1; n <= 10; n += 1) {
        const card = question(n);
        await card.scrollIntoViewIfNeeded();
        await mark(card);
        if (n !== 1) {
          await card.locator("[data-paper-trigger]").click();
          await drawStrokeWithPointerEvents(
            card.locator(
              'canvas[data-slot="ink-canvas"], canvas[data-slot="feel-wet"]',
            ),
          );
          if (n === 5) {
            const canvas = card.locator(
              'canvas[data-slot="ink-canvas"], canvas[data-slot="feel-wet"]',
            );
            await drawStrokeWithPointerEvents(canvas, 1, 0, 0.25);
            await card
              .getByRole("button", { name: "橡皮", exact: true })
              .filter({ visible: true })
              .click();
            await drawStrokeWithPointerEvents(canvas);
            await card
              .getByRole("button", { name: "笔", exact: true })
              .filter({ visible: true })
              .click();
          }
          await expect(card.locator("[data-paper-trigger]")).toHaveAttribute(
            "aria-label",
            /已有笔迹/,
          );
          await card.locator("[data-paper-trigger]").click();
        }
        if (n === 1) {
          await card
            .getByRole("radio", { name: "错", exact: true })
            .locator("xpath=ancestor::label[1]")
            .click();
          const hintButton = card.getByRole("button", { name: /给我一点提示/ });
          const hintPath = "**/api/student/attempts/*/hints";
          await page.route(hintPath, (route) => route.abort("failed"), {
            times: 1,
          });
          await hintButton.click();
          await expect(card.getByRole("alert")).toContainText("重试");

          let releaseHint = () => {};
          const delayedHint = new Promise<void>((resolve) => {
            releaseHint = resolve;
          });
          await page.route(
            hintPath,
            async (route) => {
              await delayedHint;
              await route.continue();
            },
            { times: 1 },
          );
          const requestedHint = page.waitForRequest(hintPath);
          await hintButton.click();
          try {
            await requestedHint;
            await question(4).scrollIntoViewIfNeeded();
            await expect(hintButton).not.toBeInViewport();
          } finally {
            releaseHint();
          }
          await card.getByText("先比较绝对值与原数。").scrollIntoViewIfNeeded();
          await expect(card.getByText("先比较绝对值与原数。")).toBeInViewport();
          // 先让原草稿链路确认一个云端版本，再验收离线修改。
          await card.locator("[data-paper-trigger]").click();
          const paper = card.locator('[data-slot="note-layer"]');
          await drawStrokeWithPointerEvents(paper.locator("canvas"));
          await expect(paper.getByText("1 笔", { exact: true })).toBeVisible();
          await expect(page.getByTestId("draft-status")).toHaveText(
            "全部已保存",
            {
              timeout: 20_000,
            },
          );
          await page.route(
            "**/api/student/attempts/*/question-process",
            (route) =>
              route.request().method() === "PUT"
                ? route.abort("internetdisconnected")
                : route.continue(),
          );
          await studentContext.setOffline(true);
          await drawStrokeWithPointerEvents(paper.locator("canvas"));
          await expect(paper.getByText("2 笔", { exact: true })).toBeVisible();
          await paper
            .getByRole("button", { name: "橡皮", exact: true })
            .click();
          await drawStrokeWithPointerEvents(paper.locator("canvas"));
          await paper
            .getByRole("button", { name: "撤销", exact: true })
            .click();
          await expect(paper.getByText("2 笔", { exact: true })).toBeVisible();
          await paper.getByRole("button", { name: /更多/ }).click();
          await page
            .getByRole("menuitem", { name: "重做", exact: true })
            .click();
          await card.locator("[data-paper-trigger]").click();
          await mark(card);
          await card
            .getByRole("radio", { name: "对", exact: true })
            .locator("xpath=ancestor::label[1]")
            .click();
          await page.getByRole("button", { name: "练习更多" }).click();
          await page.getByRole("menuitem", { name: "做题过程记录" }).click();
          await expect(
            page.getByText("过程待同步", { exact: true }),
          ).toBeVisible();
          await studentContext.setOffline(false);
          // 原稿继续使用自己的同步链。过程上传仍被拦截，验证刷新续传。
          await expect(page.getByTestId("draft-status")).toHaveText(
            "全部已保存",
            {
              timeout: 20_000,
            },
          );
          await page.reload();
          await expect(card.getByText("先比较绝对值与原数。")).toBeVisible();
          await page.unroute("**/api/student/attempts/*/question-process");
          await page.getByRole("button", { name: "练习更多" }).click();
          await page.getByRole("menuitem", { name: "做题过程记录" }).click();
          await expect(
            page.getByText("过程已同步", { exact: true }),
          ).toBeVisible();
          await page.keyboard.press("Escape");
          await card
            .getByRole("radio", { name: "错", exact: true })
            .locator("xpath=ancestor::label[1]")
            .click();
          await expect(
            card.getByRole("radio", { name: "错", exact: true }),
          ).toBeChecked();
          await card
            .getByRole("radio", { name: "对", exact: true })
            .locator("xpath=ancestor::label[1]")
            .click();
        } else if (n === 2) {
          await card
            .getByRole("radio")
            .nth(0)
            .locator("xpath=ancestor::label[1]")
            .click();
          await card
            .getByRole("radio")
            .nth(2)
            .locator("xpath=ancestor::label[1]")
            .click();
        } else if (n === 3) {
          await card
            .getByRole("checkbox")
            .nth(0)
            .locator("xpath=ancestor::label[1]")
            .click();
          await card
            .getByRole("checkbox")
            .nth(1)
            .locator("xpath=ancestor::label[1]")
            .click();
          await card
            .getByRole("checkbox")
            .nth(0)
            .locator("xpath=ancestor::label[1]")
            .click();
        } else if (n === 4) {
          const input = card.getByRole("textbox").first();
          await input.focus();
          await input.dispatchEvent("compositionstart");
          await input.fill("pin");
          await input.fill("拼");
          await input.dispatchEvent("compositionend", { data: "拼" });
          await input.blur();
          await input.fill("1");
          await input.blur();
          await input.fill("2");
          await input.blur();
        } else if (n >= 5 && n <= 7) {
          const input = card.getByRole("textbox", { name: "最终答案" });
          await input.fill("第一版");
          await input.blur();
          await input.fill("第二版");
          await input.blur();
        } else if (n === 8) {
          const input = card.getByRole("textbox", { name: "正文" });
          await input.fill("初稿");
          await input.blur();
          await input.fill("修订稿");
          await input.blur();
        } else if (n === 9) {
          const select = card.getByRole("combobox").first();
          await select.selectOption("opt-1");
          await select.selectOption("opt-2");
        } else {
          await card
            .getByRole("button", { name: "加入排序" })
            .filter({ visible: true })
            .nth(0)
            .click();
          await card
            .getByRole("button", { name: "加入排序" })
            .filter({ visible: true })
            .nth(2)
            .click();
        }
      }
      await expect(page.getByTestId("draft-status")).toHaveText("全部已保存", {
        timeout: 20_000,
      });
      const materialPath = "**/api/student/attempts/*/materials";
      await page.route(materialPath, (route) => route.abort("failed"));
      await page.reload();
      await expect(
        page
          .getByText("当前操作未被记录（材料正在恢复，暂不可编辑）", {
            exact: true,
          })
          .first(),
      ).toBeVisible();
      await expect(page.getByText("过程已同步", { exact: true })).toHaveCount(
        0,
      );
      await page.unroute(materialPath);
      await page
        .getByRole("button", { name: "重试恢复作答材料", exact: true })
        .click();
      await expect(
        page.getByText("当前操作未被记录（材料正在恢复，暂不可编辑）", {
          exact: true,
        }),
      ).toHaveCount(0);

      await question(1)
        .getByRole("radio", { name: "错", exact: true })
        .locator("xpath=ancestor::label[1]")
        .click();
      await expect(
        question(1).getByRole("radio", { name: "错", exact: true }),
      ).toBeChecked();
      await question(1)
        .getByRole("radio", { name: "对", exact: true })
        .locator("xpath=ancestor::label[1]")
        .click();
      await page.getByRole("button", { name: "交卷", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "确认交卷吗？" });
      await dialog.getByRole("button", { name: "确认交卷" }).click();
      await expect(page.getByText("批改结果")).toBeVisible({ timeout: 30_000 });
      const detail = await request.get(`/api/teacher/attempts/${attempt}`);
      expect(detail.ok()).toBe(true);
      const raw = (await detail.json()) as {
        data: {
          questions: Array<{
            type: (typeof questionTypeSchema.options)[number];
            questionId: string;
            ink: { hasStrokes: boolean } | null;
          }>;
        };
      };
      for (const item of raw.data.questions) {
        rows.push({ id: item.questionId, type: item.type });
        if (HANDWRITTEN_QUESTION_TYPES.includes(item.type))
          expect(item.ink?.hasStrokes).toBe(true);
      }
      expect(rows.map((item) => item.type).sort()).toEqual(
        [...questionTypeSchema.options].sort(),
      );
      const eventLists = new Map<string, QuestionProcessEvent[]>();
      let firstHintActions: string[] = [];
      await expect
        .poll(
          async () => {
            for (const item of rows) {
              const response = await request.get(
                "/api/teacher/attempts/" +
                  attempt +
                  "/questions/" +
                  encodeURIComponent(item.id) +
                  "/process",
              );
              if (!response.ok()) continue;
              const body = (await response.json()) as { data: unknown };
              const result = questionProcessReadSchema.parse(body.data);
              for (const segment of result.segments) {
                expect(segment.gap).toBe(false);
                expect(segment.events.map((event) => event.seq)).toEqual(
                  segment.events.map((_, index) => index),
                );
                expect(
                  new Set(segment.events.map((event) => event.seq)).size,
                ).toBe(segment.events.length);
                expect(segment.events.map((event) => event.at)).toEqual(
                  segment.events
                    .map((event) => event.at)
                    .toSorted((a, b) => a - b),
                );
              }
              const events = result.segments.flatMap(
                (segment) => segment.events,
              );
              if (item.type === "judge")
                firstHintActions =
                  result.segments
                    .find((segment) =>
                      segment.events.some(
                        (event) =>
                          event.kind === "hint" && event.action === "request",
                      ),
                    )
                    ?.events.flatMap((event) =>
                      event.kind === "hint" ? [event.action] : [],
                    ) ?? [];
              if (
                events.filter((event) => event.kind === "answer").length >= 2 &&
                events.some(
                  (event) =>
                    event.kind === "ink" &&
                    event.layer === "annotation" &&
                    event.frame?.baseId,
                )
              )
                eventLists.set(item.type, events);
            }
            return [...eventLists.keys()].sort();
          },
          { timeout: 40_000 },
        )
        .toEqual([...questionTypeSchema.options].sort());
      expect(
        eventLists
          .get("judge")
          ?.filter((event) => event.kind === "ink")
          .map((event) => `${event.layer}:${event.operation}`),
      ).toEqual([
        ...Array.from({ length: 20 }, () => "scratch:stroke"),
        "scratch:clear",
        "annotation:stroke",
        "scratch:stroke",
        "scratch:stroke",
        "scratch:erase",
        "scratch:undo",
        "scratch:redo",
        "annotation:stroke",
      ]);

      expect(firstHintActions).toEqual([
        "request",
        "failed",
        "request",
        "received",
        "shown",
      ]);
      const fillAnswers = eventLists
        .get("fill")
        ?.flatMap((event) =>
          event.kind === "answer" && event.answer?.kind === "fill"
            ? [event.answer.values[0]]
            : [],
        );
      expect(fillAnswers).toEqual(["拼", "1", "2"]);
      await expect
        .poll(async () => {
          const response = await request.get(
            `/api/teacher/attempts/${attempt}/questions/${encodeURIComponent(rows.find((item) => item.type === "judge")?.id ?? "")}/process`,
          );
          const payload = (await response.json()) as { data: unknown };
          const process = questionProcessReadSchema.parse(payload.data);
          if (process.segments.length === 3) {
            for (const segment of process.segments.slice(1)) {
              expect(segment.events[0]).toMatchObject({
                kind: "start",
                hints: [0],
              });
              expect(
                segment.events.filter(
                  (event) => event.kind === "hint" && event.action === "shown",
                ),
              ).toEqual([]);
            }
          }
          return process.segments.length;
        })
        .toBe(3);
      const teacher = await browser.newContext({
        baseURL: pair.webUrl,
        storageState: await request.storageState(),
      });
      try {
        const teacherPage = await teacher.newPage();
        await teacherPage.goto(`/t/data/attempts/${attempt}`);
        const players = teacherPage.getByRole("region", {
          name: "单题过程回放",
          exact: true,
        });
        await expect(players).toHaveCount(10);
        for (let i = 0; i < 10; i += 1) {
          const player = players.nth(i);
          await player
            .getByRole("button", { name: "过程回放", exact: true })
            .click();
          if (i === 0) {
            await expect(
              player.getByRole("button", { name: /进入本题/ }).first(),
            ).toBeVisible();
            await expect(
              player.getByRole("button", { name: /离开本题/ }).first(),
            ).toBeVisible();
            await expect(
              player.getByRole("button", { name: /展开草稿纸/ }).first(),
            ).toBeVisible();
            await expect(
              player.getByRole("button", { name: /收起草稿纸/ }).first(),
            ).toBeVisible();
            await expect(
              player.getByRole("button", { name: /提交/ }).first(),
            ).toBeVisible();
            await expect(
              player.getByRole("img", { name: /^在本题区间/ }),
            ).toBeVisible();
            await expect(
              player.getByRole("combobox", { name: "回放范围" }),
            ).toHaveValue("-1");
            await expect(
              player.getByRole("button", { name: /刷新重进/ }),
            ).toHaveCount(2);
            await player
              .getByRole("button", { name: "2×", exact: true })
              .click();
            await expect(
              player.getByRole("button", { name: "2×", exact: true }),
            ).toHaveAttribute("aria-pressed", "true");
            await player
              .getByRole("button", { name: "4×", exact: true })
              .click();
            await expect(
              player.getByRole("button", { name: "4×", exact: true }),
            ).toHaveAttribute("aria-pressed", "true");
            await player
              .getByRole("button", { name: "1×", exact: true })
              .click();
            const actualTime = player.getByRole("checkbox", {
              name: "按真实时间",
            });
            await actualTime.check();
            await expect(actualTime).toBeChecked();
            await actualTime.uncheck();
            await player
              .getByRole("button", { name: /本段起始状态/ })
              .first()
              .click();
            await player
              .getByRole("button", { name: "播放", exact: true })
              .click();
            await expect
              .poll(async () =>
                Number(await player.getByRole("slider").inputValue()),
              )
              .toBeGreaterThan(0);
            await expect
              .poll(
                async () =>
                  player
                    .locator("[data-process-visible-points]")
                    .evaluateAll((nodes) =>
                      nodes.some((node) => {
                        const visible = Number(
                          node.getAttribute("data-process-visible-points"),
                        );
                        const total = Number(
                          node.getAttribute("data-process-total-points"),
                        );
                        return visible > 0 && visible < total;
                      }),
                    ),
                { intervals: [20, 30, 50] },
              )
              .toBe(true);
          }
          const changes = player.getByRole("button", { name: /作答变化/ });
          const answer = player.locator(
            '[data-slot="question-process-answer"]',
          );
          await changes.first().click();
          const before = await answer.textContent();
          await changes.last().click();
          await expect(answer).not.toHaveText(before ?? "");
          if (i === 8) {
            await expect(answer).toContainText("第 1 空 = A ten-minute nap");
          } else if (i === 9) {
            await expect(answer).toContainText(
              "如何对一部作品作出恰如其分的评价？ →",
            );
            await expect(answer).not.toContainText(/it-\d/);
          }
          await expect(player.getByAltText("保存时的题面底图")).toBeVisible();
          if (i >= 4 && i <= 7)
            await expect(
              player.getByRole("region", { name: "回放手写作答", exact: true }),
            ).toBeVisible();
          if (i === 4) {
            const paper = player.getByRole("region", {
              name: "回放手写作答",
              exact: true,
            });
            const writing = player.getByRole("button", {
              name: /手写作答书写/,
            });
            await expect(writing).toHaveCount(2);
            await writing.last().click();
            await expect(
              paper.locator("[data-process-stroke-count]"),
            ).toHaveAttribute("data-process-stroke-count", "2");
            await player.getByRole("button", { name: /手写作答擦除/ }).click();
            await expect(
              paper.locator("[data-process-stroke-count]"),
            ).toHaveAttribute("data-process-stroke-count", "1");
            const ghost = paper.locator("[data-process-deleted-strokes]");
            await expect(ghost).toHaveAttribute(
              "data-process-deleted-strokes",
              "0",
            );
            const canvas = paper.locator("canvas");
            const original = await canvas.evaluate((el) =>
              (el as HTMLCanvasElement).toDataURL(),
            );
            await player
              .getByRole("checkbox", { name: "看擦改", exact: true })
              .check();
            await expect(ghost).toHaveAttribute(
              "data-process-deleted-strokes",
              "1",
            );
            await expect
              .poll(() =>
                canvas.evaluate((el) => (el as HTMLCanvasElement).toDataURL()),
              )
              .not.toBe(original);
            await player
              .getByRole("checkbox", { name: "看擦改", exact: true })
              .uncheck();
            await expect(ghost).toHaveAttribute(
              "data-process-deleted-strokes",
              "0",
            );
            await expect
              .poll(() =>
                canvas.evaluate((el) => (el as HTMLCanvasElement).toDataURL()),
              )
              .toBe(original);
          }
          if (i < 4 || i > 7)
            await expect(
              player.getByRole("region", { name: "回放草稿" }),
            ).toBeVisible();
          if (i === 0) {
            await player
              .getByRole("button", { name: /请求提示 1/ })
              .last()
              .click();
            await expect(
              player.getByText("已呈现提示：无", { exact: true }),
            ).toBeVisible();
            await player.getByRole("button", { name: /已呈现提示 1/ }).click();
            await expect(
              player.getByText("已呈现提示：1", { exact: true }),
            ).toBeVisible();
            const annotation = player
              .getByRole("region", { name: "回放题面", exact: true })
              .locator("[data-process-stroke-count]");
            const circles = player.getByRole("button", { name: /圈画书写/ });
            await circles.first().click();
            await expect(annotation).toHaveAttribute(
              "data-process-stroke-count",
              "1",
            );
            await circles.last().click();
            await expect(annotation).toHaveAttribute(
              "data-process-stroke-count",
              "2",
            );
            const scratch = player
              .getByRole("region", { name: "回放草稿" })
              .locator("[data-process-stroke-count]");
            for (const [label, count] of [
              ["草稿书写", "2"],
              ["草稿擦除", "0"],
              ["草稿撤销", "2"],
              ["草稿重做", "0"],
            ] as const) {
              await player
                .getByRole("button", { name: new RegExp(label) })
                .last()
                .click();
              await expect(scratch).toHaveAttribute(
                "data-process-stroke-count",
                count,
              );
            }
          }
          await player
            .getByRole("button", { name: "收起过程回放", exact: true })
            .click();
        }
        // 服务端缺批次已由路由测试产生 gap=true；这里核对该投影在真实页面的降级。
        const processPath = `**/api/teacher/attempts/${attempt}/questions/*/process`;
        await teacherPage.route(processPath, async (route) => {
          const response = await route.fetch();
          const body = await response.json();
          body.data.segments[0].gap = true;
          body.data.segments[0].events = body.data.segments[0].events.slice(
            0,
            1,
          );
          await route.fulfill({ response, json: body });
        });
        const firstPlayer = players.first();
        await firstPlayer
          .getByRole("button", { name: "过程回放", exact: true })
          .click();
        await expect(
          firstPlayer.getByText("记录有缺失，已显示可回放的部分。", {
            exact: true,
          }),
        ).toBeVisible();
        await firstPlayer
          .getByRole("button", { name: "收起过程回放", exact: true })
          .click();
        await teacherPage.unroute(processPath);
        await teacherPage.route(processPath, async (route) => {
          const response = await route.fetch();
          const body = await response.json();
          body.data.segments = [];
          await route.fulfill({ response, json: body });
        });
        await firstPlayer
          .getByRole("button", { name: "过程回放", exact: true })
          .click();
        await expect(
          firstPlayer.getByText("这道题暂无可回放的过程记录。", {
            exact: true,
          }),
        ).toBeVisible();
        await firstPlayer
          .getByRole("button", { name: "收起过程回放", exact: true })
          .click();
        await teacherPage.unroute(processPath);
        await teacherPage.route(
          "**/api/teacher/annotation-bases/*/image.png",
          (route) =>
            route.fulfill({
              status: 200,
              contentType: "image/png",
              body: "invalid",
            }),
        );
        const player = players.first();
        await player
          .getByRole("button", { name: "过程回放", exact: true })
          .click();
        await player
          .getByRole("button", { name: /圈画书写/ })
          .first()
          .click();
        const stem = player.getByRole("region", { name: "回放题面" });
        await expect(
          stem.getByText("圈画底图无法读取或尺寸不符。"),
        ).toBeVisible();
        await expect(
          stem.locator('[data-slot="question-surface"]'),
        ).toBeVisible();
        await expect(stem.locator("canvas")).toHaveCount(0);
      } finally {
        await teacher.close();
      }
    } finally {
      await studentContext.close();
      await request.dispose();
      stopQmPair();
    }
  },
);
