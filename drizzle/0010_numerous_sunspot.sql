ALTER TYPE "public"."officer_role" ADD VALUE 'director' BEFORE 'other';--> statement-breakpoint
CREATE TABLE "org_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"corp_type" text,
	"tax_status" text,
	"is_527" boolean,
	"ein" text,
	"doc_number" text,
	"status" text,
	"filed_date" date,
	"address" text,
	"registered_agent" text,
	"mission" text,
	"website" text,
	"board" jsonb,
	"financials" jsonb,
	"donors_restricted" boolean,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_profiles" ADD CONSTRAINT "org_profiles_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "org_profiles_entity_key" ON "org_profiles" USING btree ("entity_id");