import { createContext } from "react";

/** 旧模板只用于核验历史基准；新建题面与公开导出副本使用同一整题模板。 */
export const QuestionRenderContext = createContext<{
  renderVersion: 2 | 3 | 4;
  logicalWidth?: number;
}>({ renderVersion: 4 });
