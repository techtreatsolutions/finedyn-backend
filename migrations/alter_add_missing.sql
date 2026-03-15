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
