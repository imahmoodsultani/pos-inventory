/**
 * proxy.ts — NOT middleware.ts (T028).
 *
 * Next.js 16 renamed the `middleware` file convention to `proxy`. A file named middleware.ts
 * here would simply never run, and the failure is silent: pages render, nothing redirects, and
 * it looks like the matcher is wrong.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────
 * THIS IS NOT THE SECURITY BOUNDARY. It is an optimistic redirect, nothing more.
 *
 * It only checks whether a session COOKIE EXISTS. It does not validate the cookie, look up the
 * session, or check a role — proxy runs before the cache, may be deployed to the CDN, and must
 * not depend on shared modules or hit the database.
 *
 * Anyone can forge a cookie with the right name and get past this. That is fine, because the
 * real enforcement is `verifySession()` / `requireRole()` in the server-only DAL, re-checked
 * inside every Server Action. If this file were deleted, the app would still be secure — just
 * slightly less pleasant, since signed-out users would reach a page that then redirects.
 * ──────────────────────────────────────────────────────────────────────────────────────────
 */

import { getSessionCookie } from "better-auth/cookies";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { REAUTH_PARAM } from "@/lib/auth/reauth";

export function proxy(request: NextRequest): NextResponse {
  const hasSessionCookie = getSessionCookie(request);
  const { pathname, search } = request.nextUrl;
  const isSignIn = pathname.startsWith("/sign-in");

  if (!hasSessionCookie && !isSignIn) {
    const signIn = new URL("/sign-in", request.url);
    // Preserve where they were going so sign-in can send them back.
    signIn.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(signIn);
  }

  // Bouncing a signed-in visitor off the sign-in form is a convenience. It must NOT override the
  // server having already established that this cookie is dead — only the server can know that,
  // since this file is forbidden from touching the database. Without the `reauth` exemption the
  // two redirects fight: page → /sign-in, proxy → /, forever.
  const isReauth = request.nextUrl.searchParams.has(REAUTH_PARAM);
  if (hasSessionCookie && isSignIn && !isReauth) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return NextResponse.next();
}

export const config = {
  /**
   * Everything except Next internals, static assets, and ALL of `/api`.
   *
   * `/api` is excluded wholesale, not just `/api/auth`:
   *
   *   - redirecting `/api/auth/*` would make signing in impossible; and
   *   - `/api/cron/*` authenticates with a `Bearer CRON_SECRET` header and has no session
   *     cookie, so this proxy would bounce every invocation to /sign-in. The job would return
   *     307 forever, the nightly invariant check would never run, and nothing would report it —
   *     the failure is completely silent. (Found by curling the route; it answered with a
   *     redirect to /sign-in.)
   *
   * This is safe because the proxy was never the security boundary: route handlers authenticate
   * themselves, and Server Actions re-check through the server-only DAL.
   */
  matcher: ["/((?!api/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
