-- ============================================================
-- FineDyn - Multi-Tenant Restaurant SaaS POS Platform
-- Database Schema v1.0
-- ============================================================








-- ============================================================
-- 1. PLANS - SaaS subscription plans
-- ============================================================
CREATE TABLE IF NOT EXISTS `plans` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(100) NOT NULL,
  `description` TEXT,
  `price_monthly` DECIMAL(10,2) NOT NULL DEFAULT 0,
  `price_yearly` DECIMAL(10,2) NOT NULL DEFAULT 0,
  `max_floors` INT NOT NULL DEFAULT 2,
  `max_tables` INT NOT NULL DEFAULT 20,
  `max_menu_items` INT NOT NULL DEFAULT 100,
  `max_staff` INT NOT NULL DEFAULT 10,
  `max_bills_per_day` INT NOT NULL DEFAULT 200,
  `max_bills_per_month` INT NOT NULL DEFAULT 5000,
  `feature_waiter_app` TINYINT(1) NOT NULL DEFAULT 1,
  `feature_online_ordering` TINYINT(1) NOT NULL DEFAULT 1,
  `feature_digital_menu` TINYINT(1) NOT NULL DEFAULT 1,
  `feature_edine_in_orders` TINYINT(1) NOT NULL DEFAULT 1,
  `feature_reservations` TINYINT(1) NOT NULL DEFAULT 1,
  `feature_inventory` TINYINT(1) NOT NULL DEFAULT 1,
  `feature_expense_management` TINYINT(1) NOT NULL DEFAULT 1,
  `feature_employee_management` TINYINT(1) NOT NULL DEFAULT 1,
  `feature_kds` TINYINT(1) NOT NULL DEFAULT 1,
  `feature_analytics` TINYINT(1) NOT NULL DEFAULT 1,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `is_default` TINYINT(1) NOT NULL DEFAULT 0,
  `sort_order` INT NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP 
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 2. RESTAURANTS - Core multi-tenant entity
-- ============================================================
CREATE TABLE IF NOT EXISTS `restaurants` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(255) NOT NULL,
  `slug` VARCHAR(100) NOT NULL UNIQUE,
  `type` VARCHAR(50) NOT NULL DEFAULT 'dine_in',
  `email` VARCHAR(255) UNIQUE,
  `phone` VARCHAR(20),
  `address` TEXT,
  `city` VARCHAR(100),
  `state` VARCHAR(100),
  `pincode` VARCHAR(10),
  `logo_url` VARCHAR(500),
  `gstin` VARCHAR(20),
  `fssai_number` VARCHAR(30),
  `timezone` VARCHAR(50) NOT NULL DEFAULT 'Asia/Kolkata',
  `currency` VARCHAR(10) NOT NULL DEFAULT 'INR',
  `plan_id` INT,
  `subscription_status` VARCHAR(50) NOT NULL DEFAULT 'trial',
  `subscription_start` DATETIME,
  `subscription_end` DATETIME,
  `bill_prefix` VARCHAR(10) NOT NULL DEFAULT 'INV',
  `bill_counter` INT NOT NULL DEFAULT 0,
  `queued_plan_id` INT,
  `queued_plan_months` INT NOT NULL DEFAULT 1,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP 
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 3. FEATURE OVERRIDES - Per-restaurant plan overrides
-- ============================================================
CREATE TABLE IF NOT EXISTS `feature_overrides` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `restaurant_id` INT NOT NULL,
  `feature_name` VARCHAR(100) NOT NULL,
  `override_value` VARCHAR(255) NOT NULL,
  `reason` TEXT,
  `overridden_by` INT,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP 
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 4. USERS - All platform users
-- ============================================================
CREATE TABLE IF NOT EXISTS `users` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `restaurant_id` INT,
  `name` VARCHAR(255) NOT NULL,
  `email` VARCHAR(255) NOT NULL UNIQUE,
  `phone` VARCHAR(20),
  `password_hash` VARCHAR(255) NOT NULL,
  `role` VARCHAR(50) NOT NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `is_verified` TINYINT(1) NOT NULL DEFAULT 0,
  `email_verification_token` VARCHAR(255),
  `password_reset_token` VARCHAR(255),
  `password_reset_expires` DATETIME,
  `last_login` DATETIME,
  `profile_image` VARCHAR(500),
  `pin_code` VARCHAR(10) NULL,
  `section_access` TEXT,
  `active_session_id` VARCHAR(64) NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 5. FLOORS - Restaurant floors/areas (dine-in)
