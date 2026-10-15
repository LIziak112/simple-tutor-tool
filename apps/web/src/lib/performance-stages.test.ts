import { afterEach, expect, it, vi } from "vitest";
import { measureStage } from "./performance-stages";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
function recorder() {
  const measure = vi.fn();
  vi.stubGlobal("performance", {
    now: vi.fn().mockReturnValueOnce(10).mockReturnValue(30),
    measure,
    getEntriesByName: () => [],
    clearMeasures: vi.fn(),
  });
  return measure;
}
it("开发模式只记录固定阶段名称和耗时，保留任务返回值", async () => {
  vi.stubEnv("DEV", true);
  const measure = recorder();
  await expect(
    measureStage("annotation:font-css", async () => 42),
  ).resolves.toBe(42);
  expect(measure).toHaveBeenCalledWith("ownclass:annotation:font-css", {
    start: 10,
    duration: 20,
  });
});
it("任务失败与诊断失败都不改变原异常", async () => {
  vi.stubEnv("DEV", true);
  recorder().mockImplementation(() => {
    throw new Error("诊断不可用");
  });
  const error = new Error("字体失败");
  await expect(
    measureStage("annotation:font-css", async () => {
      throw error;
    }),
  ).rejects.toBe(error);
});
it("生产模式不读时钟也不记录阶段", async () => {
  vi.stubEnv("DEV", false);
  const measure = recorder();
  await expect(
    measureStage("annotation:font-css", async () => 42),
  ).resolves.toBe(42);
  expect(performance.now).not.toHaveBeenCalled();
  expect(measure).not.toHaveBeenCalled();
});
