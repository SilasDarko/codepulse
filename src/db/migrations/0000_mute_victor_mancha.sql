CREATE TYPE "public"."candidate_type" AS ENUM('commit', 'pull_request');--> statement-breakpoint
CREATE TYPE "public"."ci_conclusion" AS ENUM('success', 'failure', 'cancelled', 'skipped', 'pending');--> statement-breakpoint
CREATE TYPE "public"."deployment_status" AS ENUM('in_progress', 'succeeded', 'failed', 'rolled_back');--> statement-breakpoint
CREATE TYPE "public"."health_status" AS ENUM('healthy', 'degraded', 'down');--> statement-breakpoint
CREATE TYPE "public"."incident_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TABLE "benchmark_ground_truth" (
	"id" serial PRIMARY KEY NOT NULL,
	"incident_id" integer NOT NULL,
	"causative_commit_sha" text NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ci_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"ci_run_id" integer NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"conclusion" "ci_conclusion"
);
--> statement-breakpoint
CREATE TABLE "ci_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"repo_id" integer NOT NULL,
	"pull_request_id" integer,
	"external_id" text NOT NULL,
	"commit_sha" text NOT NULL,
	"workflow_name" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"conclusion" "ci_conclusion",
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "commit_files" (
	"id" serial PRIMARY KEY NOT NULL,
	"commit_id" integer NOT NULL,
	"file_path" text NOT NULL,
	"status" text DEFAULT 'modified' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commits" (
	"id" serial PRIMARY KEY NOT NULL,
	"repo_id" integer NOT NULL,
	"sha" text NOT NULL,
	"parent_shas" text[] DEFAULT '{}' NOT NULL,
	"author_name" text,
	"author_email" text,
	"message" text DEFAULT '' NOT NULL,
	"committed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "correlation_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"incident_id" integer NOT NULL,
	"candidate_type" "candidate_type" NOT NULL,
	"candidate_ref" text NOT NULL,
	"score" real NOT NULL,
	"score_breakdown" jsonb NOT NULL,
	"rank" integer NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployment_steps" (
	"id" serial PRIMARY KEY NOT NULL,
	"deployment_id" integer NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'succeeded' NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_id" integer NOT NULL,
	"external_id" text NOT NULL,
	"from_sha" text,
	"to_sha" text NOT NULL,
	"status" "deployment_status" DEFAULT 'succeeded' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "health_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_id" integer NOT NULL,
	"external_id" text NOT NULL,
	"status" "health_status" NOT NULL,
	"metric_name" text,
	"metric_value" real,
	"observed_at" timestamp with time zone NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_id" integer NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"first_unhealthy_event_id" integer,
	"status" "incident_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingestion_checkpoints" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"repo_id" integer NOT NULL,
	"cursor" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pull_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"repo_id" integer NOT NULL,
	"number" integer NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"author_login" text,
	"base_sha" text,
	"head_sha" text,
	"additions" integer DEFAULT 0 NOT NULL,
	"deletions" integer DEFAULT 0 NOT NULL,
	"changed_files_count" integer DEFAULT 0 NOT NULL,
	"labels" text[] DEFAULT '{}' NOT NULL,
	"merged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"github_id" integer,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" serial PRIMARY KEY NOT NULL,
	"repo_id" integer NOT NULL,
	"name" text NOT NULL,
	"path_patterns" text[] DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "benchmark_ground_truth" ADD CONSTRAINT "benchmark_ground_truth_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_jobs" ADD CONSTRAINT "ci_jobs_ci_run_id_ci_runs_id_fk" FOREIGN KEY ("ci_run_id") REFERENCES "public"."ci_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD CONSTRAINT "ci_runs_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD CONSTRAINT "ci_runs_pull_request_id_pull_requests_id_fk" FOREIGN KEY ("pull_request_id") REFERENCES "public"."pull_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commit_files" ADD CONSTRAINT "commit_files_commit_id_commits_id_fk" FOREIGN KEY ("commit_id") REFERENCES "public"."commits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commits" ADD CONSTRAINT "commits_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correlation_results" ADD CONSTRAINT "correlation_results_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_steps" ADD CONSTRAINT "deployment_steps_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_events" ADD CONSTRAINT "health_events_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_first_unhealthy_event_id_health_events_id_fk" FOREIGN KEY ("first_unhealthy_event_id") REFERENCES "public"."health_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_checkpoints" ADD CONSTRAINT "ingestion_checkpoints_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ci_jobs_ci_run_id_idx" ON "ci_jobs" USING btree ("ci_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ci_runs_repo_external_id_idx" ON "ci_runs" USING btree ("repo_id","external_id");--> statement-breakpoint
CREATE INDEX "ci_runs_commit_sha_idx" ON "ci_runs" USING btree ("commit_sha");--> statement-breakpoint
CREATE INDEX "commit_files_commit_id_idx" ON "commit_files" USING btree ("commit_id");--> statement-breakpoint
CREATE INDEX "commit_files_path_idx" ON "commit_files" USING btree ("file_path");--> statement-breakpoint
CREATE UNIQUE INDEX "commits_repo_sha_idx" ON "commits" USING btree ("repo_id","sha");--> statement-breakpoint
CREATE INDEX "commits_committed_at_idx" ON "commits" USING btree ("committed_at");--> statement-breakpoint
CREATE INDEX "correlation_results_incident_id_idx" ON "correlation_results" USING btree ("incident_id","rank");--> statement-breakpoint
CREATE INDEX "deployment_steps_deployment_id_idx" ON "deployment_steps" USING btree ("deployment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deployments_service_external_id_idx" ON "deployments" USING btree ("service_id","external_id");--> statement-breakpoint
CREATE INDEX "deployments_started_at_idx" ON "deployments" USING btree ("started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "health_events_service_external_id_idx" ON "health_events" USING btree ("service_id","external_id");--> statement-breakpoint
CREATE INDEX "health_events_observed_at_idx" ON "health_events" USING btree ("observed_at");--> statement-breakpoint
CREATE INDEX "incidents_service_opened_at_idx" ON "incidents" USING btree ("service_id","opened_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ingestion_checkpoints_source_repo_idx" ON "ingestion_checkpoints" USING btree ("source","repo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pull_requests_repo_number_idx" ON "pull_requests" USING btree ("repo_id","number");--> statement-breakpoint
CREATE INDEX "pull_requests_merged_at_idx" ON "pull_requests" USING btree ("merged_at");--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_owner_name_idx" ON "repositories" USING btree ("owner","name");--> statement-breakpoint
CREATE UNIQUE INDEX "services_repo_name_idx" ON "services" USING btree ("repo_id","name");