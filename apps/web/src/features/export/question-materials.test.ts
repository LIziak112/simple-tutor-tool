import { describe, expect, it, vi } from "vitest";
import { buildStaticQuestionMaterial } from "./question-materials";

/**
 * question-materials 前端薄壳测试（T6R.13 起纯函数实现移入 @tutor/md-dsl，
 * 行为测试随迁 packages/md-dsl/src/v2/static-material.test.ts；此处只留
 * DOM 渲染（renderGraphFigurePng）与 re-export 冒烟）。
 */

/**
 * 绘制函数桩：mock 模块固定为**生产 chunk 形态**（default 双重包裹，真函数
 * 在 default.default，T6R.23 P2-3 根因形态）——渲染效果为向目标容器注入 SVG，
 * 供后续 SVG→Canvas→PNG 链路取图。
 */
const plotMock = vi.hoisted(() =>
  vi.fn((options: { target: HTMLElement }) => {
    options.target.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0" /></svg>';
    return null;
  }),
);

vi.mock("function-plot", () => ({ default: { default: plotMock } }));

describe("re-export 冒烟（纯函数来自 md-dsl 单一实现）", () => {
  it("buildStaticQuestionMaterial 经 web 路径可用且为学生角色守卫", () => {
    const material = buildStaticQuestionMaterial({
      role: "student",
      stemMd: "纯文字题干",
    });
    expect(material.markdown).toContain("纯文字题干");
    expect(() =>
      buildStaticQuestionMaterial({ role: "student", stemMd: "计算 [[42]]" }),
    ).toThrow(/答案标记/);
  });
});

describe("renderGraphFigurePng（图表静态化，显式失败语义）", () => {
  it("任何环境失败都不抛错：返回 ok=false 与可读原因（不伪造图片、无截图兜底）", async () => {
    const { renderGraphFigurePng } = await import("./question-materials");
    const host = document.createElement("div");
    // jsdom 无 Canvas 实现（getContext 缺失/抛错或 URL.createObjectURL 未实现），
    // 全部落入显式失败分支——锁定「失败返回原因而非抛错/伪造」的契约
    const result = await renderGraphFigurePng(host, { fn: "x^2" });
    if (result.ok) {
      expect(result.dataUrl.startsWith("data:image/png")).toBe(true);
    } else {
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("renderGraphFigurePng（function-plot 生产形态互操作，T6R.23 P2-3）", () => {
  it("default 双重包裹形态：绘制函数被调用且 SVG→Canvas→PNG 链路产出 dataUrl", async () => {
    // jsdom 无 Canvas 实现、未实现 URL.createObjectURL、不加载图片资源：
    // 用最小桩替换这三处，端到端锁定修复后的浏览器链路（生产形态）走通
    const fakeContext = {
      fillStyle: "",
      fillRect: vi.fn(),
      drawImage: vi.fn(),
    };
    const getContextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockImplementation(
        () => fakeContext as unknown as CanvasRenderingContext2D,
      );
    const toDataUrlSpy = vi
      .spyOn(HTMLCanvasElement.prototype, "toDataURL")
      .mockReturnValue("data:image/png;base64,ZmFrZQ==");
    // jsdom 未实现 createObjectURL（类型声明存在、运行时缺失）：直接补桩；
    // 不还原——jsdom 本无实现，且 vitest 按文件隔离环境，不外泄
    URL.createObjectURL = vi.fn(() => "blob:mock-svg");
    URL.revokeObjectURL = vi.fn();
    /** Image 桩：赋值 src 同步触发 onload（jsdom 不加载图片资源） */
    class StubImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      private url = "";
      set src(value: string) {
        this.url = value;
        this.onload?.();
      }
      get src(): string {
        return this.url;
      }
    }
    vi.stubGlobal("Image", StubImage);

    try {
      const { renderGraphFigurePng } = await import("./question-materials");
      const host = document.createElement("div");
      const result = await renderGraphFigurePng(
        host,
        { fn: "x^2", range: "-3,3" },
        320,
        200,
      );
      // 生产形态下绘制函数必须被真正调用（修复前 default 非函数直接抛 TypeError）
      expect(plotMock).toHaveBeenCalledTimes(1);
      expect(plotMock).toHaveBeenCalledWith(
        expect.objectContaining({
          target: host,
          width: 320,
          height: 200,
          data: [{ fn: "x^2", graphType: "polyline" }],
          xAxis: { domain: [-3, 3] },
        }),
      );
      expect(result).toEqual({
        ok: true,
        dataUrl: "data:image/png;base64,ZmFrZQ==",
      });
    } finally {
      getContextSpy.mockRestore();
      toDataUrlSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
