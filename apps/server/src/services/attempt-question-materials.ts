import type { MaterialPublic, Question, QuestionGroupPublic } from "@tutor/contract";
import {
  materialPublicSchema,
  questionGroupPublicSchema,
} from "@tutor/contract";
import { slotNumberedContentOf } from "@tutor/md-dsl";
import type { Db } from "../db/client.ts";
import { listAttemptContextSnapshots } from "./material-repository.ts";

/**
 * 某题的冻结材料闭包（QM-16/QM-17 共用单源）：组快照 questionIds 含该题的
 * 组材料引用 ∪ 题快照 materialRefs（多材料题内引用）→ 全部版本的材料公开
 * 投影，按 (id, sourceVersion) 稳定排序。与笔记本轮次上下文
 * （note-service notebookRoundContextOf）同一闭包口径——消费方为单题导出
 * （review-pack/AI 上下文），聚合页仍走各自实现，不在此合并。
 *
 * 输出正文为**槽位编号后形态**（{{slot-id}} → **（N）**，md-dsl 单源），
 * 与学生端材料面板同一编号；同 id 多版本并存时逐版成条、title 附
 * 「历史版本 N」说明（双版本卷可分辨「当时看到的是哪一版」）。
 * 坏快照/坏 JSON 跳过该条不抛错（导出侧防御口径：单条脏快照不打挂导出，
 * 与 materialSlotOrderOf 一致）；材料正文不含答案型内容由导入 lint
 * MATERIAL_CONTAINS_ANSWER 保证，公开投影白名单无答案键通道。
 */
export interface FrozenQuestionMaterial {
  readonly id: string;
  readonly sourceVersion: number;
  /** 解析后标题（缺省「材料」；多版本并存时附「历史版本 N」） */
  readonly title: string;
  /** 槽位编号后正文（{{slot-id}} → **（N）**） */
  readonly contentMd: string;
}

export function frozenMaterialsForQuestion(
  db: Db,
  attemptId: string,
  questionId: string,
  snapshot: Question | null,
): FrozenQuestionMaterial[] {
  const materials = new Map<string, MaterialPublic & { sourceVersion: number }>();
  const groups: QuestionGroupPublic[] = [];
  for (const row of listAttemptContextSnapshots(db, attemptId)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.snapshotJson) as unknown;
    } catch {
      continue;
    }
    if (row.kind === "material") {
      const material = materialPublicSchema.safeParse(parsed);
      if (!material.success) continue;
      materials.set(`${material.data.id}|${row.sourceVersion}`, {
        ...material.data,
        sourceVersion: row.sourceVersion,
      });
    } else {
      const group = questionGroupPublicSchema.safeParse(parsed);
      if (!group.success) continue;
      groups.push(group.data);
    }
  }
  const wantedIds = new Set<string>();
  for (const group of groups) {
    if (!(group.questionIds ?? []).includes(questionId)) continue;
    for (const ref of group.materialRefs ?? []) wantedIds.add(ref.material);
  }
  for (const ref of snapshot?.materialRefs ?? []) wantedIds.add(ref.material);
  if (wantedIds.size === 0) return [];

  const collected: FrozenQuestionMaterial[] = [];
  for (const material of materials.values()) {
    if (!wantedIds.has(material.id)) continue;
    collected.push({
      id: material.id,
      sourceVersion: material.sourceVersion,
      title: material.title?.trim() || "材料",
      contentMd: slotNumberedContentOf(material.contentMd, material.slots),
    });
  }
  // 多版本计数（title 徽标判定）：同 id 出现多版才加「历史版本 N」
  const countById = new Map<string, number>();
  for (const material of collected) {
    countById.set(material.id, (countById.get(material.id) ?? 0) + 1);
  }
  const resolved = collected.map((material) => {
    const versionNote =
      (countById.get(material.id) ?? 0) > 1
        ? `（历史版本 ${material.sourceVersion}）`
        : "";
    return { ...material, title: `${material.title}${versionNote}` };
  });
  resolved.sort(
    (a, b) => a.id.localeCompare(b.id) || a.sourceVersion - b.sourceVersion,
  );
  return resolved;
}
