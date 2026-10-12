# Spec Delta

## Purpose

Recording the owner's injections of money into the business and withdrawals out of it, correcting
those entries when they are entered wrongly, and keeping cash on hand and the capital totals exactly
consistent with every correction.

## ADDED Requirements

### Requirement: A capital event SHALL be correctable in place

An owner SHALL be able to change a recorded capital event's amount, date, and note after it has been
saved. The correction replaces the stored values rather than adding an opposing entry.

#### Scenario: Correcting a mistyped injection

- **WHEN** an owner corrects a capital injection recorded as 50,000 to its true value of 5,000
- **THEN** the capital event shows 5,000
- **AND** cash on hand falls by 45,000
- **AND** capital invested falls by 45,000
- **AND** the audit history shows the previous value, the new value, who changed it, when, and why

### Requirement: A capital correction SHALL require a reason

Correcting a capital event SHALL require a non-empty reason, stored in the audit record alongside
the previous and new values.

#### Scenario: Correction without a reason is refused

- **WHEN** an owner submits a capital correction with an empty reason
- **THEN** the correction is refused
- **AND** the message states that a reason is required

### Requirement: The direction of a capital event SHALL NOT be editable

An event's direction — injection or withdrawal — SHALL NOT be changeable. Flipping it reverses the
meaning of the entry entirely, which is clearer as a correction to zero effect plus a new entry.

#### Scenario: Direction cannot be flipped

- **WHEN** an owner attempts to change a recorded injection into a withdrawal
- **THEN** the change is refused
- **AND** the message explains that the entry should be corrected to zero effect and the correct
  entry recorded separately

### Requirement: A capital correction SHALL keep cash and capital totals consistent

A capital event and the cash event it produced SHALL be corrected together in one transaction. After
any correction the accounting identity SHALL still hold exactly:

```
capital invested - capital recovered + profit = cash on hand + inventory at cost
```

#### Scenario: The identity survives a correction

- **WHEN** any capital event is corrected by any amount
- **THEN** the accounting identity balances to the minor unit immediately afterwards

#### Scenario: A correction that would overdraw the till is refused

- **WHEN** an owner corrects a withdrawal upward to an amount that would drive cash on hand below
  zero
- **THEN** the correction is refused
- **AND** the message states the cash currently available

#### Scenario: Correcting an injection downward below money already spent

- **WHEN** an owner reduces an injection so far that cash on hand would go negative
- **THEN** the correction is refused
- **AND** the message states the cash currently available and the largest reduction that is possible

### Requirement: Capital events SHALL NOT be deleted

A capital event SHALL NOT be removable. An entry recorded entirely in error is corrected to an
amount of zero effect, which keeps the entry and its reason in the history rather than removing the
evidence that a mistake was made.

#### Scenario: Attempting to delete a capital event

- **WHEN** an owner attempts to delete a capital event
- **THEN** the system refuses
- **AND** offers correction instead

### Requirement: Sale, purchase and refund cash movements SHALL remain immutable

Cash events arising from sales, customer refunds, purchase payments, vendor refunds, and cost
adjustments SHALL remain append-only and SHALL NOT be editable. Only cash events produced by a
capital injection or withdrawal may be amended, and only as part of correcting that capital event.

This boundary is what keeps a sale's recorded takings a record of what actually happened at the
till.

#### Scenario: Attempting to edit the cash from a sale

- **WHEN** any actor attempts to modify the cash event recorded by a sale
- **THEN** the database rejects the change
- **AND** the correction path for a sale remains void-and-rerecord
