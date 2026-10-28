import type {
  GroupDirectiveAttrs,
  ItemDirectiveAttrs,
  MaterialDirectiveAttrs,
  OptionDirectiveAttrs,
  OptionsDirectiveAttrs,
  RefDirectiveAttrs,
  SegDirectiveAttrs,
  VariantDirectiveAttrs,
} from "@tutor/contract";
import { FileText, Layers } from "lucide-react";
import { Fragment } from "react";
import type { DirectiveProps } from "./types";

/**
 * TT-06 材料/组/引用渲染壳（静态形态）：材料块、组标记、片段锚点、引用
 * 锚点、选项池、选项、排序项、备选参考。
 *
 * 边界（决策记录 §5.8.3 能力开关）：本文件只交付静态阅读形态——不建任何
 * 真实交互输入。槽位挖空的填写、matching 配对选择、ordering 拖排在
 * TT-08/TT-10 接入学生作答会话（届时按能力开关与题型能力表门控）；新内容
 * 仅经发布开关开启的部署导入（§5.8.4），未开启的部署不出现这些数据。
 *
 * 降级约定：未注册/属性非法指令由宿主统一降级 <UnknownDirective>（保留
 * 正文不崩溃）；::ref 引用锚点在静态形态不可见（合法的空输出用空 fragment，
 * 见 types.ts 注释），其指向的材料展示在 TT-08 卷面投影完成。
 */

/** ::::material 共享材料块：标题行（缺省「材料」）+ 正文 */
export function MaterialDirective({
  attrs,
  children,
}: DirectiveProps<MaterialDirectiveAttrs>) {
  const title = attrs.title?.trim();
  return (
    <section
      data-slot="material"
      className="my-4 rounded-xl border border-border bg-muted/30 p-4"
    >
      <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
        <FileText aria-hidden className="size-4 shrink-0" />
        {title && title.length > 0 ? title : "材料"}
      </p>
      <div className="text-sm leading-7">{children}</div>
    </section>
  );
}

/** ::::group 题组标记：公共说明区（title + label 徽章 + 说明正文） */
export function GroupDirective({
  attrs,
  children,
}: DirectiveProps<GroupDirectiveAttrs>) {
  const title = attrs.title?.trim();
  const label = attrs.label?.trim();
  return (
    <section
      data-slot="question-group"
      className="my-4 rounded-xl border border-border p-4"
    >
      <p className="mb-2 flex flex-wrap items-center gap-2 text-sm font-semibold">
        <Layers aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        {title && title.length > 0 ? title : "题组"}
        {label && label.length > 0 ? (
          <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
            {label}
          </span>
        ) : null}
      </p>
      <div className="text-sm leading-7">{children}</div>
    </section>
  );
}

/**
 * :::seg 片段锚点：透明包裹（不改变排版外观）——锚点是引用定位标记，
 * 阅读形态无独立呈现；::ref{segs=…} 的片段选择展示在 TT-08 卷面投影。
 */
export function SegDirective({ children }: DirectiveProps<SegDirectiveAttrs>) {
  return (
    <div data-slot="material-seg" className="contents">
      {children}
    </div>
  );
}

/** ::ref 引用锚点（叶子指令）：静态形态不可见的结构指针 */
export function RefDirective(_: DirectiveProps<RefDirectiveAttrs>) {
  return <Fragment />;
}

/** ::::options 选项池（matching）：静态列表壳——选项互选交互在 TT-08 接入 */
export function OptionsDirective({
  attrs,
  children,
}: DirectiveProps<OptionsDirectiveAttrs>) {
  return (
    <div
      data-slot="matching-options"
      className="my-3 rounded-xl border border-border p-3"
    >
      <p className="mb-1 text-xs font-medium text-muted-foreground">
        选项池{attrs["allow-repeat"] ? "（可重复选用）" : ""}
      </p>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

/** :::option 选项：静态阅读形态（配对互选交互在 TT-08 接入；干扰项由解析层
 *  从参考答案推导，指令本身不携带 distractor 属性） */
export function OptionDirective({
  children,
}: DirectiveProps<OptionDirectiveAttrs>) {
  return (
    <div
      data-slot="matching-option"
      className="rounded-lg bg-muted/40 px-3 py-2 text-sm leading-7"
    >
      {children}
    </div>
  );
}

/** :::item 排序项（ordering）：静态阅读形态 + fixed/distractor 标记 */
export function ItemDirective({
  attrs,
  children,
}: DirectiveProps<ItemDirectiveAttrs>) {
  return (
    <div
      data-slot="ordering-item"
      className="my-2 rounded-lg border border-border bg-muted/20 p-3 text-sm leading-7"
    >
      {attrs.fixed || attrs.distractor ? (
        <p className="mb-1 flex gap-2 text-xs text-muted-foreground">
          {attrs.fixed ? <span>固定项</span> : null}
          {attrs.distractor ? <span>干扰项</span> : null}
        </p>
      ) : null}
      {children}
    </div>
  );
}

/** :::variant 备选参考（response）：教师预览语境的答案型内容，静态标签壳 */
export function VariantDirective({
  children,
}: DirectiveProps<VariantDirectiveAttrs>) {
  return (
    <div
      data-slot="response-variant"
      className="my-2 rounded-lg border border-dashed border-border p-3 text-sm leading-7"
    >
      <p className="mb-1 text-xs text-muted-foreground">备选参考</p>
      {children}
    </div>
  );
}
