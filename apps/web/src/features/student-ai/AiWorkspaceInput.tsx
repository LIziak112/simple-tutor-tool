import { createContext, type ReactNode, useContext } from "react";
import { createPortal } from "react-dom";

export const AiWorkspaceInputContext = createContext<HTMLElement | null>(null);
/** 题下沿文档流；侧栏与弹窗共用一个限高输入区，正文单独滚动。 */
export function AiWorkspaceInput({ children }: { children: ReactNode }) {
  const target = useContext(AiWorkspaceInputContext);
  return target ? createPortal(children, target) : children;
}
