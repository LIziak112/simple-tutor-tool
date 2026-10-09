import { type RenderResult, render } from "@testing-library/react";
import { RichMarkdown } from "../RichMarkdown";

/**
 * 全管线渲染便捷入口（markdown 相关组件测试共用）：
 * 经 RichMarkdown 走完整 parse → blank → 宿主 → katex → sanitize 管线，
 * 与真实渲染同路径；避免每份测试文件手抄一份包装（T7.2 复用审查收敛）。
 */
export function renderMd(source: string): RenderResult {
  return render(<RichMarkdown source={source} />);
}
