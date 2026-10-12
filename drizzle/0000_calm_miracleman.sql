CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"id_token" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "batches" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"product_id" bigint NOT NULL,
	"vendor_id" bigint NOT NULL,
	"grade_id" bigint NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"reference" text,
	"qty_received" integer NOT NULL,
	"qty_remaining" integer NOT NULL,
	"goods_cost_minor" bigint NOT NULL,
	"landed_cost_minor" bigint DEFAULT 0 NOT NULL,
	"total_cost_minor" bigint GENERATED ALWAYS AS ("goods_cost_minor" + "landed_cost_minor") STORED,
	"is_cost_corrected" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capital_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cash_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"direction" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"source_type" text NOT NULL,
	"source_id" bigint NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "funding_allocations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"batch_id" bigint NOT NULL,
	"new_capital_minor" bigint NOT NULL,
	"reinvested_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "funding_allocations_batch_id_unique" UNIQUE("batch_id")
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"action_name" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"response_body" jsonb,
	"locked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"unit_of_measure" text DEFAULT 'piece' NOT NULL,
	"reorder_level" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "products_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "quality_grades" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"sort_order" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "quality_grades_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "sale_lines" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sale_id" bigint NOT NULL,
	"batch_id" bigint NOT NULL,
	"product_id" bigint NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_minor" bigint NOT NULL,
	"vendor_id_at_sale" bigint NOT NULL,
	"grade_id_at_sale" bigint NOT NULL,
	"unit_cost_minor_at_sale" bigint NOT NULL,
	"revenue_minor" bigint NOT NULL,
	"cost_minor" bigint NOT NULL,
	"profit_minor" bigint NOT NULL,
	"qty_returned" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sale_number" text NOT NULL,
	"sold_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"payment_method" text NOT NULL,
	"revenue_minor" bigint NOT NULL,
	"cost_minor" bigint NOT NULL,
	"profit_minor" bigint NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "sales_sale_number_unique" UNIQUE("sale_number")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"batch_id" bigint NOT NULL,
	"movement_type" text NOT NULL,
	"qty_delta" integer NOT NULL,
	"cost_minor" bigint NOT NULL,
	"reason" text,
	"ref_type" text NOT NULL,
	"ref_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"role" text DEFAULT 'salesperson' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_grade_id_quality_grades_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."quality_grades"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funding_allocations" ADD CONSTRAINT "funding_allocations_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "batches_product_remaining_idx" ON "batches" USING btree ("product_id","qty_remaining");--> statement-breakpoint
