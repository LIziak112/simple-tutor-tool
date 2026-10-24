import type {
  LintIssue,
  Material,
  MaterialRef,
  Question,
  QuestionGroup,
} from "@tutor/contract";
import { makeIssue } from "./shared.ts";

/**
 * TT-06 两遍解析第二遍：引用解析与结构校验（§5.4.4/§5.4.3 静态面）。
 *
 * 第一遍（materials.ts/question.ts）收集实体与引用站点（含行号），本遍
 * 在全部实体就绪后统一裁决——**向后引用合法**（组先声明、题块在后，或反之）：
 * - 组引用健康：子题存在、无重复成员、组不引用组、questionIds 是题序子序列；
 * - 材料/片段/槽位引用闭合：全部 ::ref 的 material/segs/slot(s) 可解析；
 * - 槽位绑定：材料槽位全部被子题/题目绑定（SLOT_UNBOUND），并按绑定形态
 *   派生槽位种类（choice=完形空位、match=配对槽，§5.7.3）；
 * - matching 参考答案的槽位侧收口（选项侧在第一遍本地校验）。
 *
 * 跨教师域（MATERIAL_REF_OUT_OF_DOMAIN）与发布开关（NEW_CONTENT_DISABLED）
 * 是导入/发布层码（静态 lint 不查库），不在本遍——见 new-content.ts 与 QM-05。
 */

/** 引用站点：一次 ::ref 的来源位置与内容（行号是 issue 的定位来源） */
export interface QmRefSite {
  /** 站点属组（组内引用）还是题（题内引用） */
  readonly ownerKind: "group" | "question";
  /** 所属组/题 id（第一遍已定稿的最终 id） */
  readonly ownerId: string;
  /** 材料引用契约形态（material=… 站点）；子题引用站点缺省 */
  readonly materialRef?: MaterialRef;
  /** 组内子题引用目标（question=… 站点） */
  readonly questionTarget?: string;
  readonly line: number;
  readonly column: number;
}

/** 两遍解析第二遍的输入（第一遍产物 + 解析产出题目） */
export interface QmResolutionInput {
  readonly materials: readonly Material[];
  readonly groups: readonly QuestionGroup[];
  readonly questions: readonly Question[];
  /** 引用站点（组/题两路，乱序输入按行号稳定裁决） */
  readonly sites: readonly QmRefSite[];
  /** 组/材料的声明起始行（GROUP_ORDER_INVALID/SLOT_UNBOUND 的定位） */
  readonly entityLines: ReadonlyMap<string, number>;
  readonly issues: LintIssue[];
}

/**
 * 片段/槽位选择串的解析产物：`seg-2` 单个 / `seg-1..seg-3` 区间 / `a,b` 列表
 * （区间是两点 `..`——语料与决策记录 §5.2.2 字面，不是三点省略号）。
 * 每项要么是单点要么是区间（区间端点为声明 id，按目标实体的文档顺序展开）。
 */
interface SelectionItem {
  readonly raw: string;
  readonly from: string;
  readonly to: string | undefined;
}

function parseSelection(selection: string): SelectionItem[] {
  const items: SelectionItem[] = [];
  for (const partRaw of selection.split(",")) {
    const part = partRaw.trim();
    if (part.length === 0) continue;
    const range = /^(.+?)\.\.(.+)$/.exec(part);
    if (range !== null) {
      items.push({ raw: part, from: range[1]?.trim() ?? "", to: range[2]?.trim() });
    } else {
      items.push({ raw: part, from: part, to: undefined });
    }
  }
  return items;
}

