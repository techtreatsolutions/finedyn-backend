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
        if (e.errno === 1060 || e.errno === 1050 || e.errno === 1054) {
          // Skip: duplicate column / table already exists / unknown column
        } else {
          throw e;
        }
      }
    }
    console.log('[Migration] Schema applied successfully.');
  } catch (err) {
    console.error('[Migration] Error:', err.message);
    process.exit(1);
  } finally {
    await connection.end();
  }
}

runMigrations();
