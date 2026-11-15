import { createSubjectScope } from "../subject-scope";
import { createHttpRuntime } from "./http-runtime";
import { createClientServices } from "./services";

/** 外层旧页面兼容实例；L2不得引用此出口，已确认主体使用独立租约创建自己的实例。 */
const legacy = createSubjectScope(
  { type: "student", id: "legacy-host" },
  (input, init) => globalThis.fetch(input, init),
);
export const defaultClientServices = createClientServices(
  createHttpRuntime(legacy),
);
