import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBackfills } from "./backfill";
import { createDb, createDbFromBuffer, type Db } from "./client";
import { resolveMigrationsFolder, runMigrations } from "./migrate";
import { lectures, teachers, units } from "./schema";

/**
 * createTestDb 种入的教师行（T2B.1）：固定 id/createdAt，loginName='teacher'、
 * isAdmin=true——与生产「存量教师经回填升级后的形态」一致；passwordHash 为 null
 * （路由测试走 setup 时会复用本行写入密码，与生产行为相同）。
 * 服务层测试可直接引用本 id 断言归属列。
 */
export const TEST_TEACHER_ID = "teacher-test-0000";

/**
 * 测试数据库工厂（模板克隆）：首次调用惰性构建一次「模板库」——内存库跑全部迁移
 * + D23 数据搬迁 + 种入教师（与生产启动流程一致：runMigrations 之后执行
 * runBackfills，见 src/index.ts；T2B.1 起种入教师，生产中任何内容创建都发生在
 * 教师 setup 之后，服务层测试直接调创建入口时同样要有教师行可归属——T2B.5 起
 * 各创建入口的 teacherId 形参直接引用本 id），`serialize()` 成字节后仅保留字节、
 * 关闭模板连接。之后每次调用从模板字节克隆出全新独立实例，互不干扰；
 * 用完可 db.$client.close() 释放，不关也会随进程退出回收。
 *
 * 动机：全量迁移+回填每次上百毫秒，本仓库测试高频建库（重测试文件单文件数十次），
 * 是 node 项目单测的主要耗时；模板克隆把单次建库降到亚毫秒级（50 次基准记录见
 * c5f63800 提交）。需要「未迁移空库 / 截断迁移目录 / 旧结构」的测试不走本工厂
 * （模板已是最终结构）：直接组合 createDb + migrate/makeMigrationsFolderUpTo 原语，
 * 见 backfill.test、migrate*.test 的既有惯例。
 */
let templateBuffer: Buffer | undefined;

function buildTemplateBuffer(): Buffer {
  const template = createDb(":memory:");
  try {
    runMigrations(template);
    runBackfills(template);
    template
      .insert(teachers)
      .values({
        id: TEST_TEACHER_ID,
        loginName: "teacher",
        isAdmin: true,
        disabledAt: null,
        passwordHash: null,
        apiToken: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      })
      .run();
    return template.$client.serialize();
  } finally {
    template.$client.close();
  }
}

export function createTestDb(): Db {
  templateBuffer ??= buildTemplateBuffer();
  return createDbFromBuffer(templateBuffer);
}

/** 测试用临时数据目录（T2.8 起笔迹文件落 DATA_DIR/blobs/ink/…；mkdtemp 每次全新） */
export function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), "tutor-ink-test-"));
}

/**
 * 种一篇讲练页（kind='lesson' 讲义 + 其嵌入单元），返回两个 id。
 * 「讲练页一件事」相关用例共用：嵌入单元随讲练页隐藏/不计数的判定散布在资源库、
 * 课程目录与计数、学生端目录，各测试不必各写一份造数。
 */
export function seedLessonWithEmbeddedUnit(
  db: Db,
  options: {
    teacherId?: string | undefined;
    folderId?: string | null | undefined;
    lectureOrder?: number | undefined;
    unitOrder?: number | undefined;
    lectureTitle?: string | undefined;
    unitTitle?: string | undefined;
    unitId?: string | undefined;
  } = {},
): { lectureId: string; unitId: string } {
  const lectureId = crypto.randomUUID();
  const unitId = options.unitId ?? crypto.randomUUID();
  const lectureTitle = options.lectureTitle ?? "讲练 数轴热身";
  const updatedAt = new Date().toISOString();
  db.insert(lectures)
    .values({
      id: lectureId,
      teacherId: options.teacherId ?? TEST_TEACHER_ID,
      courseId: null,
      folderId: options.folderId ?? null,
      title: lectureTitle,
      markdown: `# ${lectureTitle}`,
      kind: "lesson",
      order: options.lectureOrder ?? 0,
      updatedAt,
    })
    .run();
  db.insert(units)
    .values({
      id: unitId,
      teacherId: options.teacherId ?? TEST_TEACHER_ID,
      courseId: null,
      folderId: options.folderId ?? null,
      lectureId,
      title: options.unitTitle ?? "随堂讲练",
      order: options.unitOrder ?? 0,
      updatedAt,
    })
    .run();
  return { lectureId, unitId };
}

/**
 * v1 旧格式片段（无 frontmatter，题号行 + 题型标记 + ANSWER 注释）：
 * v1 兼容层移除（架构文档 §10 决策 10）后用于「旧格式被拒」口径的服务层/路由层回归测试，
 * 服务层与路由层共享同一份，避免双副本漂移。
 */
export const V1_LEGACY_MD =
  "#### 题 1（★）\n【题型】判断\n判断：1+1=2。\n\n<!-- ANSWER: 正确 -->\n";

/**
 * 用真实迁移目录的前半段（0000 至 lastTag）拼出截断版迁移目录
 * （自 backfill.test.ts 提升共享：模拟「某历史边界之前的存量库」的既有惯例，
 * journal 天然只到边界，随后 runMigrations 只补边界后的迁移）。
 */
export function makeMigrationsFolderUpTo(lastTag: string): string {
  const src = resolveMigrationsFolder();
  const journal: {
    version: string;
    dialect: string;
    entries: { tag: string }[];
  } = JSON.parse(readFileSync(join(src, "meta", "_journal.json"), "utf8"));
  const kept: { tag: string }[] = [];
  for (const entry of journal.entries) {
    kept.push(entry);
    if (entry.tag === lastTag) break;
  }
  if (kept.at(-1)?.tag !== lastTag) {
    throw new Error(`迁移目录中未找到边界 ${lastTag}`);
  }
  const tmp = mkdtempSync(join(tmpdir(), "tutor-migrations-prefix-"));
  mkdirSync(join(tmp, "meta"), { recursive: true });
  writeFileSync(
    join(tmp, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries: kept }),
  );
  for (const entry of kept) {
    copyFileSync(join(src, `${entry.tag}.sql`), join(tmp, `${entry.tag}.sql`));
  }
  return tmp;
}
