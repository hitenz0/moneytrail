CREATE TABLE `bills` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`amount` text NOT NULL,
	`cadence` text NOT NULL,
	`next_due` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`payment_method` text DEFAULT 'manual' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`anchor_day` integer NOT NULL,
	`anchor_month` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`last_paid_due` text DEFAULT '' NOT NULL,
	`last_paid_on` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `datasets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`fingerprint` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `datasets_owner_fingerprint` ON `datasets` (`user_id`,`fingerprint`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`dataset_id` integer NOT NULL,
	`id` text NOT NULL,
	`date` text NOT NULL,
	`description` text NOT NULL,
	`amount` text NOT NULL,
	`account` text NOT NULL,
	`kind` text NOT NULL,
	`category` text NOT NULL,
	`refund_expected` text NOT NULL,
	`refund_for` text NOT NULL,
	`refund_due` text DEFAULT '' NOT NULL,
	`refund_note` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`dataset_id`) REFERENCES `datasets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_dataset_id` ON `transactions` (`dataset_id`,`id`);