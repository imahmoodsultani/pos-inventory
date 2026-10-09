# Feature Specification: Retail POS with Batch-Level Inventory, Cost Attribution, and Capital Tracking

**Feature Branch**: `001-retail-pos-inventory`
**Created**: 2026-10-09
**Status**: Draft
**Input**: User description: "i want to create a web based pos application that contains the inventory management as well, i have a new retail business with multiple items in it, i purchase different items on different rates and manage inventory and also sale the items on different rates and sometime reinvest the total revenue amount and sometime liquidate the profit or complete sale revenue. also i get same items from different vendors for different rates depending on the quality of the product i'm receiving and when i sale something i have to keep record of what things i have sold of what quality meaning the items i sold came from which vendor at what cost and how much profit i earned on that item and when i get new items i have to keep track if i invested more money in it or reinvested the earned revenue from one of the previous sales. I might reinvest the full amount from previous sales or partially reinvest and partially liquidate or might be fully liquidate. the application should show a complete summary of profit i have made till date and how much capital i have invested and how much capital i have recovered. the app should maintain the inventory since every single unit of each item matters. i want to deploy it to vercel."

## Clarifications

### Session 2026-10-09

- Q: Does each physical unit need its own tracked identity (serial/IMEI/tag), or are exact per-batch quantities sufficient? → A: Batch quantities only — no per-unit identity; attribution comes from the batch.
- Q: When several batches of the same product are in stock, who decides which batch a sale draws from? → A: The person making the sale always picks the batch explicitly on every sale line; no automatic selection.
- Q: When reinvesting revenue into a new purchase, must the system link it to the specific earlier sale the money came from? → A: No — a single pooled cash balance; the purchase records only the split between new capital and reinvested revenue.
- Q: Should the profit summary account for business expenses (rent, wages, utilities), or report gross trading profit only? → A: Gross trading profit only — no expense tracking in this release; the summary must label the figure as trading profit, not net profit.
- Q: Who will use this application — just the owner, or staff as well? → A: Owner plus a salesperson role; salespeople record sales but must never see cost, profit, or capital figures.
- Q: Is "capital invested" the owner's injections only, or injections plus the new-capital portion of each purchase? → A: Injections only. The funding split on a purchase describes how pooled cash was deployed and does not add to capital invested.
- Q: Can a product be sold in fractional amounts (0.5 kg), or only whole units? → A: Whole units only; unit of measure is restricted to discrete countable units.
- Q: Who may record a customer return — the owner only, or a salesperson too? → A: Both. Voiding an entire sale remains owner-only.
- Q: When a batch's cost is corrected after some of its units were sold, where does the difference go? → A: Booked as a single dated adjustment at the moment of correction; past sales keep their original cost.
- Q: When goods are returned to a vendor and the refund differs from what the units cost, where does the difference go? → A: It cannot differ — the refund always equals the cost of the returned units; partial credits and restocking fees are not supported in this release.
- Q: What exactly caps how much of a purchase may be recorded as reinvested revenue? → A: Retained sale proceeds — sale receipts less customer refunds, less withdrawals, less amounts already reinvested. Proceeds, not profit: recovering the cost of goods and putting it back into stock counts as reinvesting revenue.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Receive stock into vendor- and quality-specific costed batches (Priority: P1)

The owner buys a quantity of a product from a vendor at an agreed rate. The same product may already
be in stock, bought earlier from a different vendor, at a different quality, at a different rate. The
owner records this receipt as its own batch so that its vendor, quality, and unit cost stay attached
to those specific units for the rest of their life in the business.

**Why this priority**: Nothing else in the system can be correct without this. Cost attribution at
sale time, profit per item, inventory valuation, and capital reporting all read from the batch record
created here. A single pooled average cost per product would permanently destroy the vendor- and
quality-level truth the owner needs.

**Independent Test**: Record two receipts of the same product — one from Vendor A at grade A for one
rate, one from Vendor B at grade B for a different rate — and confirm the stock list shows both
batches separately, with correct remaining quantities and correct per-unit costs, and that total
on-hand for the product equals the sum of both batches.

**Acceptance Scenarios**:

