-- 手动加在生成的迁移前面：gin_trgm_ops 索引依赖 pg_trgm。
-- docker/init 只在数据卷首次创建时执行，对已有库或托管 Postgres 不生效，
-- 所以迁移自己要保证前置条件。重新生成迁移后需要把这行加回来。
--
-- 这份迁移是 DB_GEO_MODE=plain 生成的：location 是 jsonb，不需要 PostGIS。
-- 生产环境应该用 postgis 模式重新生成，那时还要加 CREATE EXTENSION postgis。
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TYPE "public"."agent_run_status" AS ENUM('running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."item_kind" AS ENUM('visit', 'meal', 'hotel_checkin', 'hotel_checkout', 'transfer');--> statement-breakpoint
CREATE TYPE "public"."poi_kind" AS ENUM('attraction', 'hotel', 'restaurant', 'transit');--> statement-breakpoint
CREATE TYPE "public"."poi_source" AS ENUM('amap', 'curated', 'user');--> statement-breakpoint
CREATE TYPE "public"."price_source" AS ENUM('formula', 'llm', 'search', 'ota');--> statement-breakpoint
CREATE TYPE "public"."travel_mode" AS ENUM('driving', 'transit', 'walking', 'cycling');--> statement-breakpoint
CREATE TYPE "public"."trip_status" AS ENUM('draft_pois', 'draft_hotel', 'routing', 'planned', 'stale', 'archived');--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid,
	"user_id" uuid,
	"task" varchar(32) NOT NULL,
	"status" "agent_run_status" DEFAULT 'running' NOT NULL,
	"model" varchar(64),
	"user_message" text,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pois" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "poi_kind" NOT NULL,
	"source" "poi_source" NOT NULL,
	"external_id" varchar(64),
	"name" text NOT NULL,
	"city" varchar(64) NOT NULL,
	"district" varchar(64),
	"address" text,
	"location" jsonb NOT NULL,
	"dwell_minutes" integer,
	"rating" real,
	"tags" text[] DEFAULT ARRAY[]::text[],
	"opening_hours" jsonb,
	"brand" varchar(64),
	"star_rating" smallint,
	"price_min_cents" integer,
	"price_max_cents" integer,
	"price_source" "price_source" DEFAULT 'formula' NOT NULL,
	"price_basis" text[] DEFAULT ARRAY[]::text[],
	"price_citations" jsonb,
	"price_updated_at" timestamp with time zone,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trip_days" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"day_index" smallint NOT NULL,
	"date" date,
	"theme" text,
	"tip" text,
	"distance_meters" integer,
	"travel_minutes" integer
);
--> statement-breakpoint
CREATE TABLE "trip_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_day_id" uuid NOT NULL,
	"seq" smallint NOT NULL,
	"kind" "item_kind" NOT NULL,
	"poi_id" uuid,
	"arrive_at" varchar(5),
	"depart_at" varchar(5),
	"leg_mode" "travel_mode",
	"leg_distance_meters" integer,
	"leg_minutes" integer,
	"leg_polyline" jsonb,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "trip_pois" (
	"trip_id" uuid NOT NULL,
	"poi_id" uuid NOT NULL,
	"priority" smallint DEFAULT 3 NOT NULL,
	"pinned_day_index" smallint,
	"dwell_minutes_override" integer,
	"added_by" "poi_source" NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"city" varchar(64) NOT NULL,
	"status" "trip_status" DEFAULT 'draft_pois' NOT NULL,
	"start_date" date,
	"end_date" date,
	"party_size" smallint DEFAULT 2 NOT NULL,
	"hotel_budget_cents" integer,
	"budget_per_night" boolean DEFAULT true NOT NULL,
	"preferred_brands" text[] DEFAULT ARRAY[]::text[],
	"hotel_poi_id" uuid,
	"default_travel_mode" "travel_mode" DEFAULT 'transit' NOT NULL,
	"day_start_time" varchar(5) DEFAULT '09:00' NOT NULL,
	"day_end_time" varchar(5) DEFAULT '21:00' NOT NULL,
	"route_summary" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" varchar(20),
	"email" varchar(255),
	"display_name" text,
	"preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_phone_unique" UNIQUE("phone"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_days" ADD CONSTRAINT "trip_days_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_items" ADD CONSTRAINT "trip_items_trip_day_id_trip_days_id_fk" FOREIGN KEY ("trip_day_id") REFERENCES "public"."trip_days"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_items" ADD CONSTRAINT "trip_items_poi_id_pois_id_fk" FOREIGN KEY ("poi_id") REFERENCES "public"."pois"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_pois" ADD CONSTRAINT "trip_pois_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_pois" ADD CONSTRAINT "trip_pois_poi_id_pois_id_fk" FOREIGN KEY ("poi_id") REFERENCES "public"."pois"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_hotel_poi_id_pois_id_fk" FOREIGN KEY ("hotel_poi_id") REFERENCES "public"."pois"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_trip_idx" ON "agent_runs" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "agent_runs_task_status_idx" ON "agent_runs" USING btree ("task","status");--> statement-breakpoint
CREATE INDEX "pois_location_lat_idx" ON "pois" USING btree (("location"->>'lat'));--> statement-breakpoint
CREATE INDEX "pois_location_lng_idx" ON "pois" USING btree (("location"->>'lng'));--> statement-breakpoint
CREATE INDEX "pois_kind_city_idx" ON "pois" USING btree ("kind","city");--> statement-breakpoint
CREATE INDEX "pois_name_trgm" ON "pois" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "pois_source_external_uniq" ON "pois" USING btree ("source","external_id") WHERE "pois"."external_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "trip_days_uniq" ON "trip_days" USING btree ("trip_id","day_index");--> statement-breakpoint
CREATE UNIQUE INDEX "trip_items_seq_uniq" ON "trip_items" USING btree ("trip_day_id","seq");--> statement-breakpoint
CREATE INDEX "trip_items_day_idx" ON "trip_items" USING btree ("trip_day_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trip_pois_pk" ON "trip_pois" USING btree ("trip_id","poi_id");--> statement-breakpoint
CREATE INDEX "trip_pois_trip_idx" ON "trip_pois" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "trips_user_status_idx" ON "trips" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "users_phone_idx" ON "users" USING btree ("phone");