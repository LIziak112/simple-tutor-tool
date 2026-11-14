import type { QueryClient } from "@tanstack/react-query";
import type { SubjectScope } from "./subject-scope";

/** 从唯一me缓存同步撤销旧主体，先于React重绘；同ID正常刷新不换普通租约。 */
export function watchSubjectIdentity(
  cache: QueryClient,
  scope: SubjectScope,
  onClosed: () => void = () => {},
) {
  const identity = scope.subject;
  const idOf = (role: "student" | "teacher") =>
    cache.getQueryData<{ id: string }>([role, "me"])?.id ?? "unconfirmed";
  const check = () => {
    if (scope.signal.aborted) return;
    if (
      idOf(identity.type) !== identity.id ||
      (identity.portal === "personal" &&
        idOf(identity.type === "student" ? "teacher" : "student") !==
          (identity.pairedSubjectId ?? "unconfirmed"))
    ) {
      scope.close();
      onClosed();
    }
  };
  const unsubscribe = cache.getQueryCache().subscribe((event) => {
    const key = event.query.queryKey;
    if (
      key.length === 2 &&
      key[1] === "me" &&
      (event.type === "removed" || event.type === "updated")
    )
      check();
  });
  check();
  return unsubscribe;
}
