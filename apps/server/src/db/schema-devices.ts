import type { DeviceRegister } from "@tutor/contract";
import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

/** 账号内的随机设备标识。合并保留别名，旧浏览器再次请求仍落到同一设备。 */
export const devices = sqliteTable(
  "devices",
  {
    subjectType: text("subject_type").$type<"student" | "teacher">().notNull(),
    subjectId: text("subject_id").notNull(),
    deviceId: text("device_id").notNull(),
    type: text("type").$type<DeviceRegister["type"]>().notNull(),
    os: text("os"),
    browser: text("browser"),
    standalone: integer("standalone", { mode: "boolean" })
      .notNull()
      .default(false),
    automaticName: text("automatic_name").notNull(),
    name: text("name"),
    firstSeenAt: text("first_seen_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    mergedIntoId: text("merged_into_id"),
  },
  (t) => [primaryKey({ columns: [t.subjectType, t.subjectId, t.deviceId] })],
);
