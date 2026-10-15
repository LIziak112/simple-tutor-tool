import type { StudentQuickButton } from "@tutor/contract";
import {
  DEFAULT_QUICK_BUTTONS,
  studentQuickButtonsPutRequestSchema,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { aiQuickButtons } from "../../db/schema.ts";
import { createTestDb } from "../../db/test-utils.ts";
import { HttpError } from "../../lib/http-error.ts";
import { makeStudent } from "../../test/note-fixtures.ts";
import {
  getStudentQuickButtons,
  putStudentQuickButtons,
} from "./quick-buttons-service.ts";

/**
 * SAI-08 学生快捷按钮服务测试（B03 批次「先测」服务层逐条）：
 * - 无配置不物化：GET 返回契约 DEFAULT_QUICK_BUTTONS 四项 + 未设置锚点，
 *   每次查询都不写行（避免每位学生四行回填，SAI-05 存储立场）；
 * - 整组替换语义：改名/改提示词/三类附件/禁用/重排往返一致；行 id 按学生
 *   命名空间存储——默认语义 id（hint-next 等）两名学生同时物化不撞全局主键；
 * - 删光持久：空组用墓碑行表示，刷新仍空、不偷偷回填默认；
 * - 版本并发（B00 规则）：baseUpdatedAt 与整组锚点不一致 → 409
 *   AI_SETTINGS_STALE，库中原列表原样保留（不部分写入）；缺省跳过检测；
 * - 整组统一时间戳且单调递增（同毫秒连续保存冲突检测不失效）；
 * - 账号隔离：A 的读写只触达 A 的行，B 始终看到自己的配置。
 */

/** 契约解析后的 PUT 体（服务只收已过契约单源校验的请求） */
function putBody(buttons: StudentQuickButton[], baseUpdatedAt?: string) {
  return studentQuickButtonsPutRequestSchema.parse(
    baseUpdatedAt === undefined ? { buttons } : { buttons, baseUpdatedAt },
  );
}

/** 单按钮速构（orderIndex 由调用方编排） */
function button(
  id: string,
  orderIndex: number,
  overrides: Partial<StudentQuickButton> = {},
): StudentQuickButton {
  return {
    id,
    name: `按钮-${id}`,
    prompt: `提示词-${id}`,
    orderIndex,
    enabled: true,
    attachmentPref: { annotation: false, draft: false, formalInk: false },
    ...overrides,
  };
}

/** 读某学生在 ai_quick_buttons 的原始行数（验证不物化/墓碑） */
function rowCount(db: ReturnType<typeof createTestDb>, studentId: string) {
  return db
    .select({ id: aiQuickButtons.id })
    .from(aiQuickButtons)
    .where(eq(aiQuickButtons.studentId, studentId))
    .all().length;
}

describe("getStudentQuickButtons（无配置不物化）", () => {
  it("无配置 → 契约默认四项 + 未设置锚点，且不写任何行", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    const data = getStudentQuickButtons(db, studentId);
    expect(data.buttons).toEqual(DEFAULT_QUICK_BUTTONS);
    expect(data.updatedAt).toBe("1970-01-01T00:00:00.000Z");
    // 再读一次仍零行：GET 不物化（SAI-05 避免四行回填立场）
    getStudentQuickButtons(db, studentId);
    expect(rowCount(db, studentId)).toBe(0);
    db.$client.close();
  });

  it("默认按钮语义 id 两名学生同时物化不撞全局主键", () => {
    const db = createTestDb();
    const a = makeStudent(db);
    const b = makeStudent(db);
    putStudentQuickButtons(db, a, putBody([...DEFAULT_QUICK_BUTTONS]));
    // 同一恢复默认操作在 B 上重复：默认语义 id（hint-next 等）不构成冲突
    putStudentQuickButtons(db, b, putBody([...DEFAULT_QUICK_BUTTONS]));
    expect(getStudentQuickButtons(db, a).buttons).toEqual(
      DEFAULT_QUICK_BUTTONS,
    );
    expect(getStudentQuickButtons(db, b).buttons).toEqual(
      DEFAULT_QUICK_BUTTONS,
    );
    db.$client.close();
  });
});