1. **Given** an empty catalogue, **When** the owner adds a product, a vendor, and records a receipt of
   20 units at a given unit cost and quality grade, **Then** the product shows 20 units on hand in one
   batch carrying that vendor, grade, and unit cost.
2. **Given** 20 units of a product already in stock from Vendor A, **When** the owner records a receipt
   of 15 units of the same product from Vendor B at a different rate and grade, **Then** the product
   shows 35 units on hand across two distinct batches, and neither batch's unit cost has changed.
3. **Given** a recorded receipt, **When** the owner adds a freight or handling charge to that receipt,
   **Then** the effective per-unit cost of every unit in that batch increases proportionally and the
   batch's total cost reflects the added charge.
4. **Given** a product that has stock or sales history, **When** the owner attempts to delete it,
   **Then** the system refuses and offers deactivation instead.

---

### User Story 2 - Sell items with exact cost and profit attribution (Priority: P2)

The owner sells items over the counter, setting the selling price per sale (the same item may sell at
different rates to different customers). Each sold unit is drawn from a specific batch, so the system
records which vendor it came from, at what quality, at what cost, and what profit the sale produced.

**Why this priority**: This is the daily operation of the business and the point at which profit comes
into existence. It depends on Story 1 but delivers the headline value: knowing the real margin on
every sale rather than an estimated one.

**Independent Test**: With two batches of the same product at different costs in stock, record a sale
drawing units from a chosen batch at a chosen price, then confirm stock dropped only in that batch and
the sale record shows that batch's vendor, grade, unit cost, and the resulting profit.

**Acceptance Scenarios**:

1. **Given** a batch of 20 units with a known unit cost, **When** the owner sells 3 units at a stated
   price, **Then** the batch drops to 17 units and the sale line records unit cost, selling price, and
   profit equal to (selling price − effective unit cost) × 3.
2. **Given** two batches of the same product at different costs, **When** the owner completes a sale
   drawing from one of them, **Then** only that batch's remaining quantity decreases and the sale
   permanently stores that batch's vendor and quality grade.
3. **Given** a batch with 2 units remaining, **When** the owner attempts to sell 5 units from it,
   **Then** the system refuses to complete the sale and states the available quantity.
4. **Given** a selling price below the unit cost, **When** the owner confirms the sale, **Then** the
   system completes it and records a negative profit on that line rather than blocking or hiding it.
5. **Given** a completed sale, **When** the owner records a return of one unit from it, **Then** that
   unit returns to its original batch, the profit on that sale is reduced accordingly, and both the
   original sale and the return remain visible in history.

---

### User Story 3 - Fund purchases from new capital, reinvested revenue, or both (Priority: P3)

When the owner buys new stock, they record where the money came from: fresh capital put into the
business, revenue earned from earlier sales, or a mix of the two. Separately, they record when they
take money out of the business — withdrawing profit only, or withdrawing the full proceeds of a sale.

**Why this priority**: This is what turns a sales ledger into a picture of the business. Without it,
the owner cannot distinguish money they put in from money the business earned, and "how much have I
actually recovered?" is unanswerable. It builds on Stories 1 and 2 but is independently usable.

**Independent Test**: Record an initial capital injection, a purchase funded entirely from it, a sale,
then a second purchase funded partly from that sale's revenue and partly from new capital, and a
withdrawal of the remainder. Confirm cash on hand, total invested, and total withdrawn each move by
exactly the expected amounts.

**Acceptance Scenarios**:

1. **Given** a new business, **When** the owner records a capital injection, **Then** cash on hand and
   total capital invested both increase by that amount.
2. **Given** available cash, **When** the owner records a purchase and marks it fully funded by new
   capital, **Then** cash on hand decreases by the purchase cost and total capital invested is
   **unchanged** — the money was already counted as invested when it was injected.
3. **Given** revenue from earlier sales, **When** the owner records a purchase funded partly by
   reinvested revenue and partly by new capital, **Then** the funding split is stored with the
   purchase, cash on hand falls by the full purchase cost, and total capital invested is unchanged.
4. **Given** a purchase being recorded, **When** the funding amounts entered do not sum to the total
   purchase cost, **Then** the system refuses to save it and shows the difference.
