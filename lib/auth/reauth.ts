/**
 * The one piece of vocabulary shared between `proxy.ts` and the server-only session DAL.
 *
 * Deliberately its own module with NO imports: `proxy.ts` runs before the cache and may be
 * deployed to the edge, so it must not reach into `lib/dal/session.ts` (which is `server-only`
 * and opens a database connection) or anything that transitively does.
 *
 * A literal `"reauth"` written in both files would be a contract maintained by coincidence, and
 * the failure mode when it drifts is an infinite redirect loop rather than a type error.
 */
export const REAUTH_PARAM = "reauth";

/** Where the server sends someone whose session cookie exists but no longer resolves. */
export const SIGN_IN_REAUTH = `/sign-in?${REAUTH_PARAM}=1`;
