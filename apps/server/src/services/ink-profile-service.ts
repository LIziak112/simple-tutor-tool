import { randomUUID } from "node:crypto";
import {
  INK_PROFILE_MAX_COUNT,
  type InkProfile,
  type InkProfileUpdate,
  type InkProfileWrite,
  inkProfileConfigSchema,
} from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { inkProfiles } from "../db/schema";
import { HttpError } from "../lib/http-error";
export interface InkProfileOwner {
  type: "student" | "teacher";
  id: string;
}
function scope(owner: InkProfileOwner) {
  return and(
    eq(inkProfiles.subjectType, owner.type),
    eq(inkProfiles.subjectId, owner.id),
  );
}
function project(row: typeof inkProfiles.$inferSelect): InkProfile {
  return {
    id: row.id,
    name: row.name,
    config: inkProfileConfigSchema.parse(JSON.parse(row.configJson)),
    revision: row.revision,
    updatedAt: row.updatedAt,
  };
}
export function listInkProfiles(db: Db, owner: InkProfileOwner): InkProfile[] {
  return db.select().from(inkProfiles).where(scope(owner)).all().map(project);
}
export function saveInkProfile(
  db: Db,
  owner: InkProfileOwner,
  body: InkProfileWrite | InkProfileUpdate,
  id?: string,
): InkProfile {
  return db.transaction((tx) => {
    const existing = id
      ? tx
          .select()
          .from(inkProfiles)
          .where(and(scope(owner), eq(inkProfiles.id, id)))
          .get()
      : undefined;
    if (id && !existing)
      throw new HttpError(
        404,
        "INK_PROFILE_NOT_FOUND",
        "这份配置不存在或已删除",
      );
    if (
      existing &&
      (!("revision" in body) || existing.revision !== body.revision)
    )
      throw new HttpError(
        409,
        "INK_PROFILE_CONFLICT",
        "这份配置已在其他设备修改，请重新加载或另存为新配置",
      );
    const profiles = tx
      .select()
      .from(inkProfiles)
      .where(scope(owner))
      .all()
      .map(project);
    if (profiles.some((p) => p.id !== id && p.name === body.name))
      throw new HttpError(
        409,
        "INK_PROFILE_NAME_EXISTS",
        "已有同名配置，请换一个名称",
      );
    if (!existing && profiles.length >= INK_PROFILE_MAX_COUNT)
      throw new HttpError(
        409,
        "INK_PROFILE_LIMIT",
        "最多保存 20 份配置，请先删除不再使用的配置",
      );
    const profile: InkProfile = {
      id: id ?? randomUUID(),
      name: body.name,
      config: body.config,
      revision: (existing?.revision ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    const row = {
      ...profile,
      subjectType: owner.type,
      subjectId: owner.id,
      configJson: JSON.stringify(profile.config),
    };
    if (existing)
      tx.update(inkProfiles)
        .set({
          name: profile.name,
          configJson: row.configJson,
          revision: profile.revision,
          updatedAt: profile.updatedAt,
        })
        .where(and(scope(owner), eq(inkProfiles.id, profile.id)))
        .run();
    else tx.insert(inkProfiles).values(row).run();
    return profile;
  });
}
export function deleteInkProfile(
  db: Db,
  owner: InkProfileOwner,
  id: string,
): void {
  const deleted = db
    .delete(inkProfiles)
    .where(and(scope(owner), eq(inkProfiles.id, id)))
    .returning({ id: inkProfiles.id })
    .get();
  if (!deleted)
    throw new HttpError(404, "INK_PROFILE_NOT_FOUND", "这份配置不存在或已删除");
}
