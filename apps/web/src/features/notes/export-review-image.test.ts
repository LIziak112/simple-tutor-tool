import type { ReviewPackPreviewData } from "@tutor/contract";
import { describe, expect, it } from "vitest";
import {
  buildReviewImageSections,
  planReviewImagePages,
  REVIEW_IMAGE_IMAGE_MAX_HEIGHT_CSS,
  REVIEW_IMAGE_SINGLE_BLOCK_MAX_CONTENT_HEIGHT_CSS,
  REVIEW_IMAGE_STUDENT_NOTE,
  reviewImageCanvasPixelSize,
  reviewImageFilename,
  rgbaSampleAllBlank,
} from "./export-review-image";

/**
 * T6R.19 静态合成图导出——纯函数层失败测试（任务清单要求先写）：
 * - 分页正确性：长内容分片分页——顺序、坐标（每页内容高）、页数，不重不漏；
 * - 隐藏答案节点不进渲染树（模型层守卫）：学生角色载荷含答案哨兵时拒绝
 *   生成（连离屏 DOM 都不建），教师角色按 T6R.13 既有投影照常包含；
 * - 过大画布：单块内容超画布上限 → 分页兜底仍超限 → 显式失败原因；
 * - 文件名：带题号与学生/教师视角，不与既有 zip 命名冲突。
 *
 * DOM 渲染链（离屏构建、栅格化、编码校验）的失败语义见同目录
 * export-review-image-dom.test.ts（注入栅格化依赖）；本文件只测纯函数。
 */

const BASE_STUDENT: ReviewPackPreviewData = {
  role: "student",
  questionNo: 3,
  questionPresent: true,
  handwritten: false,
  evidenceState: "frozen",
  released: true,
  answersIncluded: false,
  complete: true,
  files: [],
  missing: [],
  attachments: [
    {
      path: "evidence/e001-original-01.png",
      kind: "evidence",
      state: "ready",
      bytes: 4096,
      downloadUrl: "/api/student/note-versions/v1/images/i1.png",
    },
  ],
  reviewMd: "",
  questionMd: "### 题目 3\n\n已知 $x+1=4$，求 $x$。\n\n**学生答案**：3\n",
};

describe("buildReviewImageSections（版式模型，纯函数）", () => {
  it("学生载荷：页眉含学生红线文案；题面 markdown 与配图区块在场；缺失附件显式声明", () => {
    const preview: ReviewPackPreviewData = {
      ...BASE_STUDENT,
      complete: false,
      attachments: [
        ...BASE_STUDENT.attachments,
        {
          path: "blobs/media/pic.png",
          kind: "media",
          state: "ready",
          bytes: 2048,
          downloadUrl: "/blobs/media/pic.png",
        },
        {
          path: "evidence/e001-original-02.png",
          kind: "evidence",
          state: "missing",
          bytes: 0,
          reason: "分析图生成失败",
        },
      ],
    };
    const sections = buildReviewImageSections(preview);
    // 页眉：题号 + 学生红线文案（不含参考答案与判定）
    const header = sections.find((s) => s.kind === "header");
    expect(header).toBeDefined();
    expect(JSON.stringify(header)).toContain("第 3 题");
    expect(JSON.stringify(header)).toContain(REVIEW_IMAGE_STUDENT_NOTE);
    // 题面 markdown 原样进入（服务端按角色投影后的 questionMd）
    const md = sections.filter((s) => s.kind === "markdown");
    expect(md).toHaveLength(1);
    expect(JSON.stringify(md)).toContain("已知");
    expect(JSON.stringify(md)).toContain("学生答案");
    // 在场图片区块（真实 downloadUrl）与缺失显式声明
    const images = sections.filter((s) => s.kind === "image");
    expect(images).toHaveLength(2);
    expect(JSON.stringify(images)).toContain("/blobs/media/pic.png");
    const missing = sections.filter((s) => s.kind === "missing-note");
    expect(missing).toHaveLength(1);
    expect(JSON.stringify(missing)).toContain("e001-original-02.png");
    expect(JSON.stringify(missing)).toContain("分析图生成失败");
    // 学生模型全文不含教师域哨兵（答案内容不进版式，更不进渲染树）——
    // 用教师模板节标记与解析原文断言（红线文案本身声明"不含参考答案"属正常）
    const all = JSON.stringify(sections);
    expect(all).not.toContain("**参考答案**");
    expect(all).not.toContain("故选");
  });

  it("教师载荷：照常包含 questionMd 里的参考答案/详解/判定（T6R.13 既有投影）", () => {
    const preview: ReviewPackPreviewData = {
      ...BASE_STUDENT,
      role: "teacher",
      answersIncluded: true,
      questionMd:
        "### 题目 3\n\n题面。\n\n**参考答案**：B\n\n**详解**\n\n故选 B。\n\n**判定**：错\n",
    };
    const sections = buildReviewImageSections(preview);
    const all = JSON.stringify(sections);
    expect(all).toContain("参考答案");
    expect(all).toContain("故选 B");
    expect(all).toContain("判定");
    // 教师页眉不写学生红线文案，写教师视角说明
    expect(all).not.toContain(REVIEW_IMAGE_STUDENT_NOTE);
    expect(all).toContain("教师视角");
  });

  it("答案未公布（学生）：页眉注明无判定属正常", () => {
    const sections = buildReviewImageSections({
      ...BASE_STUDENT,
      released: false,
    });
    expect(JSON.stringify(sections)).toContain("答案尚未公布");
  });

  it("手写作答题：附作答说明（作答即笔迹，没有草稿层属正常）", () => {
    const sections = buildReviewImageSections({
      ...BASE_STUDENT,
      handwritten: true,
    });
    expect(JSON.stringify(sections)).toContain("手写作答");
  });

  it("题目快照缺失：显式缺失声明，不回填当前题库内容", () => {
    const sections = buildReviewImageSections({
      ...BASE_STUDENT,
      questionPresent: false,
      questionMd: "",
      attachments: [],
    });
    const all = JSON.stringify(sections);
    expect(all).toContain("题目内容缺失");
    // 无 markdown 空区块（空 questionMd 不产出 markdown section）
    expect(sections.filter((s) => s.kind === "markdown")).toHaveLength(0);
  });

  it("学生载荷守卫①：questionMd 含 [[答案]] 标记 → 拒绝生成（不建离屏 DOM）", () => {
    expect(() =>
      buildReviewImageSections({
        ...BASE_STUDENT,
        questionMd: "### 题目 3\n\n填空：x=[[二]]。\n",
      }),
    ).toThrow(/答案标记|拒绝生成学生合成图/);
  });

  it("学生载荷守卫②：questionMd 含选项任务列表（[x] 正确项标记）→ 拒绝生成", () => {
    expect(() =>
      buildReviewImageSections({
        ...BASE_STUDENT,
        questionMd: "### 题目 3\n\n选择：\n\n- [x] 选项 A\n- [ ] 选项 B\n",
      }),
    ).toThrow(/拒绝生成学生合成图/);
  });

  it("学生载荷守卫③：questionMd 混入教师模板节（参考答案/详解/判定/评语）→ 拒绝生成", () => {
    for (const marker of [
      "**参考答案**",
      "**详解**",
      "**判定**",
      "**老师评语**",
    ]) {
      expect(() =>
        buildReviewImageSections({
          ...BASE_STUDENT,
          questionMd: `### 题目 3\n\n题面。\n\n${marker}：不应出现在学生载荷\n`,
        }),
      ).toThrow(/拒绝生成学生合成图/);
    }
  });

  it("学生载荷守卫④：answersIncluded=true（载荷不变量破坏）→ 拒绝生成", () => {
    expect(() =>
      buildReviewImageSections({ ...BASE_STUDENT, answersIncluded: true }),
    ).toThrow(/拒绝生成学生合成图/);
  });
});

