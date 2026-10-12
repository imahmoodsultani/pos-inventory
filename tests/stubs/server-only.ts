// `server-only` throws by design when imported outside a React Server Component graph.
// Vitest has no such graph, so the real module would fail every DAL test at import time.
// The import still does its job where it matters: Next.js resolves the real package during
// `next build`, so a client component importing the DAL remains a build error.
export {};
