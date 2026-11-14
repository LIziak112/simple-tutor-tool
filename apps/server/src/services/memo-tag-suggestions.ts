import { MEMO_TAGS_MAX } from "@tutor/contract";
import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { memos } from "../db/schema";

/** 跨全部分页聚合本人仍存在的标签，不暴露频次或其他学习者的数据。 */
export function memoTagSuggestions(db: Db, studentId: string): string[] {
  return db
    .all<{ tag: string }>(sql`
    select tags.value as tag from ${memos}, json_each(${memos.tagsJson}) as tags
    where ${memos.studentId} = ${studentId} and ${memos.deletedAt} is null
    group by tags.value order by count(*) desc, tags.value asc limit ${MEMO_TAGS_MAX}
  `)
    .map((row) => row.tag);
}
