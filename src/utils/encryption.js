'use strict';

const crypto = require('crypto');

const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16;

function getDerivedKey() {
  const rawKey = process.env.ENCRYPTION_KEY;
  if (!rawKey) throw new Error('ENCRYPTION_KEY environment variable is not set.');
  return crypto.createHash('sha256').update(rawKey).digest();
}

function encrypt(text) {
  if (typeof text !== 'string' || text.length === 0) throw new Error('encrypt() requires a non-empty string.');
  const key = getDerivedKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return `${iv.toString('hex')}:${encrypted}`;
}

function decrypt(encryptedText) {
  if (typeof encryptedText !== 'string' || !encryptedText.includes(':')) {
    throw new Error('decrypt() received an invalid encrypted string format.');
  }
  const [ivHex, encrypted] = encryptedText.split(':');
  if (!ivHex || !encrypted) throw new Error('decrypt() received a malformed encrypted string.');
  const key = getDerivedKey();
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

module.exports = { encrypt, decrypt };
