-- ============================================================
-- PATCH: Add missing columns and tables
-- Run this on the live database to apply schema fixes
-- ============================================================

-- 1. Add tax_enabled column to orders table (used by recalcOrder and generateBill)
ALTER TABLE `orders` ADD COLUMN IF NOT EXISTS `tax_enabled` TINYINT(1) NOT NULL DEFAULT 1 AFTER `bill_number`;

-- 2. Create qr_sessions table (used by QR ordering flow)
CREATE TABLE IF NOT EXISTS `qr_sessions` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `restaurant_id` INT NOT NULL,
  `table_id` INT NOT NULL,
  `session_token` VARCHAR(255) NOT NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
