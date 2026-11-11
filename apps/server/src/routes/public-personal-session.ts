import { personalSessionActionSchema } from "@tutor/contract";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import {
  logoutPersonalSession,
  readPersonalSessionPair,
} from "../auth/personal-session-service";
import {
  STUDENT_SESSION_COOKIE,
  sessionCookieOptions,
  TEACHER_SESSION_COOKIE,
} from "../auth/session";
import type { Db } from "../db/client";
import { parseJsonBody } from "../lib/http-error";

const COOKIE_NAMES = {
  teacher: TEACHER_SESSION_COOKIE,
  student: STUDENT_SESSION_COOKIE,
};

function sessionTokens(c: Context) {
  return {
    teacher: getCookie(c, COOKIE_NAMES.teacher),
    student: getCookie(c, COOKIE_NAMES.student),
  };
}

export function createPublicPersonalSessionRoutes(db: Db, secure: boolean) {
  return new Hono()
    .post("/check", async (c) => {
      c.header("Cache-Control", "no-store");
      const { role } = await parseJsonBody(c, personalSessionActionSchema);
      const data = readPersonalSessionPair(db, sessionTokens(c), role);
      return c.json({ ok: true, data });
    })
    .post("/logout", async (c) => {
      c.header("Cache-Control", "no-store");
      const { role } = await parseJsonBody(c, personalSessionActionSchema);
      const paired = logoutPersonalSession(db, sessionTokens(c), role);
      deleteCookie(c, COOKIE_NAMES[role], sessionCookieOptions(secure));
      if (paired) {
        deleteCookie(
          c,
          COOKIE_NAMES[role === "teacher" ? "student" : "teacher"],
          sessionCookieOptions(secure),
        );
      }
      return c.json({ ok: true, data: { paired } });
    });
}
