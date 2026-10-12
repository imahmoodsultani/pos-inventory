/**
 * Better Auth handler (T026).
 *
 * `toNextJsHandler` returns the GET and POST handlers for every auth endpoint — sign-in,
 * sign-out, session, and so on — mounted under /api/auth/*.
 */

import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth/config";

export const { GET, POST } = toNextJsHandler(auth);
