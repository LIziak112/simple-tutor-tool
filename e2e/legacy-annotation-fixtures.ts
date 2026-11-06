import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { APIRequestContext, Page } from "@playwright/test";
import {
  type AnnotationSurfaceLayout,
  type AttemptQuestionPublic,
  annotationDocSchema,
  annotationSurfaceLayoutSchema,
  annotationViewDataSchema,
  attemptDraftDataSchema,
} from "../packages/contract/src/index";
import {
  addCourseMemberViaApi,
  createCourseViaApi,
  createStudentViaApi,
  getStudentViaApi,
  openChoicePractice,
  setCourseItemVisible,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

export async function readLegacyAnnotation(
  page: Page,
  entry: LegacyFixtureCase,
) {
  return annotationViewDataSchema.parse(
    (await (await page.request.get(entry.viewPath)).json()).data,
  );
}

/** 目标测量与独立旧生成器的原证据对照；不从恢复结果生成新的源基准。 */
export async function inspectLegacyRestoration(
  page: Page,
  entry: LegacyFixtureCase,
) {
  return page.evaluate(
    async ({ questionId, expected }) => {
      const moduleUrl = "/src/features/annotation/question-base-image.tsx";
      const { measureQuestionSurface } = await import(
        /* @vite-ignore */ moduleUrl
      );
      const card = document.querySelector(
        `article[data-question-id="${questionId}"]`,
      );
      const surface = card?.querySelector<HTMLElement>(
        '[data-slot="question-surface"]',
      );
      if (!surface) throw new Error("没有可测量的真实题面");
      const current = measureQuestionSurface(surface, { precise: true }) as {
        cssWidth: number;
        cssHeight: number;
        blocks: {
          tag: string;
          node?: string;
          x: number;
          y: number;
          width: number;
          height: number;
        }[];
        textRects: { x: number; y: number; width: number; height: number }[];
        fonts: string[][];
      };
      const rectDifference = (
        a: { x: number; y: number; width: number; height: number },
        b: { x: number; y: number; width: number; height: number },
      ) =>
        Math.max(
          Math.abs(a.x - b.x),
          Math.abs(a.y - b.y),
          Math.abs(a.x + a.width - b.x - b.width),
          Math.abs(a.y + a.height - b.y - b.height),
        );
      const differences =
        expected?.blocks.map((block, index) => {
          const target = current.blocks[index];
          return {
            index,
            tag: block.tag,
            node: block.node,
            targetTag: target?.tag,
            maxEdgeDelta: target ? rectDifference(block, target) : null,
          };
        }) ?? [];
      const canvas = card?.querySelector<HTMLCanvasElement>(
        'canvas[data-slot="annotation-canvas"]',
      );
      const pixels = canvas
        ?.getContext("2d")
        ?.getImageData(0, 0, canvas.width, canvas.height).data;
      let inkPixels = 0;
      if (pixels)
        for (let i = 3; i < pixels.length; i += 4)
          if ((pixels[i] ?? 0) > 0) inkPixels++;
      return {
        current,
        differences,
        originalBlockCount: expected?.blocks.length ?? null,
        targetBlockCount: current.blocks.length,
        maxBlockEdgeDelta: Math.max(
          0,
          ...differences.map((entry) => entry.maxEdgeDelta ?? Infinity),
        ),
        inkPixels,
        alerts: [...(card?.querySelectorAll('[role="alert"]') ?? [])].map(
          (node) => node.textContent,
        ),
      };
    },
    {
      questionId: entry.questionId,
      expected: entry.original.base?.layout?.compatibility ?? null,
    },
  );
}

export type LegacyFixtureKind =
  | "matching"
  | "ordering"
  | "fill"
  | "hash-only"
  | "v1";
export type LegacyFixtureCase = {
  kind: LegacyFixtureKind;
  questionId: string;
  viewPath: string;
  original: ReturnType<typeof annotationViewDataSchema.parse>;
  pngSha256: string;
  sourceGeometry: unknown;
  question: AttemptQuestionPublic;
};

export function legacyFixtureModuleUrl(baseURL: string): string {
  const path = fileURLToPath(
    new URL("./fixtures/legacy-annotation/browser.tsx", import.meta.url),
  ).replaceAll("\\", "/");
  return `${baseURL.replace(/\/$/, "")}/@fs/${path}`;
}

/** 仅测试学生；所有写入走正式 API，不改 DB/IDB，不依赖 testInfo 或固定端口。 */
export async function seedLegacyAnnotations(
  page: Page,
  request: APIRequestContext,
  baseURL: string,
) {
  await teacherApiLogin(request);
  const suffix = uniqueSuffix();
  const courseName = `旧稿独立夹具${suffix}`;
  const unitName = `旧稿分类${suffix}`;
  const courseId = await createCourseViaApi(request, courseName);
  const markdown = `---
kind: practice
unit: ${unitName}
---

::::material{id=legacy-material title="配对材料"}
第一处 {{slot-1}}，第二处 {{slot-2}}。
::::

:::::question{id=legacy-matching type=matching difficulty=1}
为两个空位选择合适的词语。
::ref{material=legacy-material slots=slot-1..slot-2}
::::options
:::option{id=opt-1}
春风吹过山谷。
:::
:::option{id=opt-2}
秋雨落在窗前。
:::
::::
:::answer
slot-1 = opt-1
slot-2 = opt-2
:::
:::::

::::question{id=legacy-ordering type=ordering difficulty=1}
按顺序排列三个实验步骤。
:::item{id=it-1}
观察并记录初始读数。
:::
:::item{id=it-2}
加入待测样品。
:::
:::item{id=it-3}
整理实验结果。
:::
:::answer
it-1
it-2
it-3
:::
::::

::::question{id=legacy-fill type=fill difficulty=1}
计算 $f'(x)$，结果是 [[2x]]，另一空是 [[3]]。
::::

::::question{id=legacy-hash type=choice difficulty=1}
旧版哈希签名试题：请选择一个选项。
- [x] 第一项
- [ ] 第二项
::::

::::question{id=legacy-v1 type=choice difficulty=1}
旧版无布局试题：保留原有标画。
- [x] 第一项
- [ ] 第二项
::::
`;
  const imported = await request.post("/api/teacher/import/commit", {
    data: { markdown, filename: `${unitName}.md`, courseId },
  });
  if (!imported.ok())
    throw new Error(
      `旧题导入失败 ${imported.status()}：${await imported.text()}`,
    );
  await setCourseItemVisible(request, courseId, unitName, true);
  const loginName = `legacy-${suffix}`;
  await createStudentViaApi(request, "旧稿浏览器测试", loginName);
  const student = await getStudentViaApi(request, loginName);
  await addCourseMemberViaApi(request, courseId, student.id);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${baseURL}/s/${student.linkToken}`);
  await page.waitForURL("**/s/home");
  const attemptId = await openChoicePractice(
    page,
    courseId,
    courseName,
    unitName,
    5,
  );
  const attemptUrl = page.url();
  const detail = attemptDraftDataSchema.parse(
    (
      await (
        await page.request.get(`/api/student/attempts/${attemptId}`)
      ).json()
    ).data,
  );
  const questions = detail.units.flatMap((unit) => unit.questions);
  if (questions.length !== 5) throw new Error("旧稿夹具题数不符");
  const moduleUrl = legacyFixtureModuleUrl(baseURL);
  const cases: LegacyFixtureCase[] = [];
  const kinds = ["matching", "ordering", "fill", "hash-only", "v1"] as const;
  for (const [index, kind] of kinds.entries()) {
    const question = questions[index];
    if (!question) throw new Error("缺少冻结公开题目");
    const viewPath = `/api/student/attempts/${attemptId}/questions/${encodeURIComponent(question.id)}/annotation`;
    let layout: AnnotationSurfaceLayout | undefined;
    let sourceGeometry: unknown = null;
    let png: number[];
    let pixelWidth: number;
    let pixelHeight: number;
    if (kind === "v1") {
      const response = await page.request.post(`${viewPath}/base`);
      if (!response.ok())
        throw new Error(`v1 base 创建失败 ${response.status()}`);
      const preview: unknown = (await response.json()).data;
      const captured = await page.evaluate(
        async ({ moduleUrl, preview }) => {
          const fixture = await import(/* @vite-ignore */ moduleUrl);
          return fixture.captureLegacyV1(preview) as Promise<{
            png: number[];
            pixelWidth: number;
            pixelHeight: number;
          }>;
        },
        { moduleUrl, preview },
      );
      ({ png, pixelWidth, pixelHeight } = captured);
    } else {
      const captured = await page.evaluate(
        async ({ moduleUrl, question, hashOnly }) => {
          const fixture = await import(/* @vite-ignore */ moduleUrl);
          return fixture.captureLegacyQuestion(question, hashOnly) as Promise<{
            layout: unknown;
            sourceGeometry: unknown;
            question: AttemptQuestionPublic;
            png: number[];
            pixelWidth: number;
            pixelHeight: number;
          }>;
        },
        { moduleUrl, question, hashOnly: kind === "hash-only" },
      );
      layout = annotationSurfaceLayoutSchema.parse(captured.layout);
      ({ png, pixelWidth, pixelHeight, sourceGeometry } = captured);
      const response = await page.request.post(`${viewPath}/base`, {
        data: { layout },
      });
      if (!response.ok())
        throw new Error(
          `旧 base 创建失败 ${response.status()}：${await response.text()}`,
        );
    }
    const image = await page.request.post(`${viewPath}/base/image`, {
      multipart: {
        image: {
          name: "legacy-source.png",
          mimeType: "image/png",
          buffer: Buffer.from(png),
        },
        questionRevisionId: question.questionRevisionId,
        baseRenderVersion: String(layout?.renderVersion ?? 1),
      },
    });
    if (!image.ok())
      throw new Error(
        `旧 PNG 上传失败 ${image.status()}：${await image.text()}`,
      );
    // 真正公开题面 PNG 的像素域；红线是独立学生笔迹，不包含题目答案。
    const doc = annotationDocSchema.parse({
      version: 1,
      baseWidth: pixelWidth,
      baseHeight: pixelHeight,
      strokes: [
        {
          id: randomUUID(),
          tool: "pen",
          color: "#dc2626",
          weight: 4,
          pointer: "pen",
          points: [0, 1, 2, 3].map((step) => ({
            x: 30 + step * 18,
            y: kind === "v1" ? 280 : 24,
            p: 0.5,
            t: step * 10,
          })),
        },
      ],
    });
    const uploaded = await page.request.put(viewPath, {
      multipart: {
        body: {
          name: "annotation.json",
          mimeType: "application/json",
          buffer: Buffer.from(JSON.stringify(doc)),
        },
        baseRevision: "0",
        mutationId: randomUUID(),
        ...(layout?.renderVersion === 3 ? { protocolVersion: "3" } : {}),
      },
    });
    if (!uploaded.ok())
      throw new Error(
        `旧正文上传失败 ${uploaded.status()}：${await uploaded.text()}`,
      );
    const original = annotationViewDataSchema.parse(
      (await (await page.request.get(viewPath)).json()).data,
    );
    if (original.base?.state !== "ready" || original.doc?.strokes.length !== 1)
      throw new Error("旧稿未达到真实 ready 状态");
    cases.push({
      kind,
      questionId: question.id,
      viewPath,
      original,
      pngSha256: createHash("sha256").update(Buffer.from(png)).digest("hex"),
      sourceGeometry,
      question,
    });
  }
  return {
    studentLoginUrl: `${baseURL}/s/${student.linkToken}`,
    attemptUrl,
    attemptId,
    cases,
    sourceViewport: { width: 1440, height: 1000 },
    moduleUrl,
  };
}
