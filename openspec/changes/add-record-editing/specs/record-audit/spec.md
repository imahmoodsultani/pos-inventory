# Spec Delta

## Purpose

Recording who changed a stored record, when, and from what value to what value — so that allowing
records to be edited in place does not cost the ability to explain how a figure came to be what it
is.

## ADDED Requirements

### Requirement: Every in-place edit SHALL be recorded

Any change that replaces a stored value rather than appending a new entry SHALL write an audit
record containing the record changed, the field changed, the previous value, the new value, the user
who made the change, and the time it was made.

The audit record SHALL be written in the same transaction as the change itself, so a change can
never be saved without its audit trail.

#### Scenario: Editing a vendor writes an audit record

- **WHEN** an owner changes a vendor's phone number
- **THEN** an audit record exists naming the vendor, the field, the old number, the new number, the
  acting user, and the time

#### Scenario: A failed change leaves no audit record

- **WHEN** an edit is attempted and rejected
- **THEN** no audit record is written for it

#### Scenario: Several fields changed at once

- **WHEN** an owner changes a vendor's name and email in a single edit
- **THEN** the audit history shows both field changes attributable to that one edit

### Requirement: The audit log SHALL be append-only

Audit records SHALL NOT be editable or deletable, enforced by the database rather than by
convention. An audit trail that can be rewritten answers nothing.

#### Scenario: Attempting to alter an audit record

- **WHEN** any actor attempts to update or delete an audit record
- **THEN** the database rejects it

### Requirement: Secret values SHALL NEVER be stored in the audit log

Passwords, session tokens, and API secrets SHALL NOT appear in audit records in any form. For such
fields the audit record states that the value changed, without either value.

#### Scenario: Password reset is audited without the password

- **WHEN** an owner resets a staff password
- **THEN** the audit record shows a password change with the acting user and time
- **AND** neither the previous nor the new password appears in the record

### Requirement: Audit history SHALL be visible to an owner

An owner SHALL be able to see the edit history of any record they can view, newest first, showing
what changed, who changed it, when, and the reason where one was required.

#### Scenario: Reviewing a corrected capital event

- **WHEN** an owner opens a capital event that has been corrected twice
- **THEN** they see both corrections in order, each with its before and after amount, its reason,
  and who made it

#### Scenario: A record never edited

- **WHEN** an owner opens the history of a record that has never been edited
- **THEN** they are told it has not been changed since it was created

### Requirement: Audit retention SHALL outlast the records it describes

Audit records SHALL be retained at least as long as the record they describe. The expired-key reaper
and any future cleanup SHALL NOT remove audit records for records that still exist.

#### Scenario: Routine cleanup leaves audit records intact

- **WHEN** scheduled cleanup runs
- **THEN** no audit record belonging to an existing record is removed
