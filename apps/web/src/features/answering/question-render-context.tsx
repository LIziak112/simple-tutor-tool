import { createContext } from "react";

/** 旧模板只用于核验历史基准；新建题面与公开导出副本使用同一整题模板。 */
export const QuestionRenderContext = createContext<{
  renderVersion: 2 | 3 | 4;
  logicalWidth?: number;
  legacyDirection?: "horizontal" | "vertical";
}>({ renderVersion: 4 });

/** 仅题面内固定公开指令的几何，题外讲义保留原交互。 */
export const QuestionDslContext = createContext<2 | 3 | 4 | null>(null);
