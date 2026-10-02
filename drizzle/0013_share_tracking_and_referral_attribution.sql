CREATE TABLE `referral_attributions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`partnerId` int NOT NULL,
	`referralCode` varchar(32) NOT NULL,
	`channel` enum('TELEGRAM','WHATSAPP','COPY_LINK','QR','DIRECT') NOT NULL DEFAULT 'DIRECT',
	`campaign` varchar(40),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `referral_attributions_id` PRIMARY KEY(`id`),
	CONSTRAINT `referral_attributions_userId_unique` UNIQUE(`userId`)
);
--> statement-breakpoint
CREATE TABLE `share_events` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`targetType` enum('GROUP','TASK','EXAM','MATERIAL','REFERRAL') NOT NULL,
	`targetId` varchar(64) NOT NULL,
	`channel` enum('TELEGRAM','WHATSAPP','COPY_LINK','QR','DIRECT') NOT NULL DEFAULT 'DIRECT',
	`eventType` enum('CLICKED','OPENED','JOINED') NOT NULL,
	`campaign` varchar(40),
	`actorUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `share_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `users` ADD `referralOnboardingSeenAt` timestamp;--> statement-breakpoint
ALTER TABLE `users` ADD `referralCardDismissedAt` timestamp;--> statement-breakpoint
CREATE INDEX `referral_attributions_partner_idx` ON `referral_attributions` (`partnerId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `share_events_target_idx` ON `share_events` (`targetType`,`targetId`,`createdAt`);