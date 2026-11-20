import type { StudentLectureDetail } from "@tutor/contract";
import { useCallback, useEffect, useRef } from "react";
import { useLocation } from "react-router";
import { LECTURE_HEADING_SELECTOR } from "@/features/markdown/use-lecture-section-focus";
import { useNoteSessionRef } from "@/features/notes/use-note-head";

const INTERACTIONS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

function entryState(): {
  key?: string;
  ownClassLectureSection?: unknown;
} | null {
  try {
    const state: unknown = window.history.state;
    return state && typeof state === "object" ? state : {};
  } catch {
    return null;
  }
}

function savedSection(value: unknown, scope: string): number | null {
  return value &&
    typeof value === "object" &&
    "scope" in value &&
    value.scope === scope &&
    "index" in value &&
    typeof value.index === "number" &&
    Number.isSafeInteger(value.index) &&
    value.index >= 0
    ? value.index
    : null;
}

/** 位置存在当前浏览器历史条目中，刷新可用；新导航从讲义开头读起。 */
export function useLectureReadingPosition(
  lecture: StudentLectureDetail | undefined,
  onRestore: (index: number) => void,
) {
  const { key } = useLocation();
  const session = useNoteSessionRef();
  const scope =
    session && lecture?.kind === "lecture" && lecture.markdown !== null
      ? JSON.stringify([
          session.studentId,
          lecture.courseId,
          lecture.id,
          lecture.updatedAt,
        ])
      : null;
  const interrupted = useRef<string | null>(null);
  const restoring = useRef(false);

  useEffect(() => {
    const interrupt = () => {
      interrupted.current = key;
    };
    for (const event of INTERACTIONS) {
      window.addEventListener(event, interrupt, {
        capture: true,
        passive: true,
      });
    }
    return () => {
      for (const event of INTERACTIONS) {
        window.removeEventListener(event, interrupt, true);
      }
    };
  }, [key]);

  useEffect(() => {
    if (!scope || interrupted.current === key) return;
    const [navigation] = performance.getEntriesByType("navigation");
    if (
      !navigation ||
      !("type" in navigation) ||
      navigation.type !== "reload" ||
      navigation.name !== window.location.href.split("#")[0]
    )
      return;
    const state = entryState();
    if (state === null || (state.key ?? "default") !== key) return;
    const index = savedSection(state.ownClassLectureSection, scope);
    if (index === null) return;

    // 等正文和工具栏完成布局，再定位。此间首屏章节观察不得覆盖旧位置。
    restoring.current = true;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        restoring.current = false;
        if (interrupted.current === key || window.scrollY !== 0) return;
        const target = document.querySelectorAll<HTMLElement>(
          LECTURE_HEADING_SELECTOR,
        )[index];
        if (!target) return;
        target.scrollIntoView({ block: "start", behavior: "instant" });
        onRestore(index);
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      restoring.current = false;
    };
  }, [key, scope, onRestore]);

  return useCallback(
    (headingIndex: number, fromOutline = false) => {
      if (!scope || (restoring.current && !fromOutline)) return;
      const state = entryState();
      if (state === null || (state.key ?? "default") !== key) return;
      const index = window.scrollY === 0 && !fromOutline ? null : headingIndex;
      if (savedSection(state.ownClassLectureSection, scope) === index) return;
      try {
        window.history.replaceState(
          { ...state, ownClassLectureSection: { scope, index } },
          "",
        );
      } catch {
        // 浏览器拒绝写入历史时，仍可直接阅读和跳章。
      }
    },
    [key, scope],
  );
}
