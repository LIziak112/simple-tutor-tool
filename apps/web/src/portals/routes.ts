import type { PortalId, PortalRoutes } from "@/features/runtime/portal-runtime";
import { PORTALS } from "./registry";
/** 路由前缀只由宿主决定；业务坐标/筛选与hash原样保留，不通过replace猜身份。 */
export function createPortalRoutes(portal: PortalId): PortalRoutes {
  const learn = portal === "personal" ? "/p/learn" : "/s";
  const manage = portal === "personal" ? "/p/manage" : "/t";
  const join = (base: string, path: string) =>
    path === "" ? base : `${base}/${path.replace(/^\//, "")}`;
  return Object.freeze({
    learning: (path: string) => join(learn, path),
    management: (path: string) => join(manage, path),
    portal: (id: PortalId) => PORTALS[id],
    all: PORTALS,
    learningPattern: (suffix: string, flags?: string) =>
      new RegExp(
        "^" + learn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/" + suffix,
        flags,
      ),
    isLearningPath: (path: string) =>
      path === learn || path.startsWith(learn + "/"),
    isManagementPath: (path: string) =>
      path === manage || path.startsWith(manage + "/"),
  });
}
