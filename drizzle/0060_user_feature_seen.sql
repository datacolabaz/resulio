CREATE TABLE IF NOT EXISTS `user_feature_seen` (
	`userId` int NOT NULL,
	`featureId` varchar(64) NOT NULL,
	`seenAt` timestamp,
	`dismissedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `user_feature_seen_userId_featureId_pk` PRIMARY KEY(`userId`,`featureId`)
);