5. **Given** proceeds from a sale, **When** the owner withdraws part of them and leaves the rest in the
   business, **Then** total capital recovered increases by the withdrawn amount and cash on hand
   decreases by it.
6. **Given** cash on hand lower than a requested withdrawal, **When** the owner attempts the
   withdrawal, **Then** the system refuses and states the available balance.

---

### User Story 4 - See a complete business summary at any time (Priority: P4)

The owner opens one screen and sees, for the whole life of the business to date: total profit earned,
total capital invested, total capital recovered, cash currently on hand, and the cost value of stock
still unsold — and can narrow any of it to a date range.

**Why this priority**: This is the question the owner asked to be able to answer. It is a read-only
view over Stories 1–3, so it has no value until they exist, but it is the reason the data is being
captured.

**Independent Test**: With a known sequence of injections, purchases, sales, and withdrawals recorded,
open the summary and confirm every figure matches a hand calculation, and that invested − recovered +
profit equals cash on hand + inventory at cost.

**Acceptance Scenarios**:

1. **Given** recorded business activity, **When** the owner opens the summary, **Then** profit to
   date, capital invested, capital recovered, cash on hand, and unsold inventory at cost are all shown
   without the owner performing any calculation or export.
2. **Given** the summary is open, **When** the owner applies a date range, **Then** profit and activity
   figures recalculate for that range while position figures (cash, stock on hand) continue to show
   the current position, clearly labelled as such.
3. **Given** any set of recorded activity, **When** the summary is displayed, **Then** the figures
   satisfy the identity: capital invested − capital recovered + profit to date = cash on hand +
   unsold inventory at cost.

---

### User Story 5 - Trace any sold item and compare vendors and quality grades (Priority: P5)

The owner looks back at what was sold and sees, for each sold unit, which vendor supplied it, at what
quality, at what cost, at what price, and what it earned — and can roll that up to compare which
vendors and which quality grades actually make money.

**Why this priority**: Purely retrospective. It makes the captured data actionable for buying
decisions, but the business runs without it.

**Independent Test**: After recording sales drawn from several vendors and grades, open a past sale and
confirm full attribution per line, then open the margin report and confirm the per-vendor and
per-grade totals equal the sum of the matching sale lines.

**Acceptance Scenarios**:

1. **Given** a past sale, **When** the owner opens it, **Then** each line shows vendor, quality grade,
   unit cost, selling price, and profit as they were at the time of sale.
2. **Given** sales across multiple vendors, **When** the owner opens the margin report, **Then**
   revenue, cost, profit, and margin percentage are shown per vendor, per quality grade, and per
   product.
3. **Given** a vendor's cost on a past receipt was later corrected, **When** the owner views a sale
   that drew from that receipt, **Then** the sale still shows the cost that was attributed at the time
   of sale, and the correction is visible as a separate adjustment.

---

### Edge Cases

- A sale is attempted for the last remaining unit of a batch from two devices at the same time — only
  one may succeed; the other must be told the stock is gone.
- Stock is damaged, lost, or found during a physical count — recorded as a write-off or adjustment with
  a reason, affecting stock and profit, never by silently editing a quantity.
- Goods are returned to a vendor after receipt — removes units from that batch and returns money to
  cash on hand.
- A receipt's unit cost was entered wrong and is corrected after some of its units were already sold.
- A batch is exhausted but must remain visible in history because sales reference it, and MUST NOT be
  offered for selection on a new sale line.
- A product has many open batches at once, so the batch selection list at the till must stay readable
  and quick to choose from.
- A customer buys more units of one product than any single batch holds, so the quantity must be split
  across batches within the same sale.
- A sale is voided in full after completion.
- A withdrawal is attempted that exceeds cash on hand.
- A purchase is recorded on a date earlier than the most recent sale (backdated entry).
- Two vendors supply the same product at the same quality and the same cost — these are still distinct
  batches.
- A product is sold at a loss deliberately to clear old stock.
- Inventory exists with zero sales to date, so profit is zero but capital is fully deployed.

## Requirements *(mandatory)*

### Functional Requirements

#### Catalogue, vendors, and quality

