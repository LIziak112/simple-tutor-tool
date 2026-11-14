import { createContext } from "react";
/** 调用页面的真实主体；它是认证边界输入，不存储阅读焦点。 */
export const LearningPrincipalContext = createContext<
  string | null | undefined
>(undefined);
