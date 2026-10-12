"use client";

/**
 * Browser-side auth client. Used only by the sign-in form.
 *
 * Everything else in this app determines identity on the SERVER via lib/dal/session.ts. This
 * client exists to perform the sign-in POST and nothing more — never to decide what a user may
 * do. A role read here is a hint for rendering, not a permission.
 */

import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();

export const { signIn, signOut, useSession } = authClient;
