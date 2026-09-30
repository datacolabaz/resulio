ALTER TABLE `users` ADD `preferredLocale` varchar(8) DEFAULT 'az';--> statement-breakpoint
ALTER TABLE `users` ADD `appRole` enum('TEACHER','STUDENT');
