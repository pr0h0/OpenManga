CREATE INDEX "ai_usage_job_idx" ON "ai_usage" USING btree ("generation_job_id");--> statement-breakpoint
CREATE INDEX "assets_generation_job_idx" ON "assets" USING btree ("generation_job_id");--> statement-breakpoint
CREATE INDEX "assets_parent_idx" ON "assets" USING btree ("parent_asset_id");--> statement-breakpoint
CREATE INDEX "audio_assets_asset_idx" ON "audio_assets" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "audio_assets_segment_idx" ON "audio_assets" USING btree ("segment_id");--> statement-breakpoint
CREATE INDEX "audio_jobs_segment_idx" ON "audio_jobs" USING btree ("segment_id");--> statement-breakpoint
CREATE INDEX "generation_inputs_asset_idx" ON "generation_inputs" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "generation_outputs_asset_idx" ON "generation_outputs" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "narration_lines_project_idx" ON "narration_lines" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "narration_lines_page_idx" ON "narration_lines" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "narration_lines_panel_idx" ON "narration_lines" USING btree ("panel_id");--> statement-breakpoint
CREATE INDEX "narration_segments_project_idx" ON "narration_segments" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "narration_segments_audio_idx" ON "narration_segments" USING btree ("active_audio_asset_id");--> statement-breakpoint
CREATE INDEX "outfit_assignments_panel_idx" ON "outfit_assignments" USING btree ("panel_id");--> statement-breakpoint
CREATE INDEX "pages_project_idx" ON "pages" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "panels_artwork_idx" ON "panels" USING btree ("active_artwork_asset_id");--> statement-breakpoint
CREATE INDEX "panels_scene_idx" ON "panels" USING btree ("scene_id");--> statement-breakpoint
CREATE INDEX "story_beats_project_idx" ON "story_beats" USING btree ("project_id");