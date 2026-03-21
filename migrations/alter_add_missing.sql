-- ============================================================
-- PATCH: Add missing columns and tables
-- Run this on the live database to apply schema fixes
-- ============================================================

-- 1. Add tax_enabled column to orders table (used by recalcOrder and generateBill)
ALTER TABLE `orders` ADD COLUMN IF NOT EXISTS `tax_enabled` TINYINT(1) NOT NULL DEFAULT 1 AFTER `bill_number`;

-- 2. Add active_session_id column to users (single-session enforcement)
ALTER TABLE `users` ADD COLUMN IF NOT EXISTS `active_session_id` VARCHAR(64) NULL AFTER `section_access`;

-- 3. Create qr_sessions table (used by QR ordering flow)
CREATE TABLE IF NOT EXISTS `qr_sessions` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `restaurant_id` INT NOT NULL,
  `table_id` INT NOT NULL,
  `session_token` VARCHAR(255) NOT NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Add kitchen_staff to users role enum
ALTER TABLE `users` MODIFY COLUMN `role` ENUM('super_admin','owner','manager','cashier','waiter','kitchen_staff') NOT NULL;

-- 5. Add discount_amount column to order_items table
ALTER TABLE `order_items` ADD COLUMN IF NOT EXISTS `discount_amount` DECIMAL(10,2) NOT NULL DEFAULT 0 AFTER `tax_amount`;

-- 6. Add amount_received column to payments table
ALTER TABLE `payments` ADD COLUMN IF NOT EXISTS `amount_received` DECIMAL(10,2) NULL AFTER `amount`;

-- 7. Add adjusted_advances and adjusted_outstanding columns to salary_records table
ALTER TABLE `salary_records` ADD COLUMN IF NOT EXISTS `adjusted_advances` DECIMAL(10,2) NOT NULL DEFAULT 0 AFTER `bonuses`;
ALTER TABLE `salary_records` ADD COLUMN IF NOT EXISTS `adjusted_outstanding` DECIMAL(10,2) NOT NULL DEFAULT 0 AFTER `adjusted_advances`;

-- 8. Add floor_id column to orders table (if missing on older installs)
ALTER TABLE `orders` ADD COLUMN IF NOT EXISTS `floor_id` INT NULL AFTER `table_id`;

-- 9. Add bill_prefix and bill_counter to restaurants table
ALTER TABLE `restaurants` ADD COLUMN IF NOT EXISTS `bill_prefix` VARCHAR(10) NOT NULL DEFAULT 'INV' AFTER `name`;
ALTER TABLE `restaurants` ADD COLUMN IF NOT EXISTS `bill_counter` INT NOT NULL DEFAULT 0 AFTER `bill_prefix`;

-- 10. Rename restaurant types: dine_in → poss, qsr → qr
ALTER TABLE `restaurants` MODIFY COLUMN `type` VARCHAR(50) NOT NULL DEFAULT 'poss';
UPDATE `restaurants` SET `type` = 'poss' WHERE `type` = 'dine_in';
UPDATE `restaurants` SET `type` = 'qr' WHERE `type` = 'qsr';

-- 11. Create qr_settings table for QR model restaurants
CREATE TABLE IF NOT EXISTS `qr_settings` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `restaurant_id` INT NOT NULL UNIQUE,
  `enable_dine_in` TINYINT(1) NOT NULL DEFAULT 1,
  `enable_takeaway` TINYINT(1) NOT NULL DEFAULT 1,
  `enable_delivery` TINYINT(1) NOT NULL DEFAULT 0,
  `payment_acceptance` VARCHAR(50) NOT NULL DEFAULT 'both',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 13. Add target_type column to plans table
ALTER TABLE `plans` ADD COLUMN IF NOT EXISTS `target_type` VARCHAR(20) DEFAULT NULL AFTER `is_default`;

-- 14. Set existing POSS plans target_type and seed QR plan
UPDATE `plans` SET `target_type` = 'poss' WHERE `target_type` IS NULL AND `id` IN (1, 2, 3);
INSERT INTO `plans` (`id`, `name`, `description`, `price_monthly`, `price_yearly`, `max_floors`, `max_tables`, `max_menu_items`, `max_staff`, `max_bills_per_day`, `max_bills_per_month`, `feature_waiter_app`, `feature_online_ordering`, `feature_reservations`, `feature_inventory`, `feature_expense_management`, `feature_employee_management`, `feature_kds`, `feature_analytics`, `is_active`, `is_default`, `target_type`, `sort_order`)
VALUES
  (4, 'QR Ordering', 'QR-based ordering for dine-in, takeaway and delivery.', 499.00, 4990.00, 2, 20, 200, 3, 500, 10000, false, true, false, false, false, false, true, false, true, true, 'qr', 4)
