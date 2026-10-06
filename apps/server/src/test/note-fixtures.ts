import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { NoteDoc } from "@tutor/contract";
import type { Db } from "../db/client.ts";
import { students as studentsTable } from "../db/schema.ts";
import { TEST_TEACHER_ID } from "../db/test-utils.ts";

/**
 * 题目草稿（T6R.4/T6R.5）测试共享夹具（复审⑫收敛）：
 * - noteDoc：最小合法 NoteDoc（n 笔，y 可区分不同稿）；
 * - gzipJson：gzip 打包任意 JSON（NoteDocInput 直传通道）；
 * - makeNotePng：最小合法 PNG（魔数 + IHDR，padding 撑大小）；
 * - makeStudent：直插学生行（归属测试教师；服务层测试用）。
 * 服务层测试（note-service.test）与路由测试（student-notes/student-note-read/
 * teacher-notes.test）共用，避免多份漂移。
 */

/** 最小合法 NoteDoc（strokes 笔，每笔 2 点，y 可区分不同稿） */
export function noteDoc(strokes = 1, y = 20): NoteDoc {
  return {
    version: 1,
    ink: {
      width: 1000,
      strokes: Array.from({ length: strokes }, (_, i) => ({
        tool: "pen" as const,
        color: "#1f2328",
        weight: 4,
        points: [
          { x: 10 + i, y, p: 0.5, t: 0 },
          { x: 30 + i, y: y + 5, p: 0.8, t: 25 },
        ],
      })),
    },
    paperHeightLogical: 800,
    background: "grid",
  };
}

/** gzip 打包任意 JSON 值（正文直传通道；level 可注入用于幂等/压缩无关测试） */
export function gzipJson(value: unknown, level?: number): Uint8Array {
  const raw = Buffer.from(JSON.stringify(value), "utf8");
  return new Uint8Array(
    level === undefined ? gzipSync(raw) : gzipSync(raw, { level }),
  );
}

/**
 * 最小合法 PNG（魔数 + IHDR 声明宽高；服务端校验魔数/IHDR/尺寸声明一致，
 * 不解码像素数据）。padding 可撑大文件测字节限额。
 */
export function makeNotePng(
  width = 320,
  height = 200,
  padding = 0,
): Uint8Array {
  const buf = Buffer.alloc(64 + padding);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "latin1");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return new Uint8Array(buf);
}

let studentSeq = 0;

/** 直插学生行（归属测试教师；requireUsableAttempt 只需 studentId 匹配） */
export function makeStudent(db: Db): string {
  const id = randomUUID();
  studentSeq += 1;
  db.insert(studentsTable)
    .values({
      id,
      teacherId: TEST_TEACHER_ID,
      displayName: `学生${studentSeq}`,
      loginName: `stu-${id.slice(0, 8)}`,
      passwordHash: null,
      linkToken: `link-${id}`,
      linkEnabled: true,
      passwordEnabled: false,
      note: null,
      archivedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    .run();
  return id;
}