- **FR-001**: System MUST let the owner create, edit, and deactivate products, each with a name, a
  unique code, and a unit of measure. The unit of measure MUST be a **discrete countable unit** (for
  example piece, box, pack, pair). Units that imply fractional quantities, such as weight or length,
  MUST NOT be offered, because all quantities are whole numbers (FR-013).
- **FR-002**: System MUST let the owner maintain a list of vendors with at least a name and optional
  contact details.
- **FR-003**: System MUST let the owner define a set of quality grades and MUST require a grade to be
  assigned to every batch of stock received.
- **FR-004**: System MUST prevent deletion of any product, vendor, or quality grade referenced by stock
  or sales history, and MUST offer deactivation instead.

#### Receiving and inventory

- **FR-005**: System MUST record every receipt of goods as a distinct batch capturing product, vendor,
  quality grade, quantity received, unit cost, receipt date, and an optional reference.
- **FR-006**: System MUST allow one product to hold multiple simultaneous batches differing by vendor,
  quality grade, and unit cost, and MUST NOT merge or average them.
- **FR-007**: System MUST allow additional landed costs (freight, duty, handling) to be attached to a
  batch and MUST spread them across that batch's units to produce an effective per-unit cost.
- **FR-007a**: When a batch's cost changes after some of its units have already been sold — whether by
  a later landed cost or by correcting a wrongly entered rate — the system MUST record the entire cost
  difference as a **single dated adjustment at the moment of the change**, visible in history. Already
  recorded sales MUST keep the cost they were given at the time of sale (FR-038), and the effective
  cost of the units still remaining MUST be recalculated from the new batch total. The adjustment is
  what keeps the batch's recorded costs summing exactly to what was paid for it.
- **FR-008**: System MUST track remaining quantity for each batch, changed only through recorded stock
  movements.
- **FR-009**: System MUST record every stock change as a permanent movement capturing type (receipt,
  sale, sale return, vendor return, adjustment, write-off), quantity, batch, acting user, timestamp,
  and a reason for adjustments and write-offs.
- **FR-010**: System MUST derive on-hand quantity from recorded movements and MUST provide a
  reconciliation view proving the displayed quantity matches the movement history.
- **FR-011**: System MUST NOT permit any stock movement that would take a batch's remaining quantity
  below zero.
- **FR-012**: System MUST let the owner record a physical stock count and generate the adjustment
  movements needed to match it, with a reason recorded.
- **FR-013**: System MUST track stock as exact whole-unit quantities within each batch and MUST NOT
  require an individual identifier (serial, IMEI, or tag) per unit. Every unit's vendor, quality grade,
  and cost MUST be derivable from the batch it belongs to.

#### Selling

- **FR-014**: System MUST let the owner record a sale containing one or more lines, where each line
  draws from exactly one batch.
- **FR-015**: System MUST let the selling price be set per sale line, independently of any catalogue
  price, so the same product can sell at different rates.
- **FR-016**: System MUST permanently store, on each sale line, the vendor, quality grade, and
  effective unit cost of the batch it drew from, as they stood at the moment of sale.
- **FR-017**: System MUST calculate and store profit per sale line as (selling price − effective unit
  cost) × quantity, and MUST store a negative value when the item sells below cost.
- **FR-018**: System MUST require the person making the sale to select the source batch explicitly on
  every sale line, and MUST NOT select a batch automatically or default to one. A sale line without a
  chosen batch MUST NOT be completable.
- **FR-018a**: When presenting batches for selection, the system MUST show each available batch with
  its vendor, quality grade, remaining quantity, and receipt date, so the batch can be identified
  without seeing cost figures.
- **FR-018b**: System MUST let the person making the sale split one product across multiple batches
  within a single sale, recording each portion as its own sale line with its own batch and cost.
- **FR-019**: System MUST complete a sale as a single all-or-nothing operation covering the sale
  record, its stock movements, and its effect on cash; a partially recorded sale MUST NOT be possible.
- **FR-020**: System MUST safely reject the second of two concurrent attempts to sell the same last
  unit, with a message naming the available quantity.