ON DUPLICATE KEY UPDATE `updated_at` = CURRENT_TIMESTAMP;

-- 15. Add wa_tokens column to restaurants table (WhatsApp messaging token balance)
ALTER TABLE `restaurants` ADD COLUMN IF NOT EXISTS `wa_tokens` INT NOT NULL DEFAULT 0 AFTER `bill_counter`;

-- 16. Add enable_tax column to qr_settings table
ALTER TABLE `qr_settings` ADD COLUMN IF NOT EXISTS `enable_tax` TINYINT(1) NOT NULL DEFAULT 1 AFTER `payment_acceptance`;

-- 17. Add online payment tracking columns to qr_orders
ALTER TABLE `qr_orders` ADD COLUMN IF NOT EXISTS `razorpay_order_id` VARCHAR(255) NULL AFTER `payment_preference`;
ALTER TABLE `qr_orders` ADD COLUMN IF NOT EXISTS `razorpay_payment_id` VARCHAR(255) NULL AFTER `razorpay_order_id`;

-- 12. Add order_type and delivery_address to qr_orders, make table_id and session_token nullable
ALTER TABLE `qr_orders` MODIFY COLUMN `table_id` INT NULL;
ALTER TABLE `qr_orders` MODIFY COLUMN `session_token` VARCHAR(255) NULL;
ALTER TABLE `qr_orders` ADD COLUMN IF NOT EXISTS `order_type` VARCHAR(50) NOT NULL DEFAULT 'dine_in' AFTER `table_id`;
ALTER TABLE `qr_orders` ADD COLUMN IF NOT EXISTS `delivery_address` TEXT NULL AFTER `customer_phone`;

-- 18. Track refund status on rejected QR orders
ALTER TABLE `qr_orders` ADD COLUMN IF NOT EXISTS `refund_status` VARCHAR(20) NULL AFTER `razorpay_payment_id`;

-- 20. Store tax-enabled flag at order placement time on qr_orders
ALTER TABLE `qr_orders` ADD COLUMN IF NOT EXISTS `tax_enabled` TINYINT(1) NOT NULL DEFAULT 1 AFTER `refund_status`;

-- 19. Fix qr_orders status column — was ENUM missing 'fulfilled', change to VARCHAR
ALTER TABLE `qr_orders` MODIFY COLUMN `status` VARCHAR(50) NOT NULL DEFAULT 'pending';
-- Fix any corrupted rows from the old ENUM silently dropping 'fulfilled'
UPDATE `qr_orders` SET `status` = 'fulfilled' WHERE `status` = '' AND `linked_order_id` IS NOT NULL;

-- 21. Add e-bill token column to orders table
ALTER TABLE `orders` ADD COLUMN IF NOT EXISTS `ebill_token` VARCHAR(64) NULL AFTER `tax_enabled`;

-- Change wa_tokens from INT to DECIMAL to support fractional token costs
ALTER TABLE `restaurants` MODIFY COLUMN `wa_tokens` DECIMAL(10,1) NOT NULL DEFAULT 0;

-- 22. Add WA messaging mode and Google Review URL to restaurants
ALTER TABLE `restaurants` ADD COLUMN IF NOT EXISTS `wa_messaging_mode` TINYINT NOT NULL DEFAULT 1 AFTER `wa_tokens`;
ALTER TABLE `restaurants` ADD COLUMN IF NOT EXISTS `google_review_url` VARCHAR(500) NULL AFTER `wa_messaging_mode`;

-- 23. Create demo_requests table
CREATE TABLE IF NOT EXISTS `demo_requests` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `first_name` VARCHAR(100) NOT NULL,
  `last_name` VARCHAR(100),
  `email` VARCHAR(255) NOT NULL,
  `restaurant_name` VARCHAR(255),
  `status` VARCHAR(20) NOT NULL DEFAULT 'pending',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 24. Create support_requests table
CREATE TABLE IF NOT EXISTS `support_requests` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(100) NOT NULL,
  `email` VARCHAR(255) NOT NULL,
  `subject` VARCHAR(100) NOT NULL,
  `message` TEXT NOT NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'pending',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