/** 第二遍入口：就地派生槽位种类并输出全部结构 issue（不抛异常） */
export function resolveQmReferences(input: QmResolutionInput): void {
  const { materials, groups, questions, sites, entityLines, issues } = input;

  const materialById = new Map(materials.map((m) => [m.id, m]));
  const groupIds = new Set(groups.map((g) => g.id));
  const questionOrder = new Map(questions.map((q, index) => [q.id, index]));
  const questionById = new Map(questions.map((q) => [q.id, q]));
  const sortedSites = [...sites].sort(
    (a, b) => a.line - b.line || a.column - b.column,
  );

  // ---- 组引用健康（子题存在/重复/组引用组/题序子序列） ----
  const memberFirstSite = new Map<string, QmRefSite>();
  for (const group of groups) {
    const groupLine = entityLines.get(group.id) ?? 1;
    let lastPos = -1;
    for (const target of group.questionIds) {
      const site = sortedSites.find(
        (s) =>
          s.ownerKind === "group" &&
          s.ownerId === group.id &&
          s.questionTarget === target,
      );
      const line = site?.line ?? groupLine;
      const column = site?.column ?? 1;
      if (groupIds.has(target)) {
        issues.push(
          makeIssue(
            "error",
            line,
            column,
            "GROUP_NESTED_OR_CYCLIC",
            `组「${group.id}」的 ::ref{question=${target}} 指向另一个组：首版题组仅一层，组不能引用组；请直接引用题块 id`,
          ),
        );
        continue;
      }
      const pos = questionOrder.get(target);
      if (pos === undefined) {
        issues.push(
          makeIssue(
            "error",
            line,
            column,
            "GROUP_MEMBER_NOT_FOUND",
            `组「${group.id}」引用的子题「${target}」在本文档中不存在：::ref{question=} 的目标必须是本文档的题块 id`,
          ),
        );
        continue;
      }
      // 重复成员优先于题序判定：组内重复本身就是唯一性错误，不再让它
      // 顺带触发 GROUP_ORDER_INVALID（重复目标也不参与子序列游标推进）
      const first = memberFirstSite.get(target);
      if (first !== undefined) {
        issues.push(
          makeIssue(
            "error",
            line,
            column,
            "GROUP_MEMBER_DUPLICATED",
            `子题「${target}」被重复引用（第 ${first.line} 行已引用）：同一题在同一文档只能进一个组、组内只能引用一次（一个 attempt 内每题恰出现一次）`,
          ),
        );
        continue;
      }
      if (site !== undefined) memberFirstSite.set(target, site);
      if (pos <= lastPos) {
        issues.push(
          makeIssue(
            "error",
            groupLine,
            1,
            "GROUP_ORDER_INVALID",
            `组「${group.id}」的子题顺序（${group.questionIds.join(" → ")}）不是单元题序的子序列：组的 ::ref{question=…} 书写顺序必须与题块在文档中的顺序一致（逆序请调整引用顺序或题块位置）`,
          ),
        );
        lastPos = pos;
        continue;
      }
      lastPos = pos;
    }
  }

  // ---- 材料/片段/槽位引用闭合 + 槽位绑定登记 ----
  /** 每个材料被绑定的槽位：slotId → 派生种类（首个绑定者定种类） */
  const boundSlots = new Map<string, Map<string, "choice" | "match">>();
  const bind = (materialId: string, slotId: string, kind: "choice" | "match") => {
    const per = boundSlots.get(materialId) ?? new Map<string, "choice" | "match">();
    if (!per.has(slotId)) per.set(slotId, kind);
    boundSlots.set(materialId, per);
  };

  for (const site of sortedSites) {
    const ref = site.materialRef;
    if (ref === undefined) continue;
    const material = materialById.get(ref.material);
    if (material === undefined) {
      issues.push(
        makeIssue(
          "error",
          site.line,
          site.column,
          "UNKNOWN_MATERIAL_REF",
          `::ref 引用的材料「${ref.material}」在本文档中不可解析（未声明）：材料须用 ::::material 在文档顶层声明后才能被引用；跨单元既有材料的引用由导入层按教师域解析（本提示为文档内静态检查）`,
        ),
      );
      continue;
    }
    const anchorPos = new Map(material.anchors.map((a, i) => [a.id, i]));
    const slotPos = new Map(material.slots.map((s, i) => [s.id, i]));

    // 片段选择（segs）
    if (ref.segs !== undefined) {
      for (const item of parseSelection(ref.segs)) {
        if (item.to === undefined) {
          if (!anchorPos.has(item.from)) {
            issues.push(
              makeIssue(
                "error",
                site.line,
                site.column,
                "SEG_REF_UNKNOWN",
                `segs= 引用的片段锚点「${item.from}」在材料「${material.id}」中不存在：锚点用 :::seg{id=…} 在材料内声明`,
              ),
            );
          }
        } else {
          const from = anchorPos.get(item.from);
          const to = anchorPos.get(item.to);
          if (from === undefined || to === undefined) {
            issues.push(
              makeIssue(
                "error",
                site.line,
                site.column,
                "SEG_RANGE_OUT_OF_BOUNDS",
                `segs= 区间「${item.raw}」的端点不在材料「${material.id}」的锚点范围内（锚点：${[...anchorPos.keys()].join("、") || "无"}）：区间端点必须是已声明的锚点 id`,
              ),
            );
          } else if (from > to) {
            issues.push(
              makeIssue(
                "error",
                site.line,
                site.column,
                "SEG_RANGE_OUT_OF_BOUNDS",
                `segs= 区间「${item.raw}」逆序（${item.to} 在文档顺序上先于 ${item.from}）：区间按材料内出现顺序书写，如 ${item.to}..${item.from}`,
              ),
            );
          }
        }
      }
    }

    // 单槽位绑定（slot=）
    if (ref.slot !== undefined) {
      if (!slotPos.has(ref.slot)) {
        issues.push(
          makeIssue(
            "error",
            site.line,
            site.column,
            "UNKNOWN_SLOT_REF",
            `slot= 引用的槽位「${ref.slot}」在材料「${material.id}」中不存在（槽位：${[...slotPos.keys()].join("、") || "无"}）：槽位用 {{槽位id}} 标记在材料正文中声明`,
          ),
        );
      } else {
        bind(material.id, ref.slot, "choice");
      }
    }

    // 槽位集合（slots=）：matching 声明槽位集合；其他题型按 choice 绑定收口
    if (ref.slots !== undefined) {
      const owner =
        site.ownerKind === "question" ? questionById.get(site.ownerId) : undefined;
      const kind: "choice" | "match" =
        site.ownerKind === "question" && owner?.type === "matching"
          ? "match"
          : "choice";
      for (const item of parseSelection(ref.slots)) {
        const ids: string[] =
          item.to === undefined
            ? [item.from]
            : expandRange(item.from, item.to, slotPos);
        if (item.to === undefined) {
          if (!slotPos.has(item.from)) {
            issues.push(
              makeIssue(
                "error",
                site.line,
                site.column,
                "UNKNOWN_SLOT_REF",
                `slots= 引用的槽位「${item.from}」在材料「${material.id}」中不存在（槽位：${[...slotPos.keys()].join("、") || "无"}）`,
              ),
            );
            continue;
          }
        } else {
          const from = slotPos.get(item.from);
          const to = slotPos.get(item.to);
          if (from === undefined || to === undefined || from > to) {
            issues.push(
              makeIssue(
                "error",
                site.line,
                site.column,
                "UNKNOWN_SLOT_REF",
                `slots= 区间「${item.raw}」的端点不在材料「${material.id}」的槽位序列内或区间逆序（槽位：${[...slotPos.keys()].join("、") || "无"}）`,
              ),
            );
            continue;
          }
        }
        for (const id of ids) bind(material.id, id, kind);
      }
    }
  }

  // ---- 槽位绑定收口：材料槽位必须全部被绑定，并回写派生种类 ----
  for (const material of materials) {
    const materialLine = entityLines.get(material.id) ?? 1;
    const bindings = boundSlots.get(material.id);
    for (const slot of material.slots) {
      const kind = bindings?.get(slot.id);
      if (kind === undefined) {
        issues.push(
          makeIssue(
            "error",
            materialLine,
            1,
            "SLOT_UNBOUND",
            `材料「${material.id}」的槽位「${slot.id}」未被任何题目绑定：材料槽位必须由子题 ::ref{slot=…} 逐空绑定或 matching 题 ::ref{slots=…} 声明集合（第 n 空对应第 n 道子题，绑定必须显式声明）`,
          ),
        );
        continue;
      }
      // 就地回写派生种类（choice/match；第一遍的 text 占位在此定稿）
      (slot as { slotKind: Material["slots"][number]["slotKind"] }).slotKind =
        kind;
    }
  }

  // ---- matching 参考答案槽位侧收口：pairs 的键必须在题目声明的槽位集合内 ----
  for (const question of questions) {
    if (question.answers?.kind !== "matching") continue;
    const declared = new Set<string>();
    for (const ref of question.materialRefs ?? []) {
      const material = materialById.get(ref.material);
      if (material === undefined) continue;
      if (ref.slots !== undefined) {
        const slotPos = new Map(material.slots.map((s, i) => [s.id, i]));
        for (const id of expandSelection(ref.slots, slotPos)) declared.add(id);
      }
      if (ref.slot !== undefined) declared.add(ref.slot);
    }
    for (const slotId of Object.keys(question.answers.pairs)) {
      if (declared.has(slotId)) continue;
      issues.push(
        makeIssue(
          "error",
          entityLines.get(question.id) ?? 1,
          1,
          "INVALID_REFERENCE_ANSWER_FORMAT",
          `matching 参考答案的槽位「${slotId}」不在题目 ::ref{slots=…} 声明的槽位集合内：参考映射的键必须是本题声明的槽位 id；该参考答案不落结构化字段，发布校验将拒绝`,
        ),
      );
      // 槽位侧未知：结构化答案整体作废（与第一遍行式校验同款收口）
      delete (question as { answers?: unknown }).answers;
      break;
    }
  }
}

/** 区间展开：按目标实体文档顺序取 [from, to] 闭区间的全部 id（调用方保证端点存在） */
function expandRange(
  from: string,
  to: string,
  positions: ReadonlyMap<string, number>,
): string[] {
  const start = positions.get(from);
  const end = positions.get(to);
  if (start === undefined || end === undefined || start > end) return [];
  return [...positions.entries()]
    .filter(([, pos]) => pos >= start && pos <= end)
    .sort((a, b) => a[1] - b[1])
    .map(([id]) => id);
}

/** 选择串全展开（matching 槽位集合收口用）：区间 + 单点 + 列表 → 全部 id */
function expandSelection(
  selection: string,
  positions: ReadonlyMap<string, number>,
): string[] {
  const ids: string[] = [];
  for (const item of parseSelection(selection)) {
    if (item.to === undefined) ids.push(item.from);
    else ids.push(...expandRange(item.from, item.to, positions));
  }
  return ids;
}
