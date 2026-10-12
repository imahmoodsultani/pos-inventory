import { Suspense } from "react";

import { db } from "@/lib/db";
import type { Tx } from "@/lib/db";
import { requireOwner } from "@/lib/dal/session";
import { listStaff } from "@/lib/services/users";

import { createStaffUserAction, setUserActiveAction } from "./actions";
import { StaffForm, StaffList } from "./staff-ui";

export const instant = false;

export default async function UsersPage() {
  const me = await requireOwner();

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 py-2">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Staff accounts</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          There is no public sign-up — you create every account here. Salespeople can sell and
          take returns, but never see cost, profit, capital or cash.
        </p>
      </div>

      <Suspense fallback={<p className="text-muted-foreground text-sm">Loading staff…</p>}>
        <Staff currentUserId={me.id} />
      </Suspense>
    </div>
  );
}

async function Staff({ currentUserId }: { currentUserId: string }) {
  const staff = await db.transaction((tx) => listStaff(tx as Tx));

  return (
    <>
      <StaffForm action={createStaffUserAction} />
      <StaffList
        currentUserId={currentUserId}
        setActive={setUserActiveAction}
        staff={staff.map((s) => ({
          id: s.id,
          email: s.email,
          name: s.name,
          role: s.role,
          isActive: s.isActive,
        }))}
      />
    </>
  );
}