describe("putStudentQuickButtons（整组替换）", () => {
  it("添加、改名、改提示词、改附件、禁用、重排均保存并按序读回", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    const first = putStudentQuickButtons(
      db,
      studentId,
      putBody([
        button("custom-1", 0, {
          name: "我的启发",
          prompt: "给我一点提示。",
          attachmentPref: { annotation: true, draft: false, formalInk: true },
        }),
        button("custom-2", 1, { enabled: false }),
      ]),
    );
    expect(first.buttons.map((b) => b.name)).toEqual([
      "我的启发",
      "按钮-custom-2",
    ]);
    expect(first.buttons[0]?.attachmentPref).toEqual({
      annotation: true,
      draft: false,
      formalInk: true,
    });
    // 重排 + 改名：orderIndex 反映新顺序
    const second = putStudentQuickButtons(
      db,
      studentId,
      putBody(
        [button("custom-2", 0, { name: "提前" }), button("custom-1", 1)],
        first.updatedAt,
      ),
    );
    expect(second.buttons.map((b) => b.id)).toEqual(["custom-2", "custom-1"]);
    const reread = getStudentQuickButtons(db, studentId);
    expect(reread.buttons).toEqual(second.buttons);
    expect(reread.updatedAt).toBe(second.updatedAt);
    db.$client.close();
  });

  it("删光 → 墓碑行持久空组，重取不回填默认；空组后可再新增", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    const saved = putStudentQuickButtons(
      db,
      studentId,
      putBody([button("only", 0)]),
    );
    const emptied = putStudentQuickButtons(
      db,
      studentId,
      putBody([], saved.updatedAt),
    );
    expect(emptied.buttons).toEqual([]);
    // 重取仍空（墓碑行承载「已物化的空组」与版本锚点）
    expect(getStudentQuickButtons(db, studentId).buttons).toEqual([]);
    expect(rowCount(db, studentId)).toBe(1);
    // 空组后再次保存非空组：墓碑被清掉、正常读回
    const refilled = putStudentQuickButtons(
      db,
      studentId,
      putBody([button("back", 0)], emptied.updatedAt),
    );
    expect(refilled.buttons.map((b) => b.id)).toEqual(["back"]);
    expect(getStudentQuickButtons(db, studentId).buttons).toEqual(
      refilled.buttons,
    );
    db.$client.close();
  });

  it("过期版本 → 409 AI_SETTINGS_STALE，库中列表原样保留（不部分写入）", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    const saved = putStudentQuickButtons(
      db,
      studentId,
      putBody([button("keep", 0)]),
    );
    const stale = putBody([button("intruder", 0)], "2000-01-01T00:00:00.000Z");
    try {
      putStudentQuickButtons(db, studentId, stale);
      expect.unreachable("过期版本必须被拒绝");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect(error).toMatchObject({ status: 409, code: "AI_SETTINGS_STALE" });
    }
    // 409 后原组原样：内容与锚点都不变
    const after = getStudentQuickButtons(db, studentId);
    expect(after.buttons.map((b) => b.id)).toEqual(["keep"]);
    expect(after.updatedAt).toBe(saved.updatedAt);
    db.$client.close();
  });

  it("baseUpdatedAt 缺省 → 跳过冲突检测直接替换", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    putStudentQuickButtons(db, studentId, putBody([button("old", 0)]));
    const replaced = putStudentQuickButtons(
      db,
      studentId,
      putBody([button("new", 0)]),
    );
    expect(replaced.buttons.map((b) => b.id)).toEqual(["new"]);
    db.$client.close();
  });

  it("整组时间戳统一且单调递增：同毫秒连续保存锚点仍前进", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    const first = putStudentQuickButtons(
      db,
      studentId,
      putBody([button("a", 0)]),
    );
    const second = putStudentQuickButtons(
      db,
      studentId,
      putBody([button("a", 0)], first.updatedAt),
    );
    expect(second.updatedAt > first.updatedAt).toBe(true);
    // 旧锚点重放被拒（上一组锚点已过期）
    try {
      putStudentQuickButtons(
        db,
        studentId,
        putBody([button("a", 0)], first.updatedAt),
      );
      expect.unreachable("旧锚点重放必须被拒绝");
    } catch (error) {
      expect(error).toMatchObject({ status: 409, code: "AI_SETTINGS_STALE" });
    }
    db.$client.close();
  });

  it("恢复默认 = 整组显式提交契约常量：四项与顺序正确", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    const customized = putStudentQuickButtons(
      db,
      studentId,
      putBody([button("mine", 0)]),
    );
    const restored = putStudentQuickButtons(
      db,
      studentId,
      putBody([...DEFAULT_QUICK_BUTTONS], customized.updatedAt),
    );
    expect(restored.buttons).toEqual(DEFAULT_QUICK_BUTTONS);
    expect(getStudentQuickButtons(db, studentId).buttons).toEqual(
      DEFAULT_QUICK_BUTTONS,
    );
    db.$client.close();
  });

  it("A 学生无法读写 B 学生预设：B 视角始终是自己的配置", () => {
    const db = createTestDb();
    const a = makeStudent(db);
    const b = makeStudent(db);
    putStudentQuickButtons(
      db,
      a,
      putBody([button("a-only", 0, { name: "A 的按钮" })]),
    );
    expect(getStudentQuickButtons(db, b).buttons).toEqual(
      DEFAULT_QUICK_BUTTONS,
    );
    // B 的保存只写 B 的行（服务入参以会话学生为准，无客户端可传归属）
    const savedB = putStudentQuickButtons(
      db,
      b,
      putBody([button("b-only", 0)]),
    );
    expect(getStudentQuickButtons(db, a).buttons.map((x) => x.id)).toEqual([
      "a-only",
    ]);
    expect(getStudentQuickButtons(db, b).buttons).toEqual(savedB.buttons);
    db.$client.close();
  });
});
