import {
  type MutateOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AuthCancelledError,
  type AuthOperation,
  type AuthRole,
  createAuthOperation,
} from "./auth-operation";
export interface AuthConfirmation {
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  confirm(action: () => void): boolean;
}
type Options<Data, Variables> = Omit<
  MutateOptions<Data, Error, Variables>,
  "onSuccess"
> & {
  onSuccess?: (
    data: Data,
    variables: Variables,
    confirmation: AuthConfirmation,
  ) => unknown;
};
interface Input<Data, Variables> {
  value: Variables;
  operation: AuthOperation;
  rpc: (value: Variables) => Promise<Data>;
  complete: (data: Data, operation: AuthOperation) => Promise<AuthOperation>;
}
/** RPC、身份应用与成功消费属于同一意图；旧回调不读取hook最新操作或端口。 */
export function useAccountMutation<Data, Variables = void>(
  rpc: (input: Variables) => Promise<Data>,
  complete: (data: Data, operation: AuthOperation) => Promise<AuthOperation>,
  initialRoles: readonly AuthRole[] = ["student", "teacher"],
) {
  const cache = useQueryClient();
  const current = useRef<AuthOperation | null>(null);
  const [lateError, setLateError] = useState<Error | null>(null);
  useEffect(() => () => current.current?.finish(), []);
  const mutation = useMutation<Data, Error, Input<Data, Variables>>({
    mutationFn: async (input) => {
      const operation = input.operation;
      try {
        let data: Data;
        try {
          data = await input.rpc(input.value);
        } catch (error) {
          if (!operation.isCurrent()) throw new AuthCancelledError();
          throw error;
        }
        await input.complete(data, operation);
        if (!operation.consumed) operation.assertCurrent();
        return data;
      } catch (error) {
        operation.finish();
        throw error;
      }
    },
  });
  const check = useCallback(
    (operation: AuthOperation, action: () => void, consume: boolean) => {
      try {
        if (consume) operation.consume(action);
        else {
          operation.assertCurrent();
          action();
        }
        return true;
      } catch (error) {
        if (!(error instanceof AuthCancelledError)) throw error;
        operation.finish();
        if (current.current === operation) setLateError(error);
        return false;
      }
    },
    [],
  );
  const begin = (value: Variables): Input<Data, Variables> => {
    current.current?.finish();
    const operation = createAuthOperation(cache);
    operation.select(initialRoles);
    current.current = operation;
    setLateError(null);
    return { value, operation, rpc, complete };
  };
  const callbacks = (
    input: Input<Data, Variables>,
    options?: Options<Data, Variables>,
  ): MutateOptions<Data, Error, Input<Data, Variables>> => {
    const confirmation: AuthConfirmation = {
      signal: input.operation.signal,
      isCurrent: input.operation.isCurrent,
      confirm: (action) => check(input.operation, action, true),
    };
    return {
      onSuccess: (data) => {
        check(
          input.operation,
          () => options?.onSuccess?.(data, input.value, confirmation),
          false,
        );
      },
      onError: (error, _variables, onMutateResult, context) =>
        options?.onError?.(error, input.value, onMutateResult, context),
      onSettled: (data, error, _variables, onMutateResult, context) =>
        options?.onSettled?.(data, error, input.value, onMutateResult, context),
    };
  };
  const mutate = (value: Variables, options?: Options<Data, Variables>) => {
    const input = begin(value);
    mutation.mutate(input, callbacks(input, options));
  };
  const mutateAsync = async (
    value: Variables,
    options?: Options<Data, Variables>,
  ) => {
    const input = begin(value);
    const data = await mutation.mutateAsync(input, callbacks(input, options));
    if (!input.operation.consumed) input.operation.assertCurrent();
    return data;
  };
  const valid = current.current?.isCurrent() ?? true;
  const error =
    lateError ??
    mutation.error ??
    (mutation.isSuccess && !valid ? new AuthCancelledError() : null);
  const shared = {
    ...mutation,
    variables: mutation.variables?.value,
    mutate,
    mutateAsync,
    reset: () => {
      current.current?.finish();
      current.current = null;
      setLateError(null);
      mutation.reset();
    },
  };
  return error !== null
    ? {
        ...shared,
        status: "error" as const,
        error,
        isError: true as const,
        isSuccess: false as const,
      }
    : {
        ...shared,
        error: null,
        isError: false as const,
        isSuccess: mutation.isSuccess && valid,
      };
}
