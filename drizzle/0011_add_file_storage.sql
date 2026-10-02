CREATE TABLE `files` (
	`id` varchar(32) NOT NULL,
	`workspaceId` varchar(32) NOT NULL,
	`uploadedBy` int NOT NULL,
	`fileName` varchar(255) NOT NULL,
	`mimeType` varchar(127) NOT NULL,
	`sizeBytes` int NOT NULL,
	`dataBase64` longtext NOT NULL,
	`isPublic` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `files_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `materials` ADD `fileId` varchar(32);--> statement-breakpoint
ALTER TABLE `materials` ADD `mimeType` varchar(127);--> statement-breakpoint
ALTER TABLE `materials` ADD `sizeBytes` int;--> statement-breakpoint
CREATE INDEX `files_workspace_idx` ON `files` (`workspaceId`);