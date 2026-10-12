-- Narrow the immutability tiers so capital records can be corrected (FR-042, FR-046).
--
-- Written by hand: drizzle-kit does not model triggers, so it cannot generate or diff this.

-- A capital event may now be corrected in place. Deletion is still forbidden, so the table keeps
-- a DELETE-only trigger rather than losing protection entirely.
DROP TRIGGER IF EXISTS "capital_events_append_only" ON "capital_events";--> statement-breakpoint

CREATE TRIGGER "capital_events_no_delete" BEFORE DELETE ON "capital_events"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();--> statement-breakpoint

-- cash_events becomes SOURCE-CONDITIONAL rather than open.
--
-- Correcting a capital event must amend the cash row it produced, or cash on hand and capital
-- invested stop agreeing. But a sale's takings, a customer refund, a purchase payment, a vendor
-- refund and a cost adjustment must stay exactly as recorded — that is what makes a sale a record
-- of what happened at the till.
--
-- Enforced here rather than in the service layer because the value of a database rule is that it
-- holds for code nobody has written yet.
CREATE FUNCTION forbid_non_capital_cash_mutation() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'cash_events is append-only';
  END IF;

  IF OLD.source_type NOT IN ('capital_injection', 'withdrawal') THEN
    RAISE EXCEPTION
      'cash_events row with source_type % is append-only; only capital-sourced rows may be corrected',
      OLD.source_type;
  END IF;

  -- The source identity itself is never rewritten: a correction adjusts the amount or date, it
  -- does not re-point the row at a different business event.
  IF NEW.source_type IS DISTINCT FROM OLD.source_type
     OR NEW.source_id IS DISTINCT FROM OLD.source_id THEN
    RAISE EXCEPTION 'cash_events source_type and source_id are immutable';
  END IF;

  RETURN NEW;
END
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS "cash_events_append_only" ON "cash_events";--> statement-breakpoint

CREATE TRIGGER "cash_events_source_conditional" BEFORE UPDATE OR DELETE ON "cash_events"
  FOR EACH ROW EXECUTE FUNCTION forbid_non_capital_cash_mutation();