describe("planReviewImagePages（长内容分片分页：顺序、坐标、页数，不重不漏）", () => {
  /** 顺序可读的块 id：b0..bN */
  const blocksOf = (heights: number[]) =>
    heights.map((heightPx, i) => ({ id: `b${i}`, heightPx }));

  it("全部装得下一页：单页、顺序保持、内容高=块高之和", () => {
    const pages = planReviewImagePages(blocksOf([100, 200, 300, 400]));
    expect(pages).toHaveLength(1);
    expect(pages[0]?.blockIds).toEqual(["b0", "b1", "b2", "b3"]);
    expect(pages[0]?.contentHeightPx).toBe(1000);
    expect(pages[0]?.pageIndex).toBe(0);
  });

  it("恰好等于页高上限：仍单页（边界含端）", () => {
    const pages = planReviewImagePages(blocksOf([500, 500]), {
      maxPageContentHeightPx: 1000,
    });
    expect(pages).toHaveLength(1);
  });

  it("超限拆页：贪心装填、页内容高不超上限、总块序不重不漏", () => {
    const heights = [400, 400, 400, 400, 400]; // 上限 1500 → 页1: 400*3=1200（第4块会到1600超限）→ 页2: 400*2
    const pages = planReviewImagePages(blocksOf(heights));
    expect(pages).toHaveLength(2);
    expect(pages[0]?.blockIds).toEqual(["b0", "b1", "b2"]);
    expect(pages[1]?.blockIds).toEqual(["b3", "b4"]);
    // 每页内容高（坐标预算）不超上限
    for (const page of pages) {
      expect(page.contentHeightPx).toBeLessThanOrEqual(1500);
    }
    // 不重不漏：块 id 并集=全集且无重复，整体顺序保持
    const ids = pages.flatMap((p) => p.blockIds);
    expect(ids).toEqual(["b0", "b1", "b2", "b3", "b4"]);
    expect(new Set(ids).size).toBe(ids.length);
    // 页号从 0 递增
    expect(pages.map((p) => p.pageIndex)).toEqual([0, 1]);
  });

  it("页内坐标（累计偏移）：每页首块从 0 起、块高累加与页内容高一致", () => {
    const pages = planReviewImagePages(blocksOf([600, 600, 600]));
    expect(pages).toHaveLength(2);
    expect(pages[0]?.contentHeightPx).toBe(1200);
    expect(pages[1]?.contentHeightPx).toBe(600);
  });

  it("单块超过常规页高但未超画布兜底上限：独立成页（不截断、不丢块）", () => {
    const pages = planReviewImagePages(blocksOf([100, 1800, 100]), {
      maxPageContentHeightPx: 1500,
      singleBlockMaxContentHeightPx: 1900,
    });
    // b1 独立成页（1800 > 1500），b0/b2 各自或合页——顺序不乱
    expect(pages).toHaveLength(3);
    expect(pages[0]?.blockIds).toEqual(["b0"]);
    expect(pages[1]?.blockIds).toEqual(["b1"]);
    expect(pages[2]?.blockIds).toEqual(["b2"]);
    expect(pages.flatMap((p) => p.blockIds)).toEqual(["b0", "b1", "b2"]);
  });

  it("单块超过画布兜底上限（分页兜底仍超限）：显式失败原因", () => {
    expect(() =>
      planReviewImagePages(blocksOf([100, 5000, 100]), {
        maxPageContentHeightPx: 1500,
        singleBlockMaxContentHeightPx: 1900,
      }),
    ).toThrow(/超过画布|无法分页/);
  });

  it("零高块（测量退化）不产生零页、不误报超限", () => {
    const pages = planReviewImagePages(blocksOf([0, 0, 0]));
    expect(pages).toHaveLength(1);
    expect(pages[0]?.blockIds).toEqual(["b0", "b1", "b2"]);
    expect(pages[0]?.contentHeightPx).toBe(0);
  });

  it("空块列表：零页（调用方保证至少一个页眉块）", () => {
    expect(planReviewImagePages([])).toEqual([]);
  });
});

