CREATE TABLE "record_edits" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"table_name" text NOT NULL,
	"record_id" text NOT NULL,
	"field_name" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"reason" text,
	"edit_group" text NOT NULL,
	"changed_by" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- REMOVED BY HAND: drizzle-kit emitted a DROP + re-ADD of batches.total_cost_minor here.
--
-- It is a no-op against the real schema and destructive in form. The column was hand-written as
-- GENERATED ALWAYS in migration 0000, but drizzle's 0000 snapshot never recorded that, so the
-- differ saw a plain column becoming generated. Running it would rewrite the cost column of every
-- batch for no change, and leave the column missing if it failed midway.
--
-- The 0000 snapshot has been corrected to match what 0000 actually creates.
--> statement-breakpoint
CREATE INDEX "record_edits_record_idx" ON "record_edits" USING btree ("table_name","record_id","changed_at");--> statement-breakpoint

-- HAND-ADDED: the audit log is itself append-only.
--
-- An audit trail that can be rewritten answers nothing. This is the one table where immutability
-- has no usability cost — nobody needs to correct a record of a correction.
CREATE TRIGGER "record_edits_append_only" BEFORE UPDATE OR DELETE ON "record_edits"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
