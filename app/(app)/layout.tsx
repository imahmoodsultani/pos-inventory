import Link from "next/link";
import { redirect } from "next/navigation";

import { SIGN_IN_REAUTH } from "@/lib/auth/reauth";
import { getSession } from "@/lib/dal/session";
import { SignOutButton } from "./sign-out-button";

/**
 * The authenticated shell (T036).
 *
 * ⚠️ The redirect below is PRESENTATION, not security. Layouts do not re-render on client-side
 * navigation, so this check runs once per full page load and then never again — and Server
 * Actions are reachable by POST without rendering any layout at all.
 *
 * Every Server Action re-checks with verifySession()/requireRole(). Treat this purely as "don't
 * render a shell full of empty panels to someone who is signed out".
 */
/**
 * Cache Components prerenders routes by default, and reading the session reads `headers()`,
 * which cannot be part of a static shell. Next.js offers three ways out: stream behind
 * <Suspense>, cache the read, or block.
 *
 * Caching is off the table — CLAUDE.md forbids `'use cache'` on anything transactional, and
 * `'use cache: private'` is reserved for identity reads that do not gate access. Streaming the
 * shell is pointless here because EVERY route under this layout is per-user and gated: there is
 * no useful static version of a till or a capital ledger to show first.
 *
 * So this segment blocks on the server, deliberately. Revisit alongside T070a if the checkout
 * p95 budget comes under pressure.
 */
export const instant = false;

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await getSession();
  // SIGN_IN_REAUTH, not a bare "/sign-in": this redirect RACES the page's own session read, and
  // whichever lands first is what the browser follows. A bare path here loses the marker that
  // stops proxy.ts bouncing it straight back, so the loop returns through the layout.
  if (!user) redirect(SIGN_IN_REAUTH);

  const isOwner = user.role === "owner";

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="flex items-center gap-6 border-b px-4 py-3">
        <Link href="/" className="font-semibold tracking-tight">
          POS
        </Link>
        <nav className="flex flex-1 items-center gap-4 text-sm">
          <Link href="/till" className="hover:underline">
            Till
          </Link>
          {isOwner ? (
            <>
              <Link href="/inventory" className="hover:underline">
                Catalogue
              </Link>
              <Link href="/receiving" className="hover:underline">
                Receiving
              </Link>
              <Link href="/inventory/stock" className="hover:underline">
                Stock
              </Link>
              <Link href="/inventory/count" className="hover:underline">
                Count
              </Link>
              <Link href="/capital" className="hover:underline">
                Capital
              </Link>
              <Link href="/summary" className="hover:underline">
                Summary
              </Link>
              <Link href="/reports/margin" className="hover:underline">
                Margin
              </Link>
              <Link href="/inventory/reconciliation" className="hover:underline">
                Reconcile
              </Link>
              <Link href="/settings/users" className="hover:underline">
                Staff
              </Link>
            </>
          ) : null}
        </nav>
        <div className="text-muted-foreground flex items-center gap-3 text-sm">
          <span>
            {user.name} · {user.role}
          </span>
          <SignOutButton />
        </div>
      </header>
      <main className="flex-1 p-4">{children}</main>
    </div>
  );
}
