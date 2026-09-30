ALTER TABLE `users` ADD `timezone` varchar(64);--> statement-breakpoint
ALTER TABLE `users` ADD `targetExam` varchar(64);--> statement-breakpoint
ALTER TABLE `users` ADD `targetScore` varchar(32);--> statement-breakpoint
ALTER TABLE `users` ADD `targetExamDate` timestamp;--> statement-breakpoint
ALTER TABLE `users` ADD `studentOnboardedAt` timestamp;