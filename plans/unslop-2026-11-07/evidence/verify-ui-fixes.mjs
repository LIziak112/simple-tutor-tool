// 仅连接8899/5199隔离演示环境；真实待公布夹具经原接口建立，不伪造公布投影。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const dir = path.dirname(fileURLToPath(import.meta.url));
const stateDir =
  "C:/Users/HUAYU/AppData/Local/Temp/ownclass-unslop-evidence-20261107";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const make = (role) =>
  browser.newContext({
    baseURL: "http://127.0.0.1:5199",
    storageState: `${stateDir}/${role}-state.json`,
    viewport: { width: 390, height: 844 },
  });
const teacher = await make("teacher");
const student = await make("student");
const tp = await teacher.newPage();
const sp = await student.newPage();
const results = [];
const check = async (name, run) => {
  try {
    const value = await run();
    results.push({ name, passed: true, value });
  } catch (error) {
    results.push({ name, passed: false, error: error.message });
  }
  fs.writeFileSync(
    path.join(dir, "ui-fixes-browser.json"),
    `${JSON.stringify(results, null, 2)}\n`,
  );
  console.log(JSON.stringify(results.at(-1)));
};
const goto = (page, route) => page.goto(route, { waitUntil: "networkidle" });
const screenshot = (page, name) =>
  page.screenshot({ path: path.join(dir, `fixed-${name}.png`) });
const noOverflow = async (page) =>
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    "整页横向溢出",
  );
const unitPath =
  "/s/courses/24993439-c87c-46f7-b773-787099ee06b3/units/有理数随堂练习";
const lessonPath = "/s/lectures/bd7e3bfe-a962-44c4-8b9b-fcbc3984ab6a/lesson";

async function modal(page, route, name, trigger, initial, width, height = 844) {
  await page.setViewportSize({ width, height });
  await goto(page, route);
  const button = page.getByRole("button", { name: trigger }).first();
  await button.click();
  const dialog = page.locator('[data-slot="dialog-content"]');
  await dialog.waitFor();
  assert.equal(
    await page.evaluate(
      () =>
        document.activeElement?.getAttribute("aria-label") ??
        document.activeElement?.textContent?.trim(),
    ),
    initial,
  );
  for (const key of [
    "Tab",
    "Tab",
    "Tab",
    "Tab",
    "Tab",
    "Shift+Tab",
    "Shift+Tab",
    "Shift+Tab",
    "Shift+Tab",
  ]) {
    await page.keyboard.press(key);
    assert.equal(
      await dialog.evaluate((element) =>
        element.contains(document.activeElement),
      ),
      true,
      `${name} ${key}焦点越界`,
    );
  }
  await screenshot(page, `${name}-${width}`);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  assert.equal(
    await button.evaluate((element) => element === document.activeElement),
    true,
    "焦点未返回实际触发按钮",
  );
  return { width, height, focusTrap: true, escape: true, returnFocus: true };
}

