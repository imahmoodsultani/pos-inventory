# Spec Delta

## Purpose

Creating and maintaining the people who can use the system — their identity details, credentials,
role, and whether they may currently sign in — under the constraint that the business can never be
left with no way back in.

## ADDED Requirements

### Requirement: Staff identity details SHALL be editable by an owner

An owner SHALL be able to change another account's display name and email address after creation.
The account keeps its identity, so every sale, adjustment, and capital event that records it as the
acting user continues to point at the same person.

Email addresses remain unique. An edit that would collide with an existing account SHALL be refused
with a message naming the conflict.

#### Scenario: Correcting a mistyped email

- **WHEN** an owner changes a salesperson's email from "sles@shop.test" to "sales@shop.test"
- **THEN** the change is saved
- **AND** that person signs in with the corrected address
- **AND** every record that names them as the acting user is unchanged

#### Scenario: Changing an email to one already in use

- **WHEN** an owner changes an account's email to an address another account already uses
- **THEN** the change is refused
- **AND** the message states that an account with that email already exists

#### Scenario: Changing an email invalidates existing sessions

- **WHEN** an owner changes another account's email address
- **THEN** that account's existing sessions are ended
- **AND** the person must sign in again with the new address

### Requirement: An owner SHALL be able to reset a staff password

An owner SHALL be able to set a new password for any account from the staff screen. The new password
SHALL be subject to the same minimum length as account creation, and SHALL be shown to the owner
once so they can pass it on.

Resetting a password SHALL end every existing session for that account, because a reset usually
means the previous password is compromised or the person has left.

#### Scenario: Resetting a forgotten password

- **WHEN** an owner sets a new password for a salesperson who has forgotten theirs
- **THEN** the new password is saved
- **AND** the salesperson can sign in with it
- **AND** any session they had open is ended

#### Scenario: Rejecting a weak password

- **WHEN** an owner enters a new password shorter than the minimum length
- **THEN** the reset is refused
- **AND** the message states the minimum length

### Requirement: The business SHALL never be left without an active owner

The system SHALL refuse any change that would leave zero active owner accounts — whether by
deactivating the last one, or by changing its role. There is no public sign-up and no
password-reset email, so losing the last owner locks everyone out of their own records permanently.

The refusal SHALL state the way forward, not merely decline.

#### Scenario: Deactivating the only owner

- **WHEN** an owner tries to deactivate the only active owner account
- **THEN** the change is refused
- **AND** the message explains that this is the only active owner and that another owner must be
  appointed first

#### Scenario: Demoting the only owner

- **WHEN** an owner tries to change the only owner account's role to salesperson
- **THEN** the change is refused
- **AND** the message explains that another owner must be appointed first

#### Scenario: Deactivating an owner when another exists

- **WHEN** an owner deactivates an owner account while another active owner exists
- **THEN** the change is saved
- **AND** the deactivated account's sessions are ended immediately

### Requirement: Staff account changes SHALL be attributable and never destructive

Accounts SHALL NOT be deleted. Every change to an account — details, role, active status, password —
SHALL record which user made it and when. A password's value SHALL NEVER appear in the audit record.

#### Scenario: Reviewing account history

- **WHEN** an owner views the history of an account whose role was changed
- **THEN** they see who made the change, when, the previous role, and the new role

#### Scenario: Password values stay out of the audit trail

- **WHEN** an owner resets a staff password
- **THEN** the audit record shows that the password was changed, by whom and when
- **AND** neither the old nor the new password value is stored in the audit record
