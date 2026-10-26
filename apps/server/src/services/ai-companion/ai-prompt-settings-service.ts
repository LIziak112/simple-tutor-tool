import type {
  AiPromptSettingsData,
  AiPromptSettingsPutRequest,
  AiPromptSlotKey,
  AiPromptSlotState,
} from "@tutor/contract";
import { AI_PROMPT_SLOTS, defaultAiPromptBodyOf } from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { aiPromptOverrides } from "../../db/schema.ts";
import { HttpError } from "../../lib/http-error.ts";

/**
 * AI 提示词设置服务（hall-9533）：GET/PUT /ai/prompts 的唯一业务落点，
 * 以及装配端（export-service / review-pack-service）注入覆盖的唯一读取口。
 *
 * 口径（与教师 AI 设置 / 学生快捷按钮同款约定）：
 * - 覆盖行存 ai_prompt_overrides（ownerType + ownerId + slotKey 主键，
 *   无外键——教师/学生数据永不连带删除）；无行 = 使用契约默认正文
 *   （defaultAiPromptBodyOf 单源），恢复默认 = 删行，不回填默认行；
 * - 版本锚点 = 该主体全部覆盖行的最大 updatedAt（无行 = UNSET 锚点时刻）；
 *   PUT 携带 baseUpdatedAt 时严格比对，不一致 → 409 AI_SETTINGS_STALE
 *   保留服务器值；缺省跳过检测。同一 PUT 的所有行写同一时间戳（同毫秒
 *   连续保存 +1ms 单调前进，锚点比较不失效），整组替换在事务内完成；
 * - 槽位键合法性由契约 schema enum 把关；受众越权（学生写教师槽位等）
 *   在本服务按 404 NOT_FOUND 拒绝（不暴露其他受众槽位的存在性）；
 * - promptOverrideBodyOf 供装配热路径单行读取（每次导出实时读——教师刚
 *   改提示词，下一次导出立即生效），不得缓存跨请求使用。
 */

/** 「未设置」状态的版本锚点：GET 返回它，PUT 回传它时若无并发写即通过 */
const AI_PROMPTS_UNSET_UPDATED_AT = "1970-01-01T00:00:00.000Z";

/** 覆盖主体：teacher（教师端设置）/ student（学生端设置） */
export type AiPromptOwnerType = "teacher" | "student";

/** 读主体的全部覆盖行（≤ 槽位总数行，内存归并即可，无额外索引需求） */
function overrideRowsOf(
  db: Db,
  ownerType: AiPromptOwnerType,
  ownerId: string,
): Array<{ slotKey: AiPromptSlotKey; body: string; updatedAt: string }> {
  return db
    .select({
      slotKey: aiPromptOverrides.slotKey,
      body: aiPromptOverrides.body,
      updatedAt: aiPromptOverrides.updatedAt,
    })
    .from(aiPromptOverrides)
    .where(
      and(
        eq(aiPromptOverrides.ownerType, ownerType),
        eq(aiPromptOverrides.ownerId, ownerId),
      ),
    )
    .all();
}

/** 组锚点：全部覆盖行的最大 updatedAt（无行 = UNSET 锚点） */
function anchorOf(rows: Array<{ updatedAt: string }>): string {
  let anchor = AI_PROMPTS_UNSET_UPDATED_AT;
  for (const row of rows) {
    if (row.updatedAt > anchor) anchor = row.updatedAt;
  }
  return anchor;
}

/** 锚点之后的下一个时间戳：同毫秒（及时钟回拨）时 +1ms 单调前进 */
function nextTimestamp(current: string): string {
  const now = new Date().toISOString();
  if (now > current) return now;
  return new Date(new Date(current).getTime() + 1).toISOString();
}

