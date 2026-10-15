import type {
  StudentQuickButton,
  StudentQuickButtonsData,
  StudentQuickButtonsPutRequest,
} from "@tutor/contract";
import { aiMaterialPreferenceSchema, DEFAULT_QUICK_BUTTONS } from "@tutor/contract";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { aiQuickButtons } from "../../db/schema.ts";
import { HttpError } from "../../lib/http-error.ts";

/**
 * SAI-08 学生快捷按钮服务（B03）：GET/PUT /api/student/ai/quick-buttons 的
 * 唯一业务落点。归属恒为会话学生（路由从 c.var.student.id 传入，客户端
 * 无可传归属字段——契约请求 schema strict，teacherId 等字段整体拒绝）。
 *
 * 存储约定（在 SAI-05 表物理约束上确定的服务层映射，schema.ts 表注释的
 * 落地说明）：
 * - 行 id 存 `${studentId}:${契约按钮 id}`。表主键是全局 id，而默认按钮
 *   契约 id 是全体学生共用的固定语义 id（hint-next 等）——不加命名空间
 *   两名学生同时恢复默认就会撞主键；读回时剥前缀还原契约 id。
 * - 默认四按钮不物化（契约 DEFAULT_QUICK_BUTTONS 单源兜底，SAI-05 避免
 *   每位学生四行回填的立场）；恢复默认 = 学生确认后整组显式提交常量。
 * - 空组（删光）必须持久：用墓碑行承载——行 id 前缀本身（`${studentId}:`，
 *   契约 id 最短 1 字符，合法按钮永远产生不了这个物理 id）、orderIndex=-1
 *   （契约 orderIndex 最小 0）。墓碑同时是空组的版本锚点，重取不回填默认。
 * - 整组版本锚点：一次 PUT 的所有行写同一时间戳（事务内整组替换），组
 *   updatedAt 即该时间戳；同毫秒连续保存 +1ms 单调前进，锚点比较不失效。
 *
 * 并发编辑（B00 规则，与教师设置同口径）：PUT 携带 baseUpdatedAt 时与当前
 * 组锚点严格比对，不一致 → 409 AI_SETTINGS_STALE 保留服务器值（后台重取
 * 不覆盖本地编辑）；缺省跳过检测（契约可选字段）。校验规则（空白/超长/
 * 重复 id/顺序冲突/数量上限）全部由契约 schema 在路由层单源把关，服务只
 * 收已解析请求体；整组替换在事务内完成，任何失败不留下半新半旧的列表。
 */

/** 「未配置」状态的版本锚点：GET 返回它，PUT 回传它时若无并发写即通过 */
const QUICK_BUTTONS_UNSET_UPDATED_AT = "1970-01-01T00:00:00.000Z";

/** 行 id 命名空间分隔：`${studentId}:${契约id}`（students.id 为 UUID，不含冒号） */
function rowId(studentId: string, buttonId: string): string {
  return `${studentId}:${buttonId}`;
}

/** 墓碑行 id：前缀本身（契约按钮 id min(1)，合法输入永远产生不了它） */
function tombstoneId(studentId: string): string {
  return `${studentId}:`;
}

/** 契约按钮 id ← 行 id（剥学生前缀） */
function contractIdOf(studentId: string, rowIdValue: string): string {
  return rowIdValue.slice(studentId.length + 1);
}

/** 组锚点之后的下一个时间戳：同毫秒（及时钟回拨）时 +1ms 单调前进 */
function nextTimestamp(current: string): string {
  const now = new Date().toISOString();
  if (now > current) return now;
  return new Date(new Date(current).getTime() + 1).toISOString();
}

/** 行 → 契约按钮投影（attachmentPref 经契约 schema 复核后再出域） */
function projectRow(
  studentId: string,
  row: typeof aiQuickButtons.$inferSelect,
): StudentQuickButton {
  return {
    id: contractIdOf(studentId, row.id),
    name: row.name,
    prompt: row.prompt,
    orderIndex: row.orderIndex,
    enabled: row.enabled,
    attachmentPref: aiMaterialPreferenceSchema.parse(
      JSON.parse(row.attachmentPref),
    ),
  };
}

/** 当前整组锚点：无行 = 未设置锚点；有行 = 行时间戳最大值（整组同戳，防御取 max） */
function currentAnchor(
  rows: (typeof aiQuickButtons.$inferSelect)[],
): string {
  if (rows.length === 0) return QUICK_BUTTONS_UNSET_UPDATED_AT;
  return rows.reduce(
    (max, row) => (row.updatedAt > max ? row.updatedAt : max),
    rows[0]?.updatedAt ?? QUICK_BUTTONS_UNSET_UPDATED_AT,
  );
}

/** 读学生快捷按钮（无行 → 契约默认四项 + 未设置锚点；墓碑 → 空组；不写库） */
export function getStudentQuickButtons(
  db: Db,
  studentId: string,
): StudentQuickButtonsData {
  const rows = db
    .select()
    .from(aiQuickButtons)
    .where(eq(aiQuickButtons.studentId, studentId))
    .orderBy(asc(aiQuickButtons.orderIndex))
    .all();
  if (rows.length === 0) {
    return {
      buttons: DEFAULT_QUICK_BUTTONS.map((button) => ({ ...button })),
      updatedAt: QUICK_BUTTONS_UNSET_UPDATED_AT,
    };
  }
  const tombstone = tombstoneId(studentId);
  return {
    buttons: rows
      .filter((row) => row.id !== tombstone && row.orderIndex >= 0)
      .map((row) => projectRow(studentId, row)),
    updatedAt: currentAnchor(rows),
  };
}

/** 整组替换（含空组 = 删光，合法）：事务内删全部旧行再写新组（或墓碑） */
export function putStudentQuickButtons(
  db: Db,
  studentId: string,
  body: StudentQuickButtonsPutRequest,
): StudentQuickButtonsData {
  return db.transaction(() => {
    const rows = db
      .select()
      .from(aiQuickButtons)
      .where(eq(aiQuickButtons.studentId, studentId))
      .all();
    const anchor = currentAnchor(rows);
    if (body.baseUpdatedAt !== undefined && body.baseUpdatedAt !== anchor) {
      throw new HttpError(
        409,
        "AI_SETTINGS_STALE",
        "快捷按钮已在其他设备修改，请刷新后重试",
      );
    }
    const updatedAt = nextTimestamp(anchor);
    db.delete(aiQuickButtons)
      .where(eq(aiQuickButtons.studentId, studentId))
      .run();
    if (body.buttons.length === 0) {
      // 空组墓碑：name/prompt NOT NULL 以空串占位，不进入任何投影
      db.insert(aiQuickButtons)
        .values({
          id: tombstoneId(studentId),
          studentId,
          name: "",
          prompt: "",
          orderIndex: -1,
          enabled: false,
          attachmentPref: "{}",
          updatedAt,
        })
        .run();
      return { buttons: [], updatedAt };
    }
    db.insert(aiQuickButtons)
      .values(
        body.buttons.map((button) => ({
          id: rowId(studentId, button.id),
          studentId,
          name: button.name,
          prompt: button.prompt,
          orderIndex: button.orderIndex,
          enabled: button.enabled,
          attachmentPref: JSON.stringify(button.attachmentPref),
          updatedAt,
        })),
      )
      .run();
    const buttons = [...body.buttons].sort(
      (a, b) => a.orderIndex - b.orderIndex,
    );
    return { buttons, updatedAt };
  });
}
