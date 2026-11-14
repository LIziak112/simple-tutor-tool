import type { AttemptEvent, LectureEvent } from "@tutor/contract";
import { postAttemptEventsApi, postLectureEventsApi } from "./api";
import { currentDevice } from "./device-registration";
import type { EventBeacon, EventScope, EventSender } from "./event-queue";

/** scope → 上报 URL（fetch 与 sendBeacon 共用） */
function scopeUrl(scope: EventScope): string {
  return scope.kind === "attempt"
    ? `/api/student/attempts/${encodeURIComponent(scope.attemptId)}/events`
    : "/api/student/events";
}

/**
 * 生产默认发送：走 hc 类型客户端（postAttemptEventsApi / postLectureEventsApi）。
 * attempt scope 随批携带该批事件**来源会话**的 viewId（题内活动用时按会话分组
 * 识别多端重叠；离线积压补发时带积压当时的 viewId，不冒用当前页会话——审查
 * #100-01；旧版积压没存 viewId 则不带，服务端并入缺省组）。批级字段不改事件
 * 本体与字节切批口径。
 */
export function defaultSend(scope: EventScope): EventSender {
  return async (events, viewId) => {
    if (scope.kind === "attempt") {
      // scope 保证队列内全部为 attempt 事件（调用方只对 attempt scope track 这类事件）
      await postAttemptEventsApi(
        scope.attemptId,
        events as AttemptEvent[],
        viewId ?? undefined,
      );
      return;
    }
    await postLectureEventsApi(events as LectureEvent[]);
  };
}

/** 生产默认 beacon：Blob application/json（同源自动带会话 Cookie） */
export function defaultBeacon(scope: EventScope): EventBeacon {
  return (events, viewId) => {
    if (typeof navigator === "undefined" || navigator.sendBeacon === undefined)
      return false;
    const body =
      scope.kind === "attempt"
        ? { events: [...events], ...(viewId !== null ? { viewId } : {}) }
        : { events: [...events] };
    const blob = new Blob(
      [JSON.stringify({ ...body, deviceId: currentDevice().deviceId })],
      {
        type: "application/json",
      },
    );
    return navigator.sendBeacon(scopeUrl(scope), blob);
  };
}
