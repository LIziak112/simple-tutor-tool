import { countResponseWords } from "@tutor/contract";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import type {
  AnswerKindView,
  PreparedOf,
  ReferenceOfKind,
  StudentAnswerOfKind,
} from "../types";
import { AnswerComparisonShell, referenceColumnOf } from "./comparison";

/**
 * response 开放作答呈现（QM-09 细项1/2）：
 * - Input：统一多行正文（textarea），旧稿标题与正文完整合并显示；支持 $…$
 *   公式与 Markdown 分段（学生按 DSL 语法书写，回看走 RichMarkdown 渲染）；
 *   文本输入 defer=true 防抖保存（I05 回调节奏与 fill 同款）；
 * - 字数口径单源契约 countResponseWords（中文按字含中文标点、英文按词），
 *   UI 只显示不重算；word-min/max 是建议提示，超限不硬拦不截断（§5.4.1）；
 *   body 契约上限为防御性边界——超限整体拒绝（服务端 400），
 *   任何一层都不截断（§19.2-1）；旧稿 title 保持可读；
 * - 输入面是原生受控 textarea：输入法组合输入（composition）中间态不被
 *   截断——受控值只在 change 事件同步，不对 composition 中间态做变换过滤；
 * - 与正式手写共存：本视图只管文字面，纸面控件区（HandwrittenControls）
 *   由宿主按 HANDWRITTEN_TYPES（response 在派生集合内）另挂，互不替代。
 */

/** 字数建议文案：word-min/max 任一存在即展示（只提示不硬校验，§5.4.1） */
function wordHintOf(
  wordMin: number | undefined,
  wordMax: number | undefined,
): string | null {
  if (wordMin !== undefined && wordMax !== undefined)
    return `建议 ${wordMin}–${wordMax} 字`;
  if (wordMin !== undefined) return `建议不少于 ${wordMin} 字`;
  if (wordMax !== undefined) return `建议不超过 ${wordMax} 字`;
  return null;
}

export const responseView: AnswerKindView<
  StudentAnswerOfKind<"response">,
  PreparedOf<"response">,
  ReferenceOfKind<"response">
> = {
  Input: ({ model, answer, update, disabled = false }) => {
    const title = answer?.title ?? "";
    // 旧稿只在用户编辑时转为统一正文，挂载与读取不改写历史内容。
    const body = [title, answer?.body ?? ""]
      .filter((part) => part !== "")
      .join("\n\n");
    const words = countResponseWords(body);
    const hint = wordHintOf(model.wordMin, model.wordMax);
    return (
      <div className="flex min-w-0 flex-col gap-3">
        <RichMarkdown
          source={model.stemMd}
          className="text-base leading-[1.75]"
        />
        <textarea
          aria-label="正文"
          value={body}
          disabled={disabled}
          rows={8}
          onChange={(event) =>
            update({ kind: "response", body: event.target.value }, true)
          }
          className="min-h-44 w-full min-w-0 resize-y rounded-md border border-input bg-transparent px-3 py-2 text-base leading-[1.75] shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50"
        />
        <p
          aria-live="polite"
          className="text-sm text-muted-foreground"
        >{`正文已写 ${words} 字${hint === null ? "" : `（${hint}，超出建议不扣分也不拦截）`}`}</p>
      </div>
    );
  },
  ReadOnly: ({ answer }) => {
    if (answer === undefined) {
      return (
        <p className="break-words font-medium [overflow-wrap:anywhere]">
          未作答
        </p>
      );
    }
    const title = answer.title?.trim() ?? "";
    return (
      <div className="flex min-w-0 flex-col gap-2">
        {title !== "" && (
          <RichMarkdown
            source={answer.title ?? ""}
            className="min-w-0 font-medium [&_p]:my-0"
          />
        )}
        {answer.body.trim() === "" ? (
          // 仅手写作答：正文面如实留白（笔迹由纸面/回看另行呈现）
          <p className="text-muted-foreground">未填写正文</p>
        ) : (
          <RichMarkdown source={answer.body} className="min-w-0" />
        )}
      </div>
    );
  },
  Reference: ({ reference }) => (
    <div className="flex min-w-0 flex-col gap-2">
      <RichMarkdown source={reference.referenceMd} className="min-w-0" />
      {(reference.variantsMd ?? []).map((variant, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 冻结参考投影的静态只读列表，序号即内容语义（「备选表达 N」），渲染期无重排
        <div key={index} className="min-w-0 border-t border-border pt-2">
          <p className="mb-1 text-muted-foreground">{`备选表达 ${index + 1}`}</p>
          <RichMarkdown source={variant} className="min-w-0" />
        </div>
      ))}
    </div>
  ),
  Comparison: ({ model, answer, reference }) => {
    // QM-11 细项 2：对照保留本人正文与参考表达，并附字数口径行（契约
    // countResponseWords 单源 + wordMin/wordMax 建议——与输入面同一口径，
    // 不硬校验不截断）；未作答不显示字数行（正文为空无对照意义）
    const hint = wordHintOf(model.wordMin, model.wordMax);
    const ownColumn =
      answer === undefined ? (
        responseView.ReadOnly({ model, answer })
      ) : (
        <div className="flex min-w-0 flex-col gap-2">
          {responseView.ReadOnly({ model, answer })}
          <p
            aria-live="polite"
            className="text-xs text-muted-foreground"
          >{`正文共 ${countResponseWords(answer.body)} 字${hint === null ? "" : `（${hint}）`}`}</p>
        </div>
      );
    return (
      <AnswerComparisonShell
        ownColumn={ownColumn}
        referenceColumn={referenceColumnOf(reference, (ref) =>
          responseView.Reference({ model, reference: ref }),
        )}
      />
    );
  },
  completion: (_model, answer, formalInk) => {
    // 决策记录 §5.7.3：filled = body 非空白 或 有正式笔迹（仅手写合法）；
    // 正文空白与笔迹皆无 = empty（isAnswered 纯行为口径另在契约，二者分离）
    const filled = (answer?.body.trim() ?? "") !== "" || formalInk;
    return {
      state: filled ? "filled" : "empty",
      filledSlots: filled ? 1 : 0,
      expectedSlots: 1,
    };
  },
};
