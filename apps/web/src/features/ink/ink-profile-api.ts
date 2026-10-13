import {
  apiResponseSchema,
  type InkProfile,
  type InkProfileUpdate,
  type InkProfileWrite,
  inkProfileListOkSchema,
  inkProfileOkSchema,
} from "@tutor/contract";
import { ApiError } from "@/lib/api";
import type { InkProfileAccount } from "./ink-profile-store";

async function request(
  role: InkProfileAccount["role"],
  path = "",
  method = "GET",
  body?: InkProfileWrite | InkProfileUpdate,
) {
  const response = await fetch(`/api/${role}/ink-profiles${path}`, {
    method,
    credentials: "include",
    ...(body
      ? {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const raw: unknown = await response.json();
  const envelope = apiResponseSchema.parse(raw);
  if (!envelope.ok)
    throw new ApiError(envelope.error, envelope.message, response.status);
  return raw;
}
export async function fetchInkProfiles(
  account: InkProfileAccount,
): Promise<InkProfile[]> {
  return inkProfileListOkSchema.parse(await request(account.role)).data
    .profiles;
}
export async function saveInkProfileApi(
  account: InkProfileAccount,
  body: InkProfileWrite,
  id?: string,
  revision?: number,
): Promise<InkProfile> {
  return inkProfileOkSchema.parse(
    await request(
      account.role,
      id ? `/${encodeURIComponent(id)}` : "",
      id ? "PUT" : "POST",
      id ? { ...body, revision: revision ?? 1 } : body,
    ),
  ).data;
}
export async function deleteInkProfileApi(
  account: InkProfileAccount,
  id: string,
) {
  await request(account.role, `/${encodeURIComponent(id)}`, "DELETE");
}
