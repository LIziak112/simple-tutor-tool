import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  PersonalSessionRole,
  StudentMeData,
  TeacherInfo,
} from "@tutor/contract";
import type { ComponentProps } from "react";
import { useNavigate } from "react-router";
import { ApiError } from "@/lib/api";
import { checkPersonalSessionApi } from "./personal-api";
import { studentMeKey } from "./student-auth";
import { teacherMeKey, useApplyPersonalAuthed } from "./teacher-auth";

type Props = Omit<ComponentProps<"button">, "onClick" | "disabled" | "type"> & {
  from: PersonalSessionRole;
  to: string;
};

export function PersonalViewButton({ from, to, ...props }: Props) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const applyAuthed = useApplyPersonalAuthed();
  const check = useMutation({
    mutationFn: () => checkPersonalSessionApi(from),
    onSuccess: async (session) => {
      if (session === null) {
        navigate("/p/login");
        return;
      }
      if (
        client.getQueryData<TeacherInfo>(teacherMeKey)?.id !==
          session.teacher.id ||
        client.getQueryData<StudentMeData>(studentMeKey)?.id !==
          session.student.id
      ) {
        await applyAuthed(session);
      }
      navigate(to);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === "UNAUTHORIZED") {
        navigate("/p/login");
      }
    },
  });
  return (
    <>
      <button
        {...props}
        type="button"
        disabled={check.isPending}
        aria-busy={check.isPending}
        onClick={() => check.mutate()}
      />
      {check.isError && (
        <span role="alert" className="text-sm text-destructive">
          {check.error.message}
        </span>
      )}
    </>
  );
}
