CREATE TYPE "public"."alias_origin" AS ENUM('registry', 'observed', 'resolved', 'manual');--> statement-breakpoint
CREATE TYPE "public"."committee_type" AS ENUM('PAC', 'CCE', 'ECO', 'ECI', 'IXO', 'PAP', 'PTY');--> statement-breakpoint
CREATE TYPE "public"."entity_kind" AS ENUM('committee', 'candidate', 'individual', 'organization', 'party', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."entity_status" AS ENUM('active', 'closed', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."ingest_run_status" AS ENUM('running', 'succeeded', 'failed', 'partial');--> statement-breakpoint
CREATE TYPE "public"."jurisdiction_level" AS ENUM('federal', 'state', 'county', 'municipal', 'special_district');--> statement-breakpoint
CREATE TYPE "public"."txn_direction" AS ENUM('contribution', 'expenditure');--> statement-breakpoint
CREATE TABLE "edge_rollups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_entity_id" uuid NOT NULL,
	"to_entity_id" uuid NOT NULL,
	"total_amount" numeric(16, 2) NOT NULL,
	"txn_count" integer NOT NULL,
	"first_date" date,
	"last_date" date,
	"is_direct_link" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "entity_kind" DEFAULT 'unknown' NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"committee_type" "committee_type",
	"status" "entity_status" DEFAULT 'unknown' NOT NULL,
	"jurisdiction_id" uuid,
	"office" text,
	"district" text,
	"party" text,
	"address" text,
	"city" text,
	"state_code" text,
	"zip" text,
	"occupation" text,
	"is_traversable" boolean DEFAULT false NOT NULL,
	"source_id" uuid,
	"source_ref" text,
	"total_received" numeric(16, 2) DEFAULT '0' NOT NULL,
	"total_given" numeric(16, 2) DEFAULT '0' NOT NULL,
	"in_degree" integer DEFAULT 0 NOT NULL,
	"out_degree" integer DEFAULT 0 NOT NULL,
	"first_seen" date,
	"last_seen" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"normalized_alias" text NOT NULL,
	"origin" "alias_origin" DEFAULT 'observed' NOT NULL,
	"confidence" real DEFAULT 1 NOT NULL,
	"is_truncated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingest_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"status" "ingest_run_status" DEFAULT 'running' NOT NULL,
	"scope" jsonb,
	"rows_fetched" integer DEFAULT 0 NOT NULL,
	"rows_inserted" integer DEFAULT 0 NOT NULL,
	"rows_skipped" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "jurisdictions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"level" "jurisdiction_level" NOT NULL,
	"state" text DEFAULT 'FL' NOT NULL,
	"parent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_searches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"seed_entity_id" uuid NOT NULL,
	"params" jsonb NOT NULL,
	"node_positions" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"url" text,
	"jurisdiction_id" uuid,
	"last_run_at" timestamp with time zone,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_entity_id" uuid,
	"to_entity_id" uuid,
	"raw_from_name" text NOT NULL,
	"raw_to_name" text NOT NULL,
	"amount" numeric(16, 2) NOT NULL,
	"txn_date" date,
	"direction" "txn_direction" DEFAULT 'contribution' NOT NULL,
	"txn_type_code" text,
	"inkind_description" text,
	"election_cycle" text,
	"from_address" text,
	"from_city" text,
	"from_state" text,
	"from_zip" text,
	"from_occupation" text,
	"source_id" uuid,
	"source_row_hash" text NOT NULL,
	"from_confidence" real DEFAULT 0 NOT NULL,
	"to_confidence" real DEFAULT 0 NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "edge_rollups" ADD CONSTRAINT "edge_rollups_from_entity_id_entities_id_fk" FOREIGN KEY ("from_entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge_rollups" ADD CONSTRAINT "edge_rollups_to_entity_id_entities_id_fk" FOREIGN KEY ("to_entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_jurisdiction_id_jurisdictions_id_fk" FOREIGN KEY ("jurisdiction_id") REFERENCES "public"."jurisdictions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_aliases" ADD CONSTRAINT "entity_aliases_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_runs" ADD CONSTRAINT "ingest_runs_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_searches" ADD CONSTRAINT "saved_searches_seed_entity_id_entities_id_fk" FOREIGN KEY ("seed_entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_jurisdiction_id_jurisdictions_id_fk" FOREIGN KEY ("jurisdiction_id") REFERENCES "public"."jurisdictions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_from_entity_id_entities_id_fk" FOREIGN KEY ("from_entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_to_entity_id_entities_id_fk" FOREIGN KEY ("to_entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "edge_rollups_pair_key" ON "edge_rollups" USING btree ("from_entity_id","to_entity_id");--> statement-breakpoint
CREATE INDEX "edge_rollups_to_amount_idx" ON "edge_rollups" USING btree ("to_entity_id","total_amount");--> statement-breakpoint
CREATE INDEX "edge_rollups_from_amount_idx" ON "edge_rollups" USING btree ("from_entity_id","total_amount");--> statement-breakpoint
CREATE INDEX "edge_rollups_direct_idx" ON "edge_rollups" USING btree ("is_direct_link");--> statement-breakpoint
CREATE INDEX "entities_normalized_name_idx" ON "entities" USING btree ("normalized_name");--> statement-breakpoint
CREATE INDEX "entities_kind_idx" ON "entities" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "entities_traversable_idx" ON "entities" USING btree ("is_traversable");--> statement-breakpoint
CREATE INDEX "entities_jurisdiction_idx" ON "entities" USING btree ("jurisdiction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "entity_aliases_entity_norm_key" ON "entity_aliases" USING btree ("entity_id","normalized_alias");--> statement-breakpoint
CREATE INDEX "entity_aliases_norm_idx" ON "entity_aliases" USING btree ("normalized_alias");--> statement-breakpoint
CREATE INDEX "ingest_runs_source_idx" ON "ingest_runs" USING btree ("source_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jurisdictions_code_key" ON "jurisdictions" USING btree ("code");--> statement-breakpoint
CREATE INDEX "saved_searches_seed_idx" ON "saved_searches" USING btree ("seed_entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_key_key" ON "sources" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_row_hash_key" ON "transactions" USING btree ("source_row_hash");--> statement-breakpoint
CREATE INDEX "transactions_from_idx" ON "transactions" USING btree ("from_entity_id");--> statement-breakpoint
CREATE INDEX "transactions_to_idx" ON "transactions" USING btree ("to_entity_id");--> statement-breakpoint
CREATE INDEX "transactions_date_idx" ON "transactions" USING btree ("txn_date");--> statement-breakpoint
CREATE INDEX "transactions_amount_idx" ON "transactions" USING btree ("amount");--> statement-breakpoint
CREATE INDEX "transactions_to_from_amount_idx" ON "transactions" USING btree ("to_entity_id","from_entity_id","amount");--> statement-breakpoint
CREATE INDEX "transactions_from_to_amount_idx" ON "transactions" USING btree ("from_entity_id","to_entity_id","amount");