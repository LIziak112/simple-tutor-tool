import { useQueryClient } from "@tanstack/react-query";
import type {
  PersonalSessionRole,
  StudentMeData,
  TeacherInfo,
} from "@tutor/contract";
import type { ComponentProps } from "react";
import { useNavigate } from "react-router";
import {
  usePortalClients,
  usePortalRoutes,
} from "@/features/runtime/portal-runtime";
import { ApiError } from "@/lib/api-response";

import { useAccountMutation } from "./auth-mutation";
import { studentMeKey } from "./student-auth";
import { teacherMeKey, useApplyPersonalAuthed } from "./teacher-auth";

type Props = Omit<ComponentProps<"button">, "onClick" | "disabled" | "type"> & {
  from: PersonalSessionRole;
  to: string;
  beforeAction?: (action: () => void) => void;
};

export function PersonalViewButton({
  from,
  to,
  beforeAction,
  ...props
}: Props) {
  const routes = usePortalRoutes();

  const { checkPersonalSessionApi } = usePortalClients();

  const navigate = useNavigate();
  const client = useQueryClient();
  const applyAuthed = useApplyPersonalAuthed();
  const check = useAccountMutation(
    () => checkPersonalSessionApi(from),
    async (session, operation) => {
      operation.select(["student", "teacher"]);
      if (
        session &&
        (client.getQueryData<TeacherInfo>(teacherMeKey)?.id !==
          session.teacher.id ||
          client.getQueryData<StudentMeData>(studentMeKey)?.id !==
            session.student.id)
      )
        await applyAuthed(session, operation);
      operation.assertCurrent();
      return operation;
    },
  );
  const switchView = () =>
    check.mutate(undefined, {
      onSuccess: (session, _request, confirmation) => {
        confirmation.confirm(() =>
          navigate(session === null ? routes.portal("personal").loginPath : to),
        );
      },
      onError: (error) => {
        if (error instanceof ApiError && error.code === "UNAUTHORIZED")
          navigate(routes.portal("personal").loginPath);
      },
    });
  return (
    <>
      <button
        {...props}
        type="button"
        disabled={check.isPending}
        aria-busy={check.isPending}
        onClick={() => (beforeAction ? beforeAction(switchView) : switchView())}
      />
      {check.isError && (
        <span role="alert" className="text-sm text-destructive">
          {check.error.message}
        </span>
      )}
    </>
  );
}
