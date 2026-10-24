import type {
  ImportPreviewWarning,
  LintIssue,
  ParsedDocument,
  QuestionGroup,
  UnitGroup,
} from "@tutor/contract";
import { detectNewContent, normalizeQmIds, parseRefAttrs } from "@tutor/md-dsl";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { materials } from "../db/schema.ts";
import { HttpError } from "../lib/http-error.ts";

/**
 * tt-06b / QM-05 导入主链的 QM 专用辅助（preview/commit/batch/zip/编辑共用）：
 * - NEW_CONTENT_DISABLED 发布开关（§5.8.4）：NEW_CONTENT_ENABLED 缺省 false，
 *   关闭部署导入新指令/新属性文档 → 403（判定面 detectNewContent，TT-06 交付）；
 * - 导入规范化回写（§5.2.3）：normalizeQmIds 在 lint/落库前运行——实体 sourceMd
 *   固化缺省 id，imports.rawMd 仍留档教师提交原文（§5.2.5 留档语义）；
 * - UNKNOWN_MATERIAL_REF 教师域解析降级：静态 lint 只看本文档，文档外引用
 *   「库内既有材料」由导入层按教师域解析（错误码表 §5.4.3 归属导入层）；
 * - P2-2 题内块式 ::ref{question=} 预览警告：题内子题引用属无效写法——该行
 *   从 stemMd 排除且不建立引用，预览必须可见、不许静默吞。
 */

/** 教师域存活（未软删）材料 id 集（引用降级与编辑重建共用的一次查询） */
export function liveMaterialIdsOf(db: Db, teacherId: string): Set<string> {
  const ids = new Set<string>();
  for (const row of db
    .select({ id: materials.id })
    .from(materials)
    .where(and(eq(materials.teacherId, teacherId), isNull(materials.deletedAt)))
    .all()) {
    ids.add(row.id);
  }
  return ids;
}

/** 部署级环境变量名（§5.8.4 发布开关；缺省 false = 新内容不开放导入） */
export const NEW_CONTENT_ENABLED_ENV = "NEW_CONTENT_ENABLED";

/** 发布开关读取（部署 env；测试经参数注入显式值，不依赖进程环境） */
export function newContentEnabledFromEnv(): boolean {
  return process.env[NEW_CONTENT_ENABLED_ENV] === "true";
}

/**
 * 发布开关注入参数：显式传入（含 false）优先，缺省读部署 env。
 * preview/commit 的可选参数都经本函数归一——调用方与测试无需各写一遍。
 */
export function resolveNewContentEnabled(
  injected: boolean | undefined,
): boolean {
  return injected ?? newContentEnabledFromEnv();
}

/**
 * 新内容闸门：开关关闭且文档命中新内容标记（新指令/新题型/新属性/槽位标记）
 * → 403 NEW_CONTENT_DISABLED（_usages 附结构化命中清单，供前端定位）。
 * 旧七型文档（无新标记）任何部署照常导入。
 */
export function assertNewContentAllowed(
  markdown: string,
  enabled: boolean,
): void {
  if (enabled) return;
  const usages = detectNewContent(markdown);
  if (usages.length === 0) return;
  const first = usages[0];
  if (first === undefined) return;
  throw new HttpError(
    403,
    "NEW_CONTENT_DISABLED",
    `本文档使用了新内容语法（如 ${first.name}，第 ${first.line} 行），当前部署未开启新内容导入：请让管理员设置环境变量 NEW_CONTENT_ENABLED=true 后重试；共 ${usages.length} 处命中`,
    { _usages: usages },
  );
}

/**
 * 导入规范化回写：在 lint 与落库前把缺省 id 写回源文（§5.2.3 回写=是）。
 * 行号不漂移（单行替换），后续 issue 定位与原文对齐；changed 与否不区分——
 * 调用方一律以规范化后的文本进入解析（幂等：已显式的文档逐字节不变）。
 */
export function normalizeForImport(
  markdown: string,
  fallbackUnitId: string | undefined,
): string {
  return normalizeQmIds(markdown, { fallbackUnitId }).markdown;
}

/**
 * 收集「文档外材料引用」：全部 ::ref 的 material= 目标中未在本文档声明的 id
 * （题级与组级都算）。教师域解析（resolveQmImportIssues）以此为准。
 */
export function collectExternalMaterialIds(
  parsed: ParsedDocument,
): Set<string> {
  const declared = new Set<string>();
  const external = new Set<string>();
  for (const unit of parsed.units) {
    for (const material of unit.materials ?? []) declared.add(material.id);
    for (const group of unit.groups ?? []) {
      for (const ref of group.materialRefs) {
        if (!declared.has(ref.material)) external.add(ref.material);
      }
    }
    for (const question of unit.questions) {
      for (const ref of question.materialRefs ?? []) {
        if (!declared.has(ref.material)) external.add(ref.material);
      }
    }
  }
  return external;
}

