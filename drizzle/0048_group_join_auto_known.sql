ALTER TABLE `group_join_settings` ADD `autoApproveKnown` boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `group_member_sources` ADD `autoReason` varchar(32);