-- ============================================================
CREATE TABLE IF NOT EXISTS `floors` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `restaurant_id` INT NOT NULL,
  `name` VARCHAR(100) NOT NULL,
  `description` TEXT,
  `sort_order` INT NOT NULL DEFAULT 0,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP 
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 6. TABLES - Restaurant tables
-- ============================================================
CREATE TABLE IF NOT EXISTS `tables` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `restaurant_id` INT NOT NULL,
  `floor_id` INT,
  `table_number` VARCHAR(20) NOT NULL,
  `capacity` INT NOT NULL DEFAULT 4,
  `shape` VARCHAR(50) NOT NULL DEFAULT 'square',
  `status` VARCHAR(50) NOT NULL DEFAULT 'available',
  `current_order_id` INT,
  `assigned_waiter_id` INT,
  `qr_code` TEXT,
  `table_pin` VARCHAR(20),
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP 
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 7. MENU CATEGORIES
-- ============================================================
CREATE TABLE IF NOT EXISTS `menu_categories` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `restaurant_id` INT NOT NULL,
  `name` VARCHAR(100) NOT NULL,
  `description` TEXT,
  `image_url` VARCHAR(500),
  `sort_order` INT NOT NULL DEFAULT 0,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `available_from` TIME DEFAULT NULL,
  `available_to` TIME DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP 
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 8. MENU ITEMS
-- ============================================================
CREATE TABLE IF NOT EXISTS `menu_items` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `restaurant_id` INT NOT NULL,
  `category_id` INT,
  `name` VARCHAR(255) NOT NULL,
  `description` TEXT,
  `price` DECIMAL(10,2) NOT NULL DEFAULT 0,
  `image_url` VARCHAR(500),
  `item_type` VARCHAR(50) NOT NULL DEFAULT 'veg',
  `is_available` TINYINT(1) NOT NULL DEFAULT 1,
  `is_featured` TINYINT(1) NOT NULL DEFAULT 0,
  `preparation_time` INT NOT NULL DEFAULT 15,
  `tax_rate` DECIMAL(5,2) NOT NULL DEFAULT 5.00,
  `has_variants` TINYINT(1) NOT NULL DEFAULT 0,
  `sort_order` INT NOT NULL DEFAULT 0,
  `available_from` TIME DEFAULT NULL,
  `available_to` TIME DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP 
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 9. MENU ITEM VARIANTS
-- ============================================================
CREATE TABLE IF NOT EXISTS `menu_item_variants` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `menu_item_id` INT NOT NULL,
  `name` VARCHAR(100) NOT NULL,
  `price` DECIMAL(10,2) NOT NULL,
  `is_available` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 9b. MENU ITEM ADDONS
-- ============================================================
CREATE TABLE IF NOT EXISTS `menu_item_addons` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `menu_item_id` INT NOT NULL,
  `name` VARCHAR(100) NOT NULL,
  `price` DECIMAL(10,2) NOT NULL DEFAULT 0,
  `is_available` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 10. ORDERS