/** 读提示词设置（无覆盖行 = 全默认正文 + 锚点时刻，不物化行） */
export function getAiPromptSettings(
  db: Db,
  ownerType: AiPromptOwnerType,
  ownerId: string,
): AiPromptSettingsData {
  const rows = overrideRowsOf(db, ownerType, ownerId);
  const byKey = new Map(rows.map((row) => [row.slotKey, row]));
  const slots: AiPromptSlotState[] = AI_PROMPT_SLOTS.filter(
    (meta) => meta.audience === ownerType,
  ).map((meta) => {
    const row = byKey.get(meta.key);
    return {
      key: meta.key,
      title: meta.title,
      description: meta.description,
      group: meta.group,
      body: row?.body ?? defaultAiPromptBodyOf(meta.key),
      defaultBody: defaultAiPromptBodyOf(meta.key),
      isCustom: row !== undefined,
      updatedAt: row?.updatedAt ?? AI_PROMPTS_UNSET_UPDATED_AT,
    };
  });
  return { slots, updatedAt: anchorOf(rows) };
}

/**
 * 部分更新提示词设置：updates 内 body=null = 恢复该槽位默认（删覆盖行）。
 * 版本并发与时间戳口径见文件头；同一 PUT 的多槽位在事务内原子生效。
 */
export function updateAiPromptSettings(
  db: Db,
  ownerType: AiPromptOwnerType,
  ownerId: string,
  body: AiPromptSettingsPutRequest,
): AiPromptSettingsData {
  const rows = overrideRowsOf(db, ownerType, ownerId);
  const currentAnchor = anchorOf(rows);
  if (
    body.baseUpdatedAt !== undefined &&
    body.baseUpdatedAt !== currentAnchor
  ) {
    throw new HttpError(
      409,
      "AI_SETTINGS_STALE",
      "AI 提示词已在其他页面被修改，请刷新后重试",
    );
  }
  // 受众越权按 404 拒绝（契约 enum 只限键集，不校验受众归属）；同键重复
  // 提交后者胜（Map 语义，客户端去重不强制）
  const updates = new Map<AiPromptSlotKey, string | null>();
  for (const update of body.updates) {
    const meta = AI_PROMPT_SLOTS.find((slot) => slot.key === update.key);
    if (meta === undefined || meta.audience !== ownerType) {
      throw new HttpError(404, "NOT_FOUND", "提示词槽位不存在");
    }
    updates.set(update.key, update.body);
  }
  const timestamp = nextTimestamp(currentAnchor);
  db.transaction((tx) => {
    for (const [slotKey, nextBody] of updates) {
      if (nextBody === null) {
        tx.delete(aiPromptOverrides)
          .where(
            and(
              eq(aiPromptOverrides.ownerType, ownerType),
              eq(aiPromptOverrides.ownerId, ownerId),
              eq(aiPromptOverrides.slotKey, slotKey),
            ),
          )
          .run();
        continue;
      }
      tx.insert(aiPromptOverrides)
        .values({
          ownerType,
          ownerId,
          slotKey,
          body: nextBody,
          updatedAt: timestamp,
        })
        .onConflictDoUpdate({
          target: [
            aiPromptOverrides.ownerType,
            aiPromptOverrides.ownerId,
            aiPromptOverrides.slotKey,
          ],
          set: { body: nextBody, updatedAt: timestamp },
        })
        .run();
    }
  });
  return getAiPromptSettings(db, ownerType, ownerId);
}

/**
 * 装配热路径单槽读取（export-service / review-pack-service 注入用）：
 * 无覆盖行返回 null（用默认模板）；每次导出实时读，不缓存。
 */
export function promptOverrideBodyOf(
  db: Db,
  ownerType: AiPromptOwnerType,
  ownerId: string,
  slotKey: AiPromptSlotKey,
): string | null {
  const row = db
    .select({ body: aiPromptOverrides.body })
    .from(aiPromptOverrides)
    .where(
      and(
        eq(aiPromptOverrides.ownerType, ownerType),
        eq(aiPromptOverrides.ownerId, ownerId),
        eq(aiPromptOverrides.slotKey, slotKey),
      ),
    )
    .get();
  return row?.body ?? null;
}
