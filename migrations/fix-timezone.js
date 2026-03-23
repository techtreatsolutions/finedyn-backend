'use strict';

/**
 * ONE-TIME MIGRATION: Convert all existing UTC timestamps to IST (+05:30).
 *
 * Run this ONCE after deploying the backend with the session timezone fix.
 * DO NOT run this more than once — it adds 5h30m to every timestamp.
 *
 * Usage: node migrations/fix-timezone.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

const OFFSET = 'INTERVAL 330 MINUTE'; // 5 hours 30 minutes

// [table, ...datetime_columns]
const TABLES = [
  ['users', 'created_at', 'updated_at', 'last_login'],
  ['restaurants', 'created_at', 'updated_at', 'subscription_start', 'subscription_end'],
  ['plans', 'created_at', 'updated_at'],
  ['menu_categories', 'created_at', 'updated_at'],
  ['menu_items', 'created_at', 'updated_at'],
  ['menu_item_addons', 'created_at', 'updated_at'],
  ['floors', 'created_at', 'updated_at'],
  ['tables', 'created_at', 'updated_at'],
  ['orders', 'created_at', 'updated_at', 'billed_at', 'completed_at'],
  ['order_items', 'created_at', 'updated_at'],
  ['payments', 'created_at'],
  ['kots', 'created_at'],
  ['reservations', 'created_at', 'updated_at'],
  ['inventory_items', 'created_at', 'updated_at'],
  ['inventory_transactions', 'created_at'],
  ['inventory_alerts', 'created_at', 'updated_at', 'resolved_at'],
  ['expenses', 'created_at', 'updated_at'],
  ['expense_categories', 'created_at', 'updated_at'],
  ['employees', 'created_at', 'updated_at'],
  ['attendance', 'created_at'],
  ['salary_records', 'created_at', 'updated_at'],
  ['feature_overrides', 'created_at', 'updated_at'],
  ['subscription_history', 'subscription_start', 'subscription_end', 'created_at'],
  ['audit_logs', 'created_at'],
  ['device_tokens', 'created_at', 'updated_at'],
  ['qr_orders', 'created_at', 'updated_at'],
  ['qr_order_items', 'created_at', 'updated_at'],
  ['customers', 'created_at', 'updated_at'],
  ['notifications', 'created_at', 'updated_at'],
  ['support_requests', 'created_at', 'updated_at'],
  ['demo_requests', 'created_at', 'updated_at'],
  ['wa_token_history', 'created_at'],
  ['settlements', 'created_at', 'updated_at'],
  ['payment_gateway_configs', 'created_at', 'updated_at'],
];

async function fixTimezones() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'finedyn',
    uri: process.env.DATABASE_URL || undefined,
  });

  try {
    // Set session to IST so any ON UPDATE CURRENT_TIMESTAMP triggers use IST
    await connection.query("SET time_zone = '+05:30'");

    // Verify current timezone
    const [[tz]] = await connection.query("SELECT @@session.time_zone AS tz, NOW() AS now_ist");
    console.log(`[TZ Fix] Session timezone: ${tz.tz}, NOW(): ${tz.now_ist}`);

    for (const [table, ...cols] of TABLES) {
      try {
        // Check if table exists
        const [[exists]] = await connection.query(
          `SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?`,
          [table]
        );
        if (!exists.c) {
          console.log(`[TZ Fix] Skipping ${table} (table does not exist)`);
          continue;
        }

        // Build SET clause: col = DATE_ADD(col, INTERVAL 330 MINUTE) for each column
        const setClauses = cols.map(col => `\`${col}\` = DATE_ADD(\`${col}\`, ${OFFSET})`).join(', ');
        const sql = `UPDATE \`${table}\` SET ${setClauses}`;
        const [result] = await connection.query(sql);
        console.log(`[TZ Fix] ${table}: ${result.affectedRows} rows updated (${cols.join(', ')})`);
      } catch (err) {
        // Skip errors for missing columns
        if (err.errno === 1054) {
          console.log(`[TZ Fix] ${table}: skipped (column not found: ${err.message})`);
        } else {
          console.error(`[TZ Fix] ${table}: ERROR — ${err.message}`);
        }
      }
    }

    console.log('\n[TZ Fix] Done! All timestamps shifted from UTC to IST (+05:30).');
    console.log('[TZ Fix] WARNING: Do NOT run this script again — it would double-shift timestamps.');
  } catch (err) {
    console.error('[TZ Fix] Fatal error:', err.message);
    process.exit(1);
  } finally {
    await connection.end();
  }
}

fixTimezones();