describe("画布像素尺寸与上限校验", () => {
  it("常规页：宽=固定逻辑宽×像素比，高=（内容高+上下留白）×像素比", () => {
    const size = reviewImageCanvasPixelSize(1500);
    expect(size.width).toBe(1440); // 720 × 2
    expect(size.height).toBe((1500 + 72) * 2); // 内容 + 上下留白 36 ×2
  });

  it("像素高超过画布边长上限 → 抛错（显式失败原因）", () => {
    // 内容高逼近单块兜底上限时 (1900+72)*2=3944 ≤4096 不抛；再大即抛
    expect(() => reviewImageCanvasPixelSize(2200)).toThrow(/画布|超限/);
  });
});

describe("rgbaSampleAllBlank（空白采样判定：纯函数，单次读回后内存取样）", () => {
  /** 64×64 RGBA 全白 / 全透明 / 含灰阶像素的采样数据 */
  const blankWhite = () => new Uint8ClampedArray(64 * 64 * 4).fill(255);
  const blankTransparent = () => new Uint8ClampedArray(64 * 64 * 4); // 全 0（含 alpha 0）

  it("全纯白采样 → 判空白（true）", () => {
    expect(rgbaSampleAllBlank(blankWhite())).toBe(true);
  });

  it("全透明采样 → 判空白（true）", () => {
    expect(rgbaSampleAllBlank(blankTransparent())).toBe(true);
  });

  it("任一采样点为非纯白不透明像素（文字灰阶）→ 判非空白（false）", () => {
    const data = blankWhite();
    // 第 10 个采样点放一个深灰不透明像素（缩到 64×64 后文本仍必有灰阶）
    data[10 * 4] = 15;
    data[10 * 4 + 1] = 23;
    data[10 * 4 + 2] = 42;
    data[10 * 4 + 3] = 255;
    expect(rgbaSampleAllBlank(data)).toBe(false);
  });
});

describe("image 块高度预算（caption 换行余量——审查修复轮 P2-8）", () => {
  it("图片 maxHeight 由单块兜底上限推导（不手抄数），且留足两行图注余量", () => {
    // 单块兜底上限 1976 − 预算 90 = 1886；90 = 图注两行（12px×1.5×2≈36）
    // + 图注上间距 4 + 块上下 margin 28 + 余量 22——长路径 caption 换两行
    // 不再顶爆单块上限（整题 canvas-limit 拒绝的可用性缺陷）
    expect(
      REVIEW_IMAGE_SINGLE_BLOCK_MAX_CONTENT_HEIGHT_CSS -
        REVIEW_IMAGE_IMAGE_MAX_HEIGHT_CSS,
    ).toBe(90);
    expect(REVIEW_IMAGE_IMAGE_MAX_HEIGHT_CSS).toBe(1886);
  });
});

describe("reviewImageFilename（命名：题号+视角，不与 zip 冲突）", () => {
  it("学生/教师视角与页号进入文件名；前缀不同于 review-pack zip", () => {
    expect(reviewImageFilename(3, "student", 0)).toBe(
      "review-image-q3-student-01.png",
    );
    expect(reviewImageFilename(12, "teacher", 2)).toBe(
      "review-image-q12-teacher-03.png",
    );
    // 不与既有 zip 命名（review-pack-qN-时间戳.zip）冲突：前缀不同
    expect(reviewImageFilename(3, "student", 0)).not.toMatch(/^review-pack/);
  });
});