/**
 * UNKNOWN_MATERIAL_REF 教师域解析降级：文档外引用若能在教师域内解析到
 * 存活材料（liveMaterials = 教师域材料 id 集，含任意单元），对应 lint error
 * 从 issue 集合移除（错误码表 §5.4.3：跨文档引用「由导入层按教师域解析」）。
 * 解析不到的照报 error（commit 因 LINT_ERROR 拒绝）。
 *
 * 裁决依据是 issue 的结构化 target.material（tt-07b P2-1 落实：md-dsl 生成
 * 时附着），不从 message 文本正则反提取——措辞改写或 id 含「」字符时降级
 * 不静默失效。target 缺失（旧形态）保守保留 error（方向保守：导入被拒，
 * 不产生悬垂放行）。
 */
export function resolveQmImportIssues(
  issues: readonly LintIssue[],
  parsed: ParsedDocument,
  liveMaterialIds: ReadonlySet<string>,
): LintIssue[] {
  const external = collectExternalMaterialIds(parsed);
  const resolvable = new Set(
    [...external].filter((id) => liveMaterialIds.has(id)),
  );
  if (resolvable.size === 0) return [...issues];
  return issues.filter((issue) => {
    if (issue.code !== "UNKNOWN_MATERIAL_REF") return true;
    const id = issue.target?.material;
    return !(id !== undefined && resolvable.has(id));
  });
}

/** 块式 ::ref 行（行首 ::ref{…}，mdast leafDirective 只认行首形态） */
const REF_BLOCK_LINE_RE = /^\s*::ref\{([^}]*)\}\s*$/;

/**
 * 单元组索引 → 顶层组实体的「不可达即断言」（tt-07b P2-2 记账）：unit.groups
 * 与 parsed.groups 由同一次解析派生（两视图同源），索引 id 找不到完整实体 =
 * 解析器内部不一致（正常不可能）——此前 commit 侧静默 continue 丢组，现
 * fail closed 抛 500 拒绝整个导入（commitImport 事务回滚、零写入），
 * 与 reparse 侧逐实体 skipped 报告对齐可见性。
 */
export function requireGroupEntityOf(
  unitGroup: UnitGroup,
  groupEntitiesById: ReadonlyMap<string, QuestionGroup>,
): QuestionGroup {
  const group = groupEntitiesById.get(unitGroup.id);
  if (group === undefined) {
    throw new HttpError(
      500,
      "IMPORT_INCONSISTENT_STATE",
      `导入产物内部不一致：单元题组「${unitGroup.id}」的完整实体在解析结果中缺失（解析器两视图应同源，这是解析缺陷，请反馈）；本次导入已整体取消，未写入任何内容`,
    );
  }
  return group;
}

/**
 * P2-2 预览警告：题内块式 ::ref{question=…}（无效写法——子题引用只能写在
 * ::::group 内）。解析层把该行从 stemMd 排除且不建立引用（题内 ::ref 只认
 * material=）；此处扫描题目 sourceMd 行，逐处产出可见 warning（不静默吞）。
 * 两个出口形态共用同一实现：issue 形态（lintIssue 兼容，单题编辑响应；code
 * 收窄为字面量类型，预览形态映射无需断言）与预览 warning 形态（{code,message}）。
 */
export function qmStemRefIssues(
  parsed: ParsedDocument,
): (LintIssue & { code: "REF_QUESTION_IN_QUESTION" })[] {
  const issues: (LintIssue & { code: "REF_QUESTION_IN_QUESTION" })[] = [];
  for (const unit of parsed.units) {
    for (const question of unit.questions) {
      const lines = question.sourceMd.split("\n");
      for (const [index, line] of lines.entries()) {
        const match = REF_BLOCK_LINE_RE.exec(line);
        if (match === null) continue;
        const attrs = parseRefAttrs(match[1] ?? "");
        const material = attrs.material?.trim();
        const questionTarget = attrs.question?.trim();
        if (
          questionTarget !== undefined &&
          questionTarget.length > 0 &&
          (material === undefined || material.length === 0)
        ) {
          issues.push({
            level: "warning",
            line: index + 1,
            column: 1,
            code: "REF_QUESTION_IN_QUESTION",
            message: `题目「${question.id}」第 ${index + 1} 行的 ::ref{question=${questionTarget}} 是无效写法：子题引用只能写在 ::::group 内；该行不会进入题干，也不会建立引用（题内 ::ref 只支持 material= 引用材料）`,
          });
        }
      }
    }
  }
  return issues;
}

/** qmStemRefIssues 的预览形态出口（ImportPreviewWarning = {code,message}） */
export function qmStemRefWarnings(
  parsed: ParsedDocument,
): ImportPreviewWarning[] {
  return qmStemRefIssues(parsed).map((issue) => ({
    code: issue.code,
    message: issue.message,
  }));
}
