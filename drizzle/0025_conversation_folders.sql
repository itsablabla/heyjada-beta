CREATE TABLE "conversation_folder" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"parent_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "folder_id" uuid;--> statement-breakpoint
ALTER TABLE "conversation_folder" ADD CONSTRAINT "conversation_folder_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_folder" ADD CONSTRAINT "conversation_folder_parent_id_conversation_folder_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."conversation_folder"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_folder_user_id_idx" ON "conversation_folder" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "conversation_folder_parent_id_idx" ON "conversation_folder" USING btree ("parent_id");--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_folder_id_conversation_folder_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."conversation_folder"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_folder_id_idx" ON "conversation" USING btree ("folder_id");