- **FR-021**: System MUST let **either the owner or a salesperson** record a full or partial return
  against a completed sale, returning the units to their original batch and reversing the
  corresponding revenue, cost, and profit. The acting user MUST be recorded on the return, and a
  salesperson performing one MUST NOT be shown the cost or profit being reversed.
- **FR-022**: System MUST let the owner void a completed sale by recording reversing entries, and MUST
  NOT delete the original sale. Voiding an entire sale is **owner-only** and is not available to a
  salesperson.
- **FR-023**: System MUST let the owner record a return of goods to a vendor against a batch, removing
  the units and restoring to cash on hand an amount **exactly equal to the effective cost of the units
  returned**. The refund amount is derived from the batch, not entered by the owner, so a vendor return
  can never move profit.
- **FR-023a**: System MUST NOT support partial vendor credits, restocking fees, or any vendor refund
  that differs from the cost of the units returned. If a vendor refunds less than the full cost, the
  shortfall cannot be represented in this release (see Assumptions).

#### Capital, reinvestment, and cash

- **FR-024**: System MUST let the owner record capital injections, each with amount, date, and optional
  note, increasing cash on hand and total capital invested.
- **FR-025**: System MUST let the owner record withdrawals, each with amount, date, and optional note,
  decreasing cash on hand and increasing total capital recovered.
- **FR-026**: System MUST require every purchase to record how it was funded, split between new capital
  and reinvested revenue, and MUST reject the purchase if the split does not sum exactly to its total
  cost.
- **FR-026a**: The funding split is a **descriptive record of how pooled cash was deployed**. It MUST
  NOT change total capital invested or total capital recovered. Capital invested changes only through
  capital injections (FR-024); capital recovered changes only through withdrawals (FR-025). Recording
  a purchase as funded by new capital MUST NOT count that money as invested a second time.
- **FR-027**: System MUST support a purchase funded entirely by new capital, entirely by reinvested
  revenue, or by any mix of the two — which is the same mechanism that lets sale proceeds be fully
  reinvested, partially reinvested and partially withdrawn, or fully withdrawn.
- **FR-028**: *(Proceeds-side restatement of FR-027; no separate behaviour to build.)* Fully
  reinvesting a sale's proceeds means recording a later purchase whose reinvested portion equals those
  proceeds; withdrawing them means recording a withdrawal under FR-025. Both paths are already covered
  by FR-027 and FR-029a.
- **FR-029**: System MUST treat all business money as a single pooled cash balance. Reinvested revenue
  MUST NOT be linked to, or reconciled against, any specific earlier sale; a purchase records only how
  much came from new capital and how much from reinvested revenue.
- **FR-029a**: System MUST cap the reinvested-revenue portion of a purchase at the **retained sale
  proceeds** available at that moment, defined as: total sale receipts to date, minus customer refunds,
  minus all withdrawals to date, minus every amount already recorded as reinvested on earlier
  purchases. The cap is additionally bounded by cash on hand (FR-031). This makes reinvestment mean
  "money that came in from selling and has not yet been taken out or already redeployed", so the same
  proceeds can never be reinvested twice, and proceeds that were withdrawn cannot also be reinvested.
  The figure is sale **proceeds**, not profit: recovering the cost of goods and putting it straight
  back into new stock is reinvesting revenue, which is how the business actually operates.
- **FR-030**: System MUST maintain a running cash-on-hand balance equal to capital injections plus
  sale receipts plus vendor refunds, minus purchase payments, minus withdrawals, minus customer
  refunds.
- **FR-031**: System MUST refuse any withdrawal or purchase payment that would drive cash on hand below
  zero, and MUST state the available balance when refusing.
- **FR-032**: System MUST record the acting user and a server-generated timestamp on every operation
  that changes money or stock — capital, cash, purchase, sale, stock movement, batch, and funding
  record alike. No transactional row may exist without an attributable actor.

#### Summary and reporting

- **FR-033**: System MUST present a single summary showing, for the life of the business to date:
  profit earned, capital invested, capital recovered, cash on hand, and unsold inventory valued at
  effective cost.
- **FR-033a**: System MUST compute these figures as: **capital invested** = the sum of capital
  injections; **capital recovered** = the sum of withdrawals; **cash on hand** per FR-030; **unsold
  inventory at cost** = the effective cost of every unit still remaining across all batches. No
  purchase funding split contributes to capital invested or recovered (FR-026a). These definitions are
  what make the SC-003 identity hold exactly.
