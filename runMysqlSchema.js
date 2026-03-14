require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

async function run() {
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST === 'localhost' ? '127.0.0.1' : process.env.DB_HOST || '127.0.0.1',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        multipleStatements: true
    });

    try {
        const schemaFile = fs.readFileSync(path.join(__dirname, 'migrations/schema.sql'), 'utf8');
        console.log('Running MySQL schema...');

        // Create DB if not exists
        await connection.query('CREATE DATABASE IF NOT EXISTS `' + (process.env.DB_NAME || 'finedyn') + '`');
        await connection.query('USE `' + (process.env.DB_NAME || 'finedyn') + '`');

        await connection.query(schemaFile);
        console.log('MySQL schema imported successfully.');
    } catch (err) {
        console.error('Migration failed:', err.message);
    } finally {
        await connection.end();
    }
}
run();
