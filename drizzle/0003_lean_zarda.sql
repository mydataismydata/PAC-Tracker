CREATE TYPE "public"."officer_role" AS ENUM('chair', 'treasurer', 'deputy_treasurer', 'registered_agent', 'other');--> statement-breakpoint
CREATE TABLE "committee_officers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"source_id" uuid,
	"role" "officer_role" NOT NULL,
	"name_last" text,
	"name_first" text,
	"name_middle" text,
	"full_name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"address" text,
	"city" text,
	"state_code" text,
	"zip" text,
	"phone" text,
	"email" text,
	"document_url" text,
	"effective_date" date,
	"expired_date" date,
	"is_current" boolean DEFAULT true NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "committee_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"source_id" uuid,
	"external_id" text,
	"committee_type" text,
	"type_description" text,
	"status" text,
	"addr1" text,
	"addr2" text,
	"city" text,
	"state_code" text,
	"zip" text,
	"county_name" text,
	"normalized_address" text,
	"phone" text,
	"phone_digits" text,
	"email" text,
	"website" text,
	"effective_date" date,
	"expired_date" date,
	"is_current" boolean DEFAULT true NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "committee_officers" ADD CONSTRAINT "committee_officers_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "committee_officers" ADD CONSTRAINT "committee_officers_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "committee_registrations" ADD CONSTRAINT "committee_registrations_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "committee_registrations" ADD CONSTRAINT "committee_registrations_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "committee_officers_current_key" ON "committee_officers" USING btree ("entity_id","source_id","role","normalized_name") WHERE is_current;--> statement-breakpoint
CREATE INDEX "committee_officers_entity_idx" ON "committee_officers" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "committee_officers_name_idx" ON "committee_officers" USING btree ("normalized_name");--> statement-breakpoint
CREATE UNIQUE INDEX "committee_registrations_current_key" ON "committee_registrations" USING btree ("entity_id","source_id") WHERE is_current;--> statement-breakpoint
CREATE INDEX "committee_registrations_entity_idx" ON "committee_registrations" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "committee_registrations_address_idx" ON "committee_registrations" USING btree ("normalized_address");--> statement-breakpoint
CREATE INDEX "committee_registrations_phone_idx" ON "committee_registrations" USING btree ("phone_digits");--> statement-breakpoint
CREATE INDEX "committee_registrations_external_idx" ON "committee_registrations" USING btree ("external_id");