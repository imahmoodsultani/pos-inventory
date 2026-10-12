# Spec Delta

## Purpose

Maintaining the products, vendors, and quality grades that every batch of stock is recorded
against — including correcting their details after creation, and retiring entries that must not be
used for new stock without destroying the history that references them.

## ADDED Requirements

### Requirement: Vendor details SHALL be correctable after creation

An owner SHALL be able to change a vendor's name, phone, email, and notes after the vendor has been
created, including when batches already reference it. The vendor's identity is preserved, so all
existing batches, sale-line attribution, and margin history continue to point at the same vendor.

Vendor names remain unique case-insensitively. An edit that would collide with another vendor SHALL
be refused with a message naming the conflict.

#### Scenario: Correcting a misspelled vendor name

- **WHEN** an owner changes a vendor's name from "Nortside Supply" to "Northside Supply"
- **THEN** the change is saved
- **AND** every batch previously received from that vendor still reports it as their source
- **AND** the margin report groups those batches under the corrected name, with no split between
  the old and new spelling

#### Scenario: Renaming a vendor onto an existing name

- **WHEN** an owner renames "Harbour Imports" to "northside supply" and a vendor named
  "Northside Supply" already exists
- **THEN** the change is refused
- **AND** the message states that a vendor with that name already exists

#### Scenario: Editing a vendor that is referenced by stock

- **WHEN** an owner edits the phone number of a vendor referenced by 12 batches
- **THEN** the change is saved
- **AND** no batch, sale line, or stock movement is modified

### Requirement: Quality grade details SHALL be correctable after creation

An owner SHALL be able to change a quality grade's label and sort order after creation. The grade's
code SHALL NOT be editable, because it is the short identifier shown on historical sale lines and
changing it would silently relabel past sales.

#### Scenario: Correcting a grade label

- **WHEN** an owner changes grade "A" from label "Premum" to "Premium"
- **THEN** the change is saved
- **AND** sale lines recorded against grade A display the corrected label

#### Scenario: Reordering grades for the till

- **WHEN** an owner changes the sort order of a grade
- **THEN** the till's batch picker lists grades in the new order
- **AND** no recorded sale is altered

### Requirement: Unit of measure SHALL remain immutable once set

A product's unit of measure SHALL NOT be editable after the product is created. Every recorded
quantity is a count in that unit, and changing it would reinterpret all existing quantities without
altering a single number.

#### Scenario: Attempting to change unit of measure

- **WHEN** an owner tries to change a product's unit of measure from "piece" to "box"
- **THEN** the system refuses
- **AND** the message explains that quantities already recorded are counts in the original unit, and
  that a new product should be created instead

### Requirement: Catalogue edits SHALL be attributable

Every change to a product, vendor, or quality grade SHALL record which user made it and when, and
SHALL be visible in the record-audit history for that entry.

#### Scenario: Reviewing who changed a vendor

- **WHEN** an owner views the history of a vendor whose email was corrected
- **THEN** they see the user who made the change, the time, the previous email, and the new email
