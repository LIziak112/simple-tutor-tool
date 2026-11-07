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
          await card.getByRole("button", { name: /给我一点提示/ }).click();
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
          await page.unroute("**/api/student/attempts/*/question-process");
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
              const events = result.segments[0]?.events ?? [];
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
        "annotation:stroke",
        "scratch:stroke",
        "scratch:stroke",
        "scratch:erase",
        "scratch:undo",
        "scratch:redo",
        "annotation:stroke",
      ]);

      expect(
        eventLists
          .get("judge")
          ?.filter((event) => event.kind === "hint")
          .map((event) => event.action),
      ).toEqual(["request", "received", "shown"]);
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
          const changes = player.getByRole("button", { name: /作答变化/ });
          const answer = player.locator(
            '[data-slot="question-process-answer"]',
          );
          await changes.first().click();
          const before = await answer.textContent();
          await changes.last().click();
          await expect(answer).not.toHaveText(before ?? "");
          await expect(player.getByAltText("保存时的题面底图")).toBeVisible();
          if (i < 4 || i > 7)
            await expect(
              player.getByRole("region", { name: "回放草稿" }),
            ).toBeVisible();
          if (i === 0) {
            await player.getByRole("button", { name: /请求提示 1/ }).click();
            await expect(
              player.getByText("已呈现提示：无", { exact: true }),
            ).toBeVisible();
            await player.getByRole("button", { name: /已呈现提示 1/ }).click();
            await expect(
              player.getByText("已呈现提示：1", { exact: true }),
            ).toBeVisible();
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