try {
  for (const width of [390, 768, 1440]) {
    for (const [page, route, name, trigger, initial] of [
      [tp, "/t/import", "import-dialog", /就地新建文件夹/, "文件夹名"],
      [tp, "/t/shared", "teacher-delete", /^删除共享文件/, "取消"],
      [tp, "/a/shared-files", "admin-delete", /^删除共享文件/, "取消"],
      [sp, unitPath, "unit-redo", "再做一次", "先不做"],
      [sp, lessonPath, "lesson-restart", "重新开始", "先不做"],
    ])
      await check(`${name}-${width}`, () =>
        modal(page, route, name, trigger, initial, width),
      );
  }
  await check("import-landscape", () =>
    modal(
      tp,
      "/t/import",
      "import-landscape",
      /就地新建文件夹/,
      "文件夹名",
      844,
      390,
    ),
  );

  for (const width of [390, 768, 1440]) {
    await check(`analytics-${width}`, async () => {
      await tp.setViewportSize({ width, height: 844 });
      await goto(tp, "/t/insights");
      const focusTop = (
        await tp
          .getByRole("heading", { name: "下节课重点", exact: true })
          .boundingBox()
      ).y;
      if (width === 390) {
        assert.ok(focusTop <= 760, `重点位置${focusTop}`);
        assert.equal(await tp.getByRole("combobox").count(), 0);
        const trigger = tp.getByRole("button", { name: "筛选", exact: true });
        await trigger.click();
        await tp
          .getByRole("button", { name: "最近 7 天", exact: true })
          .click();
        await tp.getByLabel("下节课重点周期").selectOption("30");
        assert.equal(new URL(tp.url()).searchParams.get("days"), "7");
        assert.equal(new URL(tp.url()).searchParams.get("focusDays"), "30");
        await tp.getByRole("button", { name: "完成", exact: true }).click();
        await tp
          .locator('[data-slot="sheet-content"]')
          .waitFor({ state: "detached" });
        assert.equal(
          await trigger.evaluate(
            (element) => element === document.activeElement,
          ),
          true,
        );
        await tp.getByRole("link", { name: "题目视角", exact: true }).click();
        assert.equal(new URL(tp.url()).searchParams.get("focusDays"), "30");
        await tp.getByRole("link", { name: "总览", exact: true }).click();
        await goto(tp, "/t/insights");
      } else assert.equal(await tp.getByRole("combobox").count(), 2);
      await noOverflow(tp);
      await screenshot(tp, `analytics-${width}`);
      return { focusTop, width };
    });
    await check(`unit-results-${width}`, async () => {
      await sp.setViewportSize({ width, height: 844 });
      await goto(sp, unitPath);
      assert.equal(await sp.locator("dl dt").count(), 3);
      assert.equal(await sp.locator("dl dd").count(), 3);
      assert.equal(await sp.getByText("首次表现", { exact: true }).count(), 1);
      await noOverflow(sp);
      await screenshot(sp, `unit-results-${width}`);
      return {
        columns: await sp
          .locator("dl")
          .evaluate((element) => getComputedStyle(element).gridTemplateColumns),
      };
    });
  }

  await check("touch-targets", async () => {
    await tp.setViewportSize({ width: 390, height: 844 });
    await goto(tp, "/t/library");
    const controls = tp.locator(
      'input[aria-label^="选择讲义"], input[aria-label^="选择单元"]',
    );
    const sizes = await controls.evaluateAll((elements) =>
      elements.map((element) => ({
        labelCount: element.labels.length,
        width: element.labels[0]?.getBoundingClientRect().width,
        height: element.labels[0]?.getBoundingClientRect().height,
      })),
    );
    assert.ok(sizes.length > 1);
    assert.ok(
      sizes.every(
        (size) =>
          size.labelCount === 1 && size.width >= 44 && size.height >= 44,
      ),
    );
    const label = controls.first().locator("..");
    const box = await label.boundingBox();
    const before = await controls.first().isChecked();
    await tp.mouse.click(box.x + 2, box.y + 2);
    assert.equal(
      await controls.first().isChecked(),
      !before,
      "热区边缘应能切换勾选",
    );
    await goto(tp, "/t/students");
    const link = tp.getByRole("link", { name: "陈小明", exact: true });
    const nameBox = await link.boundingBox();
    assert.ok(nameBox.width >= 44 && nameBox.height >= 44);
    assert.ok(
      !(await tp.locator("p.font-mono").filter({ hasText: "登录名" }).count()),
    );
    return { sizes, nameBox };
  });

  await check("home-and-progress", async () => {
    const values = [];
    for (const reducedMotion of ["no-preference", "reduce"]) {
      await sp.emulateMedia({ reducedMotion });
      for (const route of ["/s/home", "/s/courses"]) {
        await goto(sp, route);
        if (route === "/s/home") {
          assert.equal(await sp.locator("h1").count(), 1);
          assert.match(await sp.locator("h1").innerText(), /陈小明，你好/);
        }
        const styles = await sp
          .locator(
            '[role="progressbar"] > div, .h-full.rounded-full.bg-primary',
          )
          .evaluateAll((elements) =>
            elements.map((element) => ({
              duration: getComputedStyle(element).transitionDuration,
              property: getComputedStyle(element).transitionProperty,
            })),
          );
        assert.ok(styles.length > 0);
        assert.ok(
          styles.every((value) =>
            value.duration
              .split(",")
              .every((duration) => parseFloat(duration) === 0),
          ),
        );
        values.push({ route, reducedMotion, styles });
      }
    }
    await sp.emulateMedia({ reducedMotion: "no-preference" });
    return values;
  });

  await check("save-size-and-press", async () => {
    await tp.setViewportSize({ width: 1440, height: 900 });
    await goto(tp, "/t/settings");
    const button = tp
      .getByRole("button", { name: "保存更改", exact: true })
      .first();
    const idle = await button.boundingBox();
    const rect = idle;
    await tp.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await tp.mouse.down();
    await tp.waitForTimeout(120);
    const press = await button
      .locator('[data-slot="button-content"]')
      .evaluate((element) => getComputedStyle(element).transform);
    assert.match(press, /^matrix\(0\.96, 0, 0, 0\.96,/);
    assert.deepEqual(
      await button.boundingBox(),
      idle,
      "视觉按压不缩小命中范围",
    );
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    await tp.route(
      "**/api/teacher/settings/capability-profile",
      async (route) => {
        if (route.request().method() === "PUT") {
          await gate;
          await route.continue();
        } else await route.continue();
      },
    );
    await tp.mouse.up();
    await tp.waitForFunction(() =>
      document.querySelector('button[aria-busy="true"]'),
    );
    const pending = await button.boundingBox();
    assert.deepEqual(pending, idle);
    await screenshot(tp, "save-pending");
    release();
    await button.locator('[aria-hidden="true"]').waitFor({ state: "detached" });
    await tp.unroute("**/api/teacher/settings/capability-profile");
    const success = await button.boundingBox();
    assert.deepEqual(success, idle);
    await tp.route(
      "**/api/teacher/settings/capability-profile",
      async (route) => {
        if (route.request().method() === "PUT")
          await route.fulfill({
            status: 500,
            json: {
              ok: false,
              error: { code: "INTERNAL", message: "验收模拟保存失败" },
            },
          });
        else await route.continue();
      },
    );
    await button.click();
    await tp.getByRole("alert").filter({ hasText: "更改仍保留" }).waitFor();
    const failed = await button.boundingBox();
    assert.equal(failed.width, idle.width);
    assert.equal(failed.height, idle.height);
    await tp.unroute("**/api/teacher/settings/capability-profile");
    await tp.emulateMedia({ reducedMotion: "reduce" });
    const current = await button.boundingBox();
    await tp.mouse.move(current.x + 5, current.y + 5);
    await tp.mouse.down();
    const reducedPress = await button
      .locator('[data-slot="button-content"]')
      .evaluate((element) => getComputedStyle(element).transform);
    assert.equal(reducedPress, "none");
    await tp.mouse.move(0, 0);
    await tp.mouse.up();
    await tp.emulateMedia({ reducedMotion: "no-preference" });
    return { idle, pending, success, failed, press, reducedPress };
  });

  await check("real-unpublished", async () => {
    const data = async (response) => {
      assert.ok(response.ok(), await response.text());
      return (await response.json()).data;
    };
    const fixtureFile = path.join(dir, "unpublished-fixture.json");
    let fixture;
    if (fs.existsSync(fixtureFile))
      fixture = JSON.parse(fs.readFileSync(fixtureFile, "utf8"));
    else {
      const title = `UI修复验收·待公布${Date.now()}`;
      const secret = `仅公布后可见的解析${Date.now()}`;
      const markdown = [
        "---",
        "kind: practice",
        `unit: ${title}`,
        "---",
        "",
        '::::question{type=choice difficulty=1 knowledge="UI验收"}',
        "计算1+1。",
        "",
        "- [ ] 1",
        "- [x] 2",
        "",
        ":::solution",
        secret,
        ":::",
        "::::",
      ].join("\n");
      const imported = await data(
        await teacher.request.post("/api/teacher/import/commit", {
          data: { markdown, filename: `${title}.md` },
        }),
      );
      const students = await data(
        await teacher.request.get("/api/teacher/students"),
      );
      const studentId = students.students.find(
        (item) => item.displayName === "陈小明",
      ).id;
      const assigned = await data(
        await teacher.request.post("/api/teacher/assignments", {
          data: {
            title,
            unitIds: [imported.units[0].id],
            studentIds: [studentId],
            answerRelease: "after_due",
            dueAt: new Date(Date.now() + 86400000).toISOString(),
            allowPerQuestionFeedback: false,
          },
        }),
      );
      const assignmentId = assigned.assignments[0].id;
      const started = await data(
        await student.request.post(
          `/api/student/assignments/${assignmentId}/attempt`,
        ),
      );
      const draft = await data(
        await student.request.get(`/api/student/attempts/${started.id}`),
      );
      const questions = draft.units.flatMap((unit) => unit.questions);
      await data(
        await student.request.post(
          `/api/student/attempts/${started.id}/submit`,
          {
            data: {
              revisions: questions.map((question) => ({
                questionId: question.id,
                questionRevisionId: question.questionRevisionId,
              })),
            },
          },
        ),
      );
      fixture = { attemptId: started.id, assignmentId, title, secret };
      fs.writeFileSync(fixtureFile, `${JSON.stringify(fixture, null, 2)}\n`);
    }
    const response = await data(
      await student.request.get(`/api/student/attempts/${fixture.attemptId}`),
    );
    assert.equal(response.answersReleased, false);
    assert.ok(!JSON.stringify(response).includes(fixture.secret));
    const forbidden = [];
    const walk = (value, locator = "data") => {
      if (!value || typeof value !== "object") return;
      for (const [key, item] of Object.entries(value)) {
        if (
          (key === "answers" ||
            key.startsWith("solution") ||
            ["sourceMd", "teacherComment"].includes(key)) &&
          item != null
        )
          forbidden.push(`${locator}.${key}`);
        walk(item, `${locator}.${key}`);
      }
    };
    walk(response);
    assert.deepEqual(forbidden, []);
    const layouts = [];
    for (const width of [390, 768, 1440]) {
      await sp.setViewportSize({ width, height: 900 });
      await goto(sp, `/s/attempts/${fixture.attemptId}`);
      await sp
        .getByRole("heading", { name: "作业已成功交卷！", exact: true })
        .waitFor();
      const banner = sp
        .locator("section")
        .filter({
          has: sp.getByRole("heading", {
            name: "作业已成功交卷！",
            exact: true,
          }),
        })
        .last();
      assert.ok(!(await banner.innerText()).includes("🎉"));
      const frameCount = await banner
        .locator("div")
        .evaluateAll(
          (elements) =>
            elements.filter(
              (element) =>
                parseFloat(getComputedStyle(element).borderTopWidth) > 0,
            ).length,
        );
      assert.equal(frameCount, 1, "九个重复内框应移除，仅保留说明框");
      assert.ok(!(await banner.locator(".font-mono").count()));
      await noOverflow(sp);
      await screenshot(sp, `unpublished-${width}`);
      layouts.push({ width, frameCount });
    }
    return {
      attemptId: fixture.attemptId,
      serverAnswersReleased: response.answersReleased,
      payloadSecretAbsent: true,
      layouts,
    };
  });
} finally {
  await browser.close();
}
assert.ok(
  results.every((result) => result.passed),
  "存在未通过项，见ui-fixes-browser.json",
);
