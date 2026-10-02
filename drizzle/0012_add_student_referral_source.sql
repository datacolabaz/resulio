ALTER TABLE `users` ADD `referralSource` enum('INSTAGRAM','FACEBOOK','TIKTOK','GOOGLE_SEARCH','REFERRAL','OTHER');--> statement-breakpoint
ALTER TABLE `users` ADD `referrerUserId` int;--> statement-breakpoint
ALTER TABLE `users` ADD `referrerName` varchar(160);