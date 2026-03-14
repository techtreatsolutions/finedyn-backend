'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

async function runMigrations() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'finedyn',
    multipleStatements: true,
  });

  try {
    console.log('[Migration] Connected to MySQL.');
    const schemaPath = path.join(__dirname, 'schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');
    console.log('[Migration] Running schema.sql...');
    const schemaStatements = sql.split(';').map(s => s.trim()).filter(s => s.length > 0);
    for (const stmt of schemaStatements) {
      try {
        await connection.query(stmt);
      } catch (e) {
        // Ignore "duplicate column", "table already exists", or "unknown column" errors during baseline schema sync
        if (e.errno === 1060 || e.errno === 1050 || e.errno === 1054) {
          // Silent skip for schema.sql
        } else {
          throw e;
        }
      }
    }
    console.log('[Migration] Schema applied successfully.');

    // Run additional migration files (safe for re-runs)
    const extraMigrations = ['add_addons.sql', 'add_bill_images.sql', 'add_availability_times.sql', 'add_qr_ordering.sql', 'add_qr_device_id.sql', 'add_table_pin.sql', 'fix_qr_code_column.sql', 'add_reservation_fields.sql', 'add_employee_advances.sql', 'split_online_ordering_features.sql', 'add_delivery_orders.sql', 'add_printer_sizes.sql'];
    for (const file of extraMigrations) {
      const filePath = path.join(__dirname, file);
      if (fs.existsSync(filePath)) {
        const extraSql = fs.readFileSync(filePath, 'utf8');
        console.log(`[Migration] Running ${file}...`);
        // Execute each statement separately so IF NOT EXISTS / duplicates don't block others
        const statements = extraSql.split(';').map(s => s.trim()).filter(s => s.length > 0);
        for (const stmt of statements) {
          try {
            await connection.query(stmt);
          } catch (e) {
            // Ignore "duplicate column", "table already exists", or "unknown column" errors
            if (e.errno === 1060 || e.errno === 1050 || e.errno === 1054) {
              console.log(`[Migration]   Skipped (already exists): ${e.message}`);
            } else {
              throw e;
            }
          }
        }
        console.log(`[Migration] ${file} applied.`);
      }
    }
  } catch (err) {
    console.error('[Migration] Error:', err.message);
    process.exit(1);
  } finally {
    await connection.end();
  }
}

runMigrations();
