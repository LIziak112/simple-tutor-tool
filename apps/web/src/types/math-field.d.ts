import type { MathfieldElement } from "mathlive";

/**
 * <math-field> 自定义元素（MathLive，T2.8「最终答案」数学键盘模式）的 JSX 类型。
 * 属性/事件用 ref 命令式操作（见 FinalAnswerInput），这里只声明最小可用面。
 */
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "math-field": {
        /** label/键盘/禁用等最小属性（其余经 ref 设置） */
        "aria-label"?: string;
        class?: string;
        ref?: React.RefObject<MathfieldElement | null>;
        onInput?: (event: React.FormEvent<MathfieldElement>) => void;
        onFocus?: (event: React.FocusEvent<MathfieldElement>) => void;
        onBlur?: (event: React.FocusEvent<MathfieldElement>) => void;
      };
    }
  }
}