-- ============================================================
CREATE TABLE IF NOT EXISTS `orders` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `restaurant_id` INT NOT NULL,
  `order_number` VARCHAR(50),
  `order_type` VARCHAR(50) NOT NULL DEFAULT 'dine_in',
  `table_id` INT,
  `floor_id` INT,
  `customer_name` VARCHAR(255),
  `customer_phone` VARCHAR(20),
  `delivery_address` TEXT,
  `status` VARCHAR(50) NOT NULL DEFAULT 'pending',
  `waiter_id` INT,
  `cashier_id` INT,
  `subtotal` DECIMAL(10,2) NOT NULL DEFAULT 0,
  `tax_amount` DECIMAL(10,2) NOT NULL DEFAULT 0,
  `discount_amount` DECIMAL(10,2) NOT NULL DEFAULT 0,
  `total_amount` DECIMAL(10,2) NOT NULL DEFAULT 0,
  `payment_status` VARCHAR(50) NOT NULL DEFAULT 'unpaid',
  `payment_mode` VARCHAR(50),
  `notes` TEXT,
  `kot_printed` TINYINT(1) NOT NULL DEFAULT 0,
  `bill_generated` TINYINT(1) NOT NULL DEFAULT 0,
  `bill_number` VARCHAR(50),
  `billed_at` DATETIME,
  `tax_enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `completed_at` DATETIME,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 11. ORDER ITEMS
-- ============================================================
CREATE TABLE IF NOT EXISTS `order_items` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `order_id` INT NOT NULL,
  `restaurant_id` INT NOT NULL,
  `menu_item_id` INT,
  `variant_id` INT,
  `item_name` VARCHAR(255) NOT NULL,
  `item_price` DECIMAL(10,2) NOT NULL,
  `quantity` INT NOT NULL DEFAULT 1,
  `tax_rate` DECIMAL(5,2) NOT NULL DEFAULT 0,
  `tax_amount` DECIMAL(10,2) NOT NULL DEFAULT 0,
  `discount_amount` DECIMAL(10,2) NOT NULL DEFAULT 0,
  `total_price` DECIMAL(10,2) NOT NULL DEFAULT 0,
  `notes` TEXT,
  `addon_details` JSON DEFAULT NULL,
  `addon_per_unit` DECIMAL(10,2) NOT NULL DEFAULT 0,
  `status` VARCHAR(50) NOT NULL DEFAULT 'pending',
  `kot_sent` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP 
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 12. BILL ADJUSTMENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS `bill_adjustments` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `order_id` INT NOT NULL,
  `restaurant_id` INT NOT NULL,
  `label` VARCHAR(100) NOT NULL,
  `adjustment_type` VARCHAR(50) NOT NULL DEFAULT 'charge',
  `value_type` VARCHAR(50) NOT NULL DEFAULT 'fixed',
  `value` DECIMAL(10,2) NOT NULL,
  `applied_amount` DECIMAL(10,2) NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 13. PAYMENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS `payments` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `order_id` INT NOT NULL,
  `restaurant_id` INT NOT NULL,
  `payment_mode` VARCHAR(50) NOT NULL,
  `gateway` VARCHAR(50),
  `gateway_order_id` VARCHAR(255),
  `gateway_payment_id` VARCHAR(255),
  `gateway_signature` VARCHAR(500),
  `amount` DECIMAL(10,2) NOT NULL,
  `amount_received` DECIMAL(10,2),
  `status` VARCHAR(50) NOT NULL DEFAULT 'pending',
  `processed_by` INT,
  `notes` TEXT,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP 
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 14. PAYMENT GATEWAY SETTINGS
-- ============================================================
CREATE TABLE IF NOT EXISTS `payment_gateway_settings` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `restaurant_id` INT NOT NULL,
  `gateway` VARCHAR(50) NOT NULL,
  `api_key_encrypted` TEXT,
  `api_secret_encrypted` TEXT,
  `webhook_secret_encrypted` TEXT,
  `is_active` TINYINT(1) NOT NULL DEFAULT 0,
  `is_test_mode` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP 
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 15. RESERVATIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS `reservations` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `restaurant_id` INT NOT NULL,
  `table_id` INT,
  `floor_id` INT,
  `order_id` INT DEFAULT NULL,
  `customer_name` VARCHAR(255) NOT NULL,
  `customer_phone` VARCHAR(20) NULL,
  `customer_email` VARCHAR(255),
  `party_size` INT NOT NULL DEFAULT 2,
  `guest_count` INT NOT NULL DEFAULT 2,
  `reservation_date` DATE NOT NULL,
  `reservation_time` TIME NOT NULL,
  `duration_minutes` INT NOT NULL DEFAULT 90,
  `status` VARCHAR(50) NOT NULL DEFAULT 'pending',
  `notes` TEXT,
  `advance_amount` DECIMAL(10,2) DEFAULT NULL,
  `advance_payment_mode` VARCHAR(50) DEFAULT NULL,
  `created_by` INT,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP 
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 16. INVENTORY CATEGORIES
-- ============================================================
CREATE TABLE IF NOT EXISTS `inventory_categories` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `restaurant_id` INT NOT NULL,
  `name` VARCHAR(100) NOT NULL,
  `unit` VARCHAR(50) NOT NULL DEFAULT 'pcs',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 17. INVENTORY ITEMS
-- ============================================================
CREATE TABLE IF NOT EXISTS `inventory_items` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `restaurant_id` INT NOT NULL,
  `category_id` INT,
  `name` VARCHAR(255) NOT NULL,
  `sku` VARCHAR(100),
  `unit` VARCHAR(50) NOT NULL DEFAULT 'pcs',
  `unit_display` VARCHAR(50) NOT NULL DEFAULT 'Pieces',
  `current_stock` DECIMAL(10,3) NOT NULL DEFAULT 0,
  `minimum_stock` DECIMAL(10,3) NOT NULL DEFAULT 0,
  `reorder_level` DECIMAL(10,3) NOT NULL DEFAULT 0,
  `cost_per_unit` DECIMAL(10,2),
  `supplier_name` VARCHAR(255),
  `supplier_phone` VARCHAR(20),
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP 
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 18. INVENTORY TRANSACTIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS `inventory_transactions` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `restaurant_id` INT NOT NULL,
  `item_id` INT NOT NULL,
  `transaction_type` VARCHAR(50) NOT NULL,
  `quantity` DECIMAL(10,3) NOT NULL,
  `previous_stock` DECIMAL(10,3) NOT NULL,
  `new_stock` DECIMAL(10,3) NOT NULL,
  `unit_cost` DECIMAL(10,2),
  `total_cost` DECIMAL(10,2),
  `notes` TEXT,
  `reference_number` VARCHAR(100),
  `performed_by` INT,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 19. STOCK REQUIREMENT TICKETS
-- ============================================================
CREATE TABLE IF NOT EXISTS `stock_requirement_tickets` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `restaurant_id` INT NOT NULL,
  `item_name` VARCHAR(255) NOT NULL,
  `quantity_required` VARCHAR(100) NOT NULL,
  `priority` VARCHAR(50) NOT NULL DEFAULT 'normal',
  `raised_by` INT,
  `raised_by_role` VARCHAR(50) NOT NULL DEFAULT 'kitchen',
  `status` VARCHAR(50) NOT NULL DEFAULT 'pending',
  `remarks` TEXT,
  `inventory_item_id` INT,
  `quantity_requested` DECIMAL(10,2),
  `requested_by` INT,
  `approved_by` INT,
  `manager_notes` TEXT,
  `resolved_by` INT,
  `resolved_at` DATETIME,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP 
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 20. EXPENSE CATEGORIES
-- ============================================================
CREATE TABLE IF NOT EXISTS `expense_categories` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `restaurant_id` INT NOT NULL,
  `name` VARCHAR(100) NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 21. EXPENSES - Bills payable
-- ============================================================
CREATE TABLE IF NOT EXISTS `expenses` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `restaurant_id` INT NOT NULL,
  `category_id` INT,
  `title` VARCHAR(255) NOT NULL,
  `vendor_name` VARCHAR(255),
  `amount` DECIMAL(10,2) NOT NULL,
  `due_date` DATE,
  `status` VARCHAR(50) NOT NULL DEFAULT 'pending',
  `payment_mode` VARCHAR(50),
  `payment_date` DATE,
  `attachment_url` VARCHAR(500),
  `notes` TEXT,
  `expense_date` DATE,
  `created_by` INT,
  `approved_by` INT,
  `approved_notes` TEXT,
  `receipt_url` VARCHAR(500),
  `recorded_by` INT,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP 
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 22. EMPLOYEES
-- ============================================================
CREATE TABLE IF NOT EXISTS `employees` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `restaurant_id` INT NOT NULL,
  `user_id` INT,
  `name` VARCHAR(255) NOT NULL,
  `phone` VARCHAR(20),
  `email` VARCHAR(255),
  `role` VARCHAR(100) NOT NULL,
  `joining_date` DATE,
  `salary_type` VARCHAR(50) NOT NULL DEFAULT 'monthly',
  `salary_amount` DECIMAL(10,2) NOT NULL DEFAULT 0,
  `bank_account` VARCHAR(50),
  `bank_ifsc` VARCHAR(20),
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `profile_image` VARCHAR(500),
  `emergency_contact` VARCHAR(100),
  `address` TEXT,
  `department` VARCHAR(100),
  `designation` VARCHAR(100),
  `base_salary` DECIMAL(10,2) NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP 
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 23. SALARY RECORDS
-- ============================================================
CREATE TABLE IF NOT EXISTS `salary_records` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `restaurant_id` INT NOT NULL,
  `employee_id` INT NOT NULL,
  `month` INT NOT NULL,
  `year` INT NOT NULL,
  `base_salary` DECIMAL(10,2) NOT NULL,
  `advances` DECIMAL(10,2) NOT NULL DEFAULT 0,
  `deductions` DECIMAL(10,2) NOT NULL DEFAULT 0,
  `bonuses` DECIMAL(10,2) NOT NULL DEFAULT 0,
  `adjusted_advances` DECIMAL(10,2) NOT NULL DEFAULT 0,
  `adjusted_outstanding` DECIMAL(10,2) NOT NULL DEFAULT 0,
  `net_salary` DECIMAL(10,2) NOT NULL,
  `payment_status` VARCHAR(50) NOT NULL DEFAULT 'pending',
  `payment_mode` VARCHAR(50),
  `payment_date` DATE,
  `notes` TEXT,
  `basic_salary` DECIMAL(10,2),
  `paid_by` INT,
  `created_by` INT,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP 
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 24. ATTENDANCE RECORDS
-- ============================================================
CREATE TABLE IF NOT EXISTS `attendance_records` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `restaurant_id` INT NOT NULL,
  `employee_id` INT NOT NULL,
  `attendance_date` DATE NOT NULL,
  `status` VARCHAR(50) NOT NULL DEFAULT 'present',
  `check_in` TIME,
  `check_out` TIME,
  `notes` TEXT,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 25. BILL FORMAT SETTINGS
-- ============================================================
CREATE TABLE IF NOT EXISTS `bill_format_settings` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `restaurant_id` INT NOT NULL UNIQUE,
  `show_restaurant_name` TINYINT(1) NOT NULL DEFAULT 1,
  `show_logo` TINYINT(1) NOT NULL DEFAULT 1,
  `show_address` TINYINT(1) NOT NULL DEFAULT 1,
  `show_contact` TINYINT(1) NOT NULL DEFAULT 1,
  `show_gst` TINYINT(1) NOT NULL DEFAULT 1,
  `show_waiter_name` TINYINT(1) NOT NULL DEFAULT 1,
  `show_table_number` TINYINT(1) NOT NULL DEFAULT 1,
  `show_date_time` TINYINT(1) NOT NULL DEFAULT 1,
  `show_payment_mode` TINYINT(1) NOT NULL DEFAULT 1,
  `show_customer_details` TINYINT(1) NOT NULL DEFAULT 1,
  `enable_tax` TINYINT(1) NOT NULL DEFAULT 1,
  `custom_header` TEXT,
  `custom_footer` TEXT,
  `header_image_url` VARCHAR(500) DEFAULT NULL,
  `footer_image_url` VARCHAR(500) DEFAULT NULL,
  `thank_you_message` VARCHAR(500) DEFAULT 'Thank you for dining with us!',
  `bill_printer_size_mm` INT NOT NULL DEFAULT 80,
  `kot_printer_size_mm` INT NOT NULL DEFAULT 80,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP 
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 26. SUBSCRIPTION PAYMENTS - Manual cash subscription renewals
-- ============================================================
CREATE TABLE IF NOT EXISTS `subscription_payments` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `restaurant_id` INT NOT NULL,
  `plan_id` INT,
  `amount` DECIMAL(10,2) NOT NULL,
  `payment_mode` VARCHAR(50) NOT NULL DEFAULT 'manual',
  `duration_months` INT NOT NULL DEFAULT 1,
  `remarks` TEXT,
  `subscription_start` DATETIME NOT NULL,
  `subscription_end` DATETIME NOT NULL,
  `processed_by` INT,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 27. AUDIT LOGS
-- ============================================================
CREATE TABLE IF NOT EXISTS `audit_logs` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `restaurant_id` INT,
  `user_id` INT,
  `action` VARCHAR(255) NOT NULL,
  `entity_type` VARCHAR(100),
  `entity_id` INT,
  `old_value` JSON,
  `new_value` JSON,
  `ip_address` VARCHAR(50),
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 28. NOTIFICATIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS `notifications` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT NOT NULL,
  `restaurant_id` INT,
  `type` VARCHAR(50) NOT NULL DEFAULT 'info',
  `title` VARCHAR(255) NOT NULL,
  `message` TEXT,
  `action_url` VARCHAR(500),
  `is_read` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;



-- ============================================================
-- DEFAULT DATA
-- ============================================================

-- Insert default plans
INSERT INTO `plans` (`id`, `name`, `description`, `price_monthly`, `price_yearly`, `max_floors`, `max_tables`, `max_menu_items`, `max_staff`, `max_bills_per_day`, `max_bills_per_month`, `feature_waiter_app`, `feature_online_ordering`, `feature_reservations`, `feature_inventory`, `feature_expense_management`, `feature_employee_management`, `feature_kds`, `feature_analytics`, `is_active`, `is_default`, `sort_order`)
VALUES
  (1, 'Basic', 'Perfect for small QSR restaurants just getting started.', 999.00, 9990.00, 1, 10, 50, 5, 100, 2500, false, true, false, false, true, false, false, false, true, true, 1),
  (2, 'Professional', 'Ideal for growing dine-in restaurants with full features.', 2499.00, 24990.00, 3, 30, 200, 15, 500, 12000, true, true, true, true, true, true, true, true, true, false, 2),
  (3, 'Enterprise', 'For large restaurants and chains with unlimited usage.', 4999.00, 49990.00, 10, 100, 1000, 50, 2000, 50000, true, true, true, true, true, true, true, true, true, false, 3)
ON DUPLICATE KEY UPDATE `updated_at` = CURRENT_TIMESTAMP;

-- ============================================================
-- 29. QR ORDERS
-- ============================================================
CREATE TABLE IF NOT EXISTS `qr_orders` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `restaurant_id` INT NOT NULL,
  `table_id` INT NOT NULL,
  `session_token` VARCHAR(255) NOT NULL,
  `customer_name` VARCHAR(255),
  `customer_phone` VARCHAR(20),
  `items` JSON NOT NULL,
  `special_instructions` TEXT,
  `payment_preference` VARCHAR(50),
  `status` VARCHAR(50) NOT NULL DEFAULT 'pending',
  `reject_reason` TEXT,
  `linked_order_id` INT,
  `accepted_by` INT,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP 
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 30. QR SESSIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS `qr_sessions` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `restaurant_id` INT NOT NULL,
  `table_id` INT NOT NULL,
  `session_token` VARCHAR(255) NOT NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 31. EMPLOYEE ADVANCES
-- ============================================================
CREATE TABLE IF NOT EXISTS `employee_advances` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `restaurant_id` INT NOT NULL,
  `employee_id` INT NOT NULL,
  `type` VARCHAR(50) NOT NULL DEFAULT 'advance',
  `amount` DECIMAL(10,2) NOT NULL,
  `remaining` DECIMAL(10,2) NOT NULL,
  `date` DATE NOT NULL,
  `notes` TEXT,
  `status` VARCHAR(50) NOT NULL DEFAULT 'active',
  `adjusted_in_salary_id` INT,
  `created_by` INT,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP 
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