CREATE INDEX "batches_vendor_idx" ON "batches" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "batches_grade_idx" ON "batches" USING btree ("grade_id");--> statement-breakpoint
CREATE INDEX "batches_product_received_idx" ON "batches" USING btree ("product_id","received_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_events_source_idx" ON "cash_events" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "cash_events_occurred_idx" ON "cash_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idem_scope_key" ON "idempotency_keys" USING btree ("scope","key");--> statement-breakpoint
CREATE INDEX "idem_expiry" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "sale_lines_sale_idx" ON "sale_lines" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "sale_lines_batch_idx" ON "sale_lines" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "sale_lines_product_idx" ON "sale_lines" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movements_ref_idx" ON "stock_movements" USING btree ("ref_type","ref_id","batch_id");--> statement-breakpoint
CREATE INDEX "stock_movements_batch_idx" ON "stock_movements" USING btree ("batch_id","id");--> statement-breakpoint

-- ===========================================================================
-- HAND-ADDED (T017/T018/T019) — what drizzle-kit cannot express.
--
-- If this migration is ever regenerated, EVERYTHING BELOW IS LOST, along with the
-- GENERATED ALWAYS clause on batches.total_cost_minor. These are correctness
-- constraints for a system that handles money and stock, not cosmetics.
-- ===========================================================================

-- --- CHECK constraints (T017) ----------------------------------------------

ALTER TABLE "users" ADD CONSTRAINT "users_role_valid"
  CHECK ("role" IN ('owner','salesperson'));--> statement-breakpoint

-- FR-001: discrete countable units ONLY. Weight and length are forbidden, because every
-- quantity column is INTEGER: a fractional unit could be stored but never transacted.
ALTER TABLE "products" ADD CONSTRAINT "products_uom_discrete"
  CHECK ("unit_of_measure" IN ('piece','box','pack','pair'));--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_reorder_level_sane"
  CHECK ("reorder_level" >= 0);--> statement-breakpoint

ALTER TABLE "batches" ADD CONSTRAINT "batches_qty_received_positive"
  CHECK ("qty_received" > 0);--> statement-breakpoint
-- BACKSTOP ONLY. Oversell is prevented by the guarded conditional UPDATE
-- (WHERE id = ? AND qty_remaining >= ?) checking rowCount === 0. If SQLSTATE 23514
-- from this constraint ever reaches a caller, that is a bug in the UPDATE, not a save.
ALTER TABLE "batches" ADD CONSTRAINT "batches_qty_remaining_sane"
  CHECK ("qty_remaining" >= 0 AND "qty_remaining" <= "qty_received");--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_goods_cost_non_negative"
  CHECK ("goods_cost_minor" >= 0);--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_landed_cost_non_negative"
  CHECK ("landed_cost_minor" >= 0);--> statement-breakpoint

ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_type_valid"
  CHECK ("movement_type" IN ('receipt','sale','sale_return','vendor_return','adjustment','write_off'));--> statement-breakpoint
-- Zero-quantity rows are permitted ONLY for adjustments: an FR-007a cost correction carries
-- cost but no quantity.
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_qty_delta_meaningful"
  CHECK ("qty_delta" <> 0 OR "movement_type" = 'adjustment');--> statement-breakpoint
-- FR-009/FR-012: a reason is REQUIRED on adjustments and write-offs, enforced by the database
-- rather than by validation, because this is the audit trail.
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_reason_required"
  CHECK ("movement_type" NOT IN ('adjustment','write_off') OR "reason" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_ref_type_valid"
  CHECK ("ref_type" IN ('sale_line','batch','stock_count','cost_correction','vendor_return'));--> statement-breakpoint

ALTER TABLE "sales" ADD CONSTRAINT "sales_status_valid"
  CHECK ("status" IN ('completed','partially_returned','returned','voided'));--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_payment_method_valid"
  CHECK ("payment_method" IN ('cash','card'));--> statement-breakpoint

ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_quantity_positive"
  CHECK ("quantity" > 0);--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_qty_returned_sane"
  CHECK ("qty_returned" >= 0 AND "qty_returned" <= "quantity");--> statement-breakpoint

ALTER TABLE "capital_events" ADD CONSTRAINT "capital_events_type_valid"
  CHECK ("event_type" IN ('injection','withdrawal'));--> statement-breakpoint
-- Direction lives in event_type, never in the sign of the amount.
ALTER TABLE "capital_events" ADD CONSTRAINT "capital_events_amount_positive"
  CHECK ("amount_minor" > 0);--> statement-breakpoint

ALTER TABLE "funding_allocations" ADD CONSTRAINT "funding_new_capital_non_negative"
  CHECK ("new_capital_minor" >= 0);--> statement-breakpoint
ALTER TABLE "funding_allocations" ADD CONSTRAINT "funding_reinvested_non_negative"
  CHECK ("reinvested_minor" >= 0);--> statement-breakpoint

ALTER TABLE "cash_events" ADD CONSTRAINT "cash_events_direction_valid"
  CHECK ("direction" IN ('in','out'));--> statement-breakpoint
ALTER TABLE "cash_events" ADD CONSTRAINT "cash_events_amount_positive"
  CHECK ("amount_minor" > 0);--> statement-breakpoint
ALTER TABLE "cash_events" ADD CONSTRAINT "cash_events_source_type_valid"
  CHECK ("source_type" IN ('capital_injection','withdrawal','sale','sale_refund','purchase_payment','vendor_refund','cost_adjustment'));--> statement-breakpoint

ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idem_key_length"
  CHECK (char_length("key") BETWEEN 8 AND 100);--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idem_status_valid"
  CHECK ("status" IN ('in_progress','succeeded','failed'));--> statement-breakpoint

-- --- Case-insensitive vendor uniqueness (T017) -----------------------------
-- An expression index, which drizzle-kit cannot express.
CREATE UNIQUE INDEX "vendors_name_lower_idx" ON "vendors" (lower("name"));--> statement-breakpoint

-- --- Append-only enforcement (T018) ----------------------------------------
-- Database-enforced, not convention (Constitution Principle II, FR-042).

CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;--> statement-breakpoint

-- Tier 1 — fully immutable. Corrections are new reversing rows, never edits.
CREATE TRIGGER "stock_movements_append_only" BEFORE UPDATE OR DELETE ON "stock_movements"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();--> statement-breakpoint
CREATE TRIGGER "capital_events_append_only" BEFORE UPDATE OR DELETE ON "capital_events"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();--> statement-breakpoint
CREATE TRIGGER "cash_events_append_only" BEFORE UPDATE OR DELETE ON "cash_events"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();--> statement-breakpoint

-- Tier 2 — delete-protected only. These tables have columns that legitimately advance:
--   sales.status / voided_*      as returns and voids are recorded
--   sale_lines.qty_returned      as units come back
--   batches.qty_remaining        on every sale, plus the cost columns on correction
--   funding_allocations.*        re-balanced whenever total_cost_minor changes (FR-026)
--
-- A BEFORE UPDATE trigger on funding_allocations would make addLandedCost throw on EVERY call.
-- Delete protection is what FR-042 actually requires; immutability would contradict FR-026.
CREATE TRIGGER "sales_no_delete" BEFORE DELETE ON "sales"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();--> statement-breakpoint
CREATE TRIGGER "sale_lines_no_delete" BEFORE DELETE ON "sale_lines"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();--> statement-breakpoint
CREATE TRIGGER "batches_no_delete" BEFORE DELETE ON "batches"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();--> statement-breakpoint
CREATE TRIGGER "funding_allocations_no_delete" BEFORE DELETE ON "funding_allocations"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint

-- Sale numbering (T061). A SEQUENCE, not MAX(...) over the sales table.
--
-- The first implementation derived the next number with
--   MAX(CAST(regexp_replace(sale_number, '\D', '', 'g') AS BIGINT)) + 1
-- which runs a regexp over EVERY existing sale on EVERY new sale. That is invisible in testing
-- and linear in a year of trading — exactly the kind of cost that makes a till get slower and
-- slower with no single change to blame.
--
-- nextval() is O(1) and concurrency-safe. It is deliberately non-transactional, so a rolled-back
-- sale burns a number and leaves a gap. That is the right trade here: sale_number is a HUMAN
-- REFERENCE, not an invoice number, and a gap honestly records that an attempt happened.
CREATE SEQUENCE sale_number_seq AS BIGINT START WITH 1 INCREMENT BY 1;