- **FR-034**: System MUST let the summary be filtered to a date range, with activity figures recomputed
  for that range and current-position figures clearly labelled as current rather than ranged.
- **FR-035**: System MUST compute profit to date as the sum of sale line profits, less write-offs, less
  the profit reversed by returns and voids, and less any cost-correction adjustments recorded under
  FR-007a. This is gross trading profit; business running costs are not part of the calculation.
- **FR-035a**: System MUST label the profit figure on the summary as trading profit (revenue less cost
  of goods sold) so it is not mistaken for net business profit.
- **FR-035b**: System MUST treat the cash-on-hand figure as cash arising from trading and capital
  events only. Money removed from the business for any other purpose MUST be recorded as a withdrawal
  to keep the balance truthful.
- **FR-036**: System MUST provide a stock-on-hand report per product showing each contributing batch
  with its vendor, quality grade, remaining quantity, and effective unit cost.
- **FR-037**: System MUST provide a margin report grouping revenue, cost, profit, and margin percentage
  by vendor, by quality grade, and by product.
- **FR-038**: System MUST let the owner open any past sale and see full attribution per line, showing
  the values recorded at the time of sale even if the source batch has since been corrected.
- **FR-039**: System MUST surface products that are out of stock or below an owner-defined reorder
  level. A reorder level of zero means **not set**, and such products MUST be excluded from the
  low-stock list rather than reported as perpetually at their threshold.

#### Access, audit, and operation

- **FR-040**: System MUST require authentication for every screen except sign-in, enforced on the
  server.
- **FR-041**: System MUST support exactly two roles: an owner who sees everything, and a salesperson
  who can record sales and returns and view stock availability, but who MUST NOT see any cost,
  profit, capital, or cash figure anywhere in the application, including on the batch selection list,
  in reports, and in exported or printed output.
- **FR-041a**: System MUST let the owner create, deactivate, and reset the password of salesperson
  accounts.
- **FR-041b**: System MUST enforce role restrictions on the server for every request, so that hiding a
  figure in the interface is never the only barrier to seeing it.
- **FR-042**: System MUST NOT permanently delete any sale, purchase, stock movement, or capital record;
  corrections MUST be recorded as new reversing or adjusting entries.
- **FR-043**: System MUST remain fully usable on a touch screen at tablet width for the sales flow.
- **FR-044**: System MUST show understandable error messages that state what went wrong and what the
  owner can do, without exposing internal technical detail.

### Key Entities

- **Product**: Something the business buys and sells. Name, unique code, unit of measure, reorder
  level, active flag. Holds many batches.
- **Vendor**: A supplier the business buys from. Name, contact details, active flag.
- **Quality Grade**: A named quality tier assigned to received goods, used to distinguish otherwise
  identical products and to compare margins.
- **Purchase Batch**: One receipt of one product from one vendor at one quality and one rate. Holds
  quantity received, unit cost, landed costs, effective unit cost, remaining quantity, receipt date,
  and its funding split. The anchor for all cost attribution.
- **Stock Movement**: A permanent record of one change in stock. Type, batch, quantity change, reason,
  acting user, timestamp. On-hand quantity is derived from these.
- **Sale**: One over-the-counter transaction. Date, acting user, total revenue, total cost, total
  profit, status (completed, returned, voided).
- **Sale Line**: One product sold from one batch within a sale. Quantity, selling price, and a frozen
  copy of the batch's vendor, quality grade, and effective unit cost, plus the resulting profit.
- **Capital Event**: Money entering or leaving the owner's stake — an injection or a withdrawal. Amount,
  direction, date, note.
- **Funding Allocation**: How a purchase was paid for — how much from new capital and how much from
  reinvested revenue, drawn from the pooled cash balance rather than from a named earlier sale.
- **Cash Position**: The running balance of money held by the business, derived from capital events,
  sale receipts, purchase payments, refunds, and withdrawals.
