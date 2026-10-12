/**
 * Task 8.2 — exercise the complete correction path against a real database.
 *
 * The integration suite proves each correction in isolation against a fresh container. This proves
 * they compose against a database that already has history in it: a vendor rename, a staff email
 * change and a capital correction applied one after another on top of existing sales, with all
 * three invariants still holding at the end.
 *
 * Run with:  npx dotenv -e .env.local -- npx tsx scripts/verify-corrections.ts
 */

import { db, type Tx } from "@/lib/db";
import { checkAllInvariants, computeIdentity } from "@/lib/dal/invariants";
import { correctCapitalEvent, recordCapitalInjection } from "@/lib/services/capital";
import { createProduct, createVendor, createQualityGrade, updateVendor } from "@/lib/services/catalogue";
import { getEditHistory } from "@/lib/services/audit";
import { receiveStock } from "@/lib/services/receiving";
import { recordSale } from "@/lib/services/sale";
import { createStaffUser, updateStaffDetails } from "@/lib/services/users";

const ACTOR = "verify-corrections";
const stamp = Date.now().toString().slice(-9);

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok  ${message}`);
}

async function invariantsHold(label: string): Promise<void> {
  const results = await checkAllInvariants(db);
  for (const result of results) {
    assert(result.holds, `${label} — ${result.name} (${result.detail})`);
  }
}

async function main(): Promise<void> {
  console.log("\n== before any corrections ==");
  await invariantsHold("baseline");
  const before = await computeIdentity(db);

  console.log("\n== set up: vendor, stock, a sale, capital ==");
  const { vendorId, batchId, capitalEventId, userId } = await db.transaction(async (txLike) => {
    const tx = txLike as Tx;

    const vendor = await createVendor(tx, ACTOR, { name: `Verify Vendor ${stamp}` });
    const product = await createProduct(tx, ACTOR, {
      code: `VERIFY-${stamp}`,
      name: "Verification Widget",
      unitOfMeasure: "piece",
      reorderLevel: 0,
    });
    const grade = await createQualityGrade(tx, ACTOR, {
      code: `V${stamp.slice(-4)}`,
      label: "Verify grade",
      sortOrder: 0,
    });

    // Fund the purchase so it cannot drive cash negative.
    const capital = await recordCapitalInjection(tx, ACTOR, {
      amountMinor: 50_000,
      occurredAt: new Date(),
    });

    const batch = await receiveStock(tx, ACTOR, {
      productId: product.productId,
      vendorId: vendor.vendorId,
      gradeId: grade.gradeId,
      qtyReceived: 10,
      goodsCostMinor: 3_000,
      landedCostMinor: 0,
      receivedAt: new Date(),
      funding: { newCapitalMinor: 3_000, reinvestedMinor: 0 },
    });

    await recordSale(tx, ACTOR, {
      paymentMethod: "cash",
      lines: [{ batchId: batch.batchId, quantity: 4, unitPriceMinor: 900 }],
    });

    const staff = await createStaffUser(tx, ACTOR, {
      email: `verify-${stamp}@example.test`,
      name: "Verify Staff",
      password: "a-long-enough-password",
      role: "salesperson",
    });

    return {
      vendorId: vendor.vendorId,
      batchId: batch.batchId,
      capitalEventId: capital.eventId,
      userId: staff.userId,
    };
  });

  await invariantsHold("after setup");

  console.log("\n== correction 1: rename the vendor, which batches reference ==");
  await db.transaction((tx) =>
    updateVendor(tx as Tx, ACTOR, { vendorId, name: `Verify Vendor ${stamp} Renamed` }),
  );
  const vendorHistory = await getEditHistory(db, "vendors", vendorId);
  assert(vendorHistory.some((h) => h.fieldName === "name"), "the rename is audited");
  await invariantsHold("after vendor rename");

  console.log("\n== correction 2: change the staff sign-in email ==");
  const staffResult = await db.transaction((tx) =>
    updateStaffDetails(tx as Tx, ACTOR, {
      userId,
      email: `verify-${stamp}-moved@example.test`,
    }),
  );
  assert(staffResult.signedOut, "changing the sign-in email ended that user's sessions");
  await invariantsHold("after email change");

  console.log("\n== correction 3: correct the capital amount 50,000 -> 5,000 ==");
  const corrected = await db.transaction((tx) =>
    correctCapitalEvent(tx as Tx, ACTOR, {
      eventId: capitalEventId,
      amountMinor: 5_000,
      occurredAt: new Date(),
      reason: "Verification: typed an extra zero",
    }),
  );

  const after = await computeIdentity(db);
  assert(
    after.capitalInvestedMinor === before.capitalInvestedMinor + 5_000,
    `capital invested moved by exactly 5,000 (${before.capitalInvestedMinor} -> ${after.capitalInvestedMinor})`,
  );
  assert(
    corrected.cashOnHandMinor === after.cashOnHandMinor,
    "the correction's reported cash matches the ledger",
  );

  const capitalHistory = await getEditHistory(db, "capital_events", capitalEventId);
  const amountEdit = capitalHistory.find((h) => h.fieldName === "amountMinor");
  assert(amountEdit?.oldValue === "50000", "the audit kept the previous amount");
  assert(amountEdit?.newValue === "5000", "the audit holds the corrected amount");
  assert(!!amountEdit?.reason, "the correction recorded a reason");

  console.log("\n== all three invariants, after all three corrections ==");
  await invariantsHold("final");

  console.log(
    `\nAll corrections verified. (vendor ${vendorId}, batch ${batchId}, capital event ${capitalEventId})\n`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error("\n", error);
    process.exit(1);
  });
