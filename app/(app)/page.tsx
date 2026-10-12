import Link from "next/link";
import { verifySession } from "@/lib/dal/session";


/**
 * Per-user and gated: every read here depends on who is asking, so there is no static shell to
 * prerender. Caching is forbidden on transactional data (CLAUDE.md), and `instant = false` on
 * the layout does not cover a page's own session read during client-side navigation.
 */
export const instant = false;
/**
 * Landing page. Deliberately not a bare redirect: an owner's first stop differs by time of day,
 * and a salesperson only ever needs the till.
 *
 * SC-008 — an untrained owner must be able to reach their first recorded sale unaided, so each
 * card names the next action rather than showing an empty table. T107 extends this to the
 * individual screens.
 */
export default async function HomePage() {
  const user = await verifySession();
  const isOwner = user.role === "owner";

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Good to see you, {user.name.split(" ")[0]}
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {isOwner
            ? "Record a sale, receive new stock, or check where the money is."
            : "Record a sale at the till."}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Card
          href="/till"
          title="Record a sale"
          body="Pick the batch each item comes from, set the price, and take payment."
        />
        {isOwner ? (
          <>
            <Card
              href="/inventory"
              title="Set up the catalogue"
              body="Products, vendors and quality grades — needed before stock can be received."
            />
            <Card
              href="/receiving"
              title="Receive stock"
              body="Log a delivery as its own batch, with its vendor, quality, and cost."
            />
            <Card
              href="/inventory/stock"
              title="Stock on hand"
              body="What is left, batch by batch, with vendor and unit cost."
            />
            <Card
              href="/summary"
              title="Business summary"
              body="Profit to date, capital invested, capital recovered, cash, and inventory."
            />
          </>
        ) : null}
      </div>
    </div>
  );
}

function Card({ href, title, body }: { href: string; title: string; body: string }) {
  return (
    <Link
      href={href}
      className="hover:bg-accent rounded-lg border p-4 transition-colors"
    >
      <h2 className="font-medium">{title}</h2>
      <p className="text-muted-foreground mt-1 text-sm">{body}</p>
    </Link>
  );
}