- **User**: A person who signs in, carrying a role that determines whether cost, profit, and capital
  figures are visible.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For any unit sold at any time in the past, the owner can identify its vendor, quality
  grade, purchase cost, selling price, and profit in under 10 seconds, without exporting data.
- **SC-002**: The owner can see total profit to date, capital invested, and capital recovered on one
  screen within 5 seconds of opening the application, with no manual calculation.
- **SC-003**: Across any recorded history, the figures satisfy capital invested − capital recovered +
  profit to date = cash on hand + unsold inventory at cost, exact to the smallest currency unit, with
  zero tolerance for rounding drift.
- **SC-004**: 100% of recorded purchases carry a funding split that sums exactly to their total cost; a
  purchase without one cannot be saved.
- **SC-005**: Recorded on-hand quantity matches a physical count for every product when all movements
  have been entered, and any difference is explained by a reasoned adjustment rather than an
  unexplained variance.
- **SC-006**: A complete two-line sale can be recorded in under 60 seconds by a salesperson, including
  choosing the item, setting the price, and completing the sale.
- **SC-007**: Stock never goes negative and no sale is ever recorded without cost and profit attached,
  across a 30-day period of real use.
- **SC-008**: A new owner can record their first vendor, product, purchase, and sale within 15 minutes
  without training or documentation.
- **SC-009**: The system remains responsive with at least 2,000 products, 200 vendors, and 50,000
  recorded stock movements, with the summary screen and stock report each loading in under 3 seconds.
- **SC-010**: A salesperson account can complete sales but cannot view any cost, profit, or capital
  figure anywhere in the application.

## Assumptions

- Single retail location and a single currency. Multi-store and multi-currency are not required for the
  first release.
- A small number of users: one owner plus a handful of salespeople.
- Sales are immediate over-the-counter transactions, paid in full at the time of sale. Customer credit,
  layaway, and accounts receivable are not required.
- Purchases are paid at the time of receipt. Vendor credit terms and payable aging are not required.
- Payment method is captured as a simple label (for example cash or card) for record-keeping; no
  payment terminal or gateway is involved.
- "Profit" means gross trading profit — revenue less the cost of goods sold. Operating expenses such as
  rent, wages, utilities, and transport are not tracked in this release, so the summary describes
  trading profit, not net business profit. **Known consequence**: if the owner pays such costs out of
  the till, the system's cash-on-hand figure will exceed the physical cash present unless each payment
  is recorded as a withdrawal — which will in turn count toward capital recovered rather than toward
  expenses. The owner accepts this limitation for the first release.
- Everything the business sells is counted in whole discrete units. Nothing is sold by weight, length,
  or volume (FR-001, FR-013).
- Vendor returns are assumed to be full-value credits. **Known consequence**: if a vendor deducts a
  restocking fee or issues only a partial credit, the system will still restore the full cost to cash
  on hand, overstating cash by the shortfall. Recording the shortfall as a withdrawal would restore the
  cash figure but would wrongly count it toward capital recovered. The owner accepts this limitation
  for the first release (FR-023a).
- Sales tax computation and tax reporting are not required; prices entered are the final amounts
  transacted.
- The business has internet connectivity when operating; the application is not required to work
  offline.
- Product codes can be entered by keyboard or by a barcode scanner acting as a keyboard; no dedicated
  hardware integration is required.
- Historical data from any previous system does not need to be migrated; the business starts fresh.

## Out of Scope

The following are explicitly excluded from this feature and may be considered later:

- Multiple stores, warehouses, or stock transfers between locations
- Customer accounts, loyalty programs, promotions, or discount rules engines
- Purchase orders, vendor quotations, and approval workflows
- Accounts payable and accounts receivable aging
- Operating expense tracking, payroll, and net-profit accounting
- Tax calculation, tax filing, or statutory invoice formats
- Integration with external accounting software
- Offline operation and local data caching on the device
- Online storefront or e-commerce selling
- Hardware integrations such as cash drawers, receipt printers, or scales
- Per-unit serial, IMEI, or tag tracking of individual units (see FR-013)
- Selling by weight, length, or volume, and any fractional quantity (see FR-001)
- Partial vendor credits, restocking fees, and vendor refunds that differ from the cost of the goods
  returned (see FR-023a)
