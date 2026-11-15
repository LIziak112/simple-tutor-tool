import type { InkProfile, InkProfileWrite } from "@tutor/contract";
import type { InkProfileAccount } from "@/features/ink/ink-profile-store";
export interface InkProfilesPorts {
  fetchInkProfiles(account: InkProfileAccount): Promise<InkProfile[]>;
  saveInkProfileApi(
    account: InkProfileAccount,
    body: InkProfileWrite,
    id?: string,
    revision?: number,
  ): Promise<InkProfile>;
  deleteInkProfileApi(account: InkProfileAccount, id: string): Promise<void>;
}
