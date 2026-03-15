'use strict';

require('dotenv').config();
const mysql = require('mysql2/promise');

const baseConfig = {
  waitForConnections: true,
  connectionLimit: 20,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  timezone: '+00:00',
  decimalNumbers: true,
  dateStrings: false,
};

let poolConfig;

if (process.env.DATABASE_URL) {
  poolConfig = {
    uri: process.env.DATABASE_URL,
    ...baseConfig,
  };
} else {
  poolConfig = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'finedyn',
    ...baseConfig,
  };
}

let pool;

function getPool() {
  if (!pool) {
    pool = mysql.createPool(poolConfig);
    pool.on('error', (err) => {
      console.error('[DB] Pool error:', err.message);
    });
  }
  return pool;
}

async function query(sql, params = []) {
  const db = getPool();
  try {
    // Use pool.query() instead of pool.execute() —
    // execute() uses prepared statements which are strict about parameter types
    // (e.g. LIMIT ? / OFFSET ? fail if params are strings instead of integers).
    // query() uses standard escaping and handles type coercion properly.
    const [rows, fields] = await db.query(sql, params);
    return [rows, fields];
  } catch (err) {
    console.error('[DB] Query error:', err.message);
    console.error('[DB] SQL:', sql);
    throw err;
  }
}

async function transaction(callback) {
  const db = getPool();
  const connection = await db.getConnection();
  await connection.beginTransaction();
  try {
    const result = await callback(connection);
    await connection.commit();
    return result;
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

async function testConnection() {
  const db = getPool();
  try {
    const connection = await db.getConnection();
    await connection.ping();
    connection.release();
    console.log('[DB] Connection pool established successfully.');
    return true;
  } catch (err) {
    console.error('[DB] Failed to connect to MySQL:', err.message);
    throw err;
  }
}

module.exports = { getPool, query, transaction, testConnection };
