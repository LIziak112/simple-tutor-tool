/**
 * 本地最小 mdast 结构描述（渲染器内部用）。
 *
 * 说明：渲染端只需要"遍历 + 注入 data.hName/hProperties"两类操作，
 * 在此用局部结构类型描述所依赖的字段，避免为 apps/web 引入
 * @types/mdast / unist-util-visit 等额外依赖（不在既定技术栈清单内）。
 * 这些接口与 mdast 真实节点结构兼容（字段全部可选），可直接经结构化收窄使用。
 */
export interface MdNode {
  readonly type: string;
  value?: string;
  name?: string;
  attributes?: Record<string, string | undefined>;
  children?: MdNode[];
  /**
   * 源位置（向后兼容的可选字段，T6R.12 复审 D20）：remark 解析产物恒携带，
   * 静态素材导出（question-materials）按 start/end line 切原文行注入；
   * 渲染注入路径不读它，故可选。
   */
  position?: {
    readonly start?: { readonly line?: number };
    readonly end?: { readonly line?: number };
  };
  data?: {
    hName?: string;
    hProperties?: Record<string, string | number | boolean>;
  } & Record<string, unknown>;
}

/** remark-directive 三种指令节点在 mdast 中的 type 值 */
export const DIRECTIVE_TYPES = [
  "containerDirective",
  "leafDirective",
  "textDirective",
] as const;

export type DirectiveNodeType = (typeof DIRECTIVE_TYPES)[number];

const DIRECTIVE_TYPE_SET: ReadonlySet<string> = new Set(DIRECTIVE_TYPES);

/** 守卫后的指令节点形态：type 收窄为三种指令之一，name 必为字符串 */
export type DirectiveNode = MdNode & {
  type: DirectiveNodeType;
  name: string;
};

/** 该 mdast 节点是否为 remark-directive 产出的指令节点（且带合法指令名） */
export function isDirectiveNode(node: MdNode): node is DirectiveNode {
  return DIRECTIVE_TYPE_SET.has(node.type) && typeof node.name === "string";
}
