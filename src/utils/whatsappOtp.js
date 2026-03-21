'use strict';

const https = require('https');
const url = require('url');

// In-memory OTP store: key = phone number, value = { otp, expiresAt }
const otpStore = new Map();

const OTP_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
const OTP_LENGTH = 6;

function generateOTP() {
  const min = Math.pow(10, OTP_LENGTH - 1);
  const max = Math.pow(10, OTP_LENGTH) - 1;
  return String(Math.floor(min + Math.random() * (max - min + 1)));
}

/**
 * Send OTP via Fast2SMS WhatsApp API (GET request)
 */
function sendWhatsAppOTP(phone, otp) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.FAST2SMS_API_KEY;
    const messageId = process.env.FAST2SMS_WA_OTP_MESSAGE_ID;
    const phoneNumberId = process.env.FAST2SMS_WA_PHONE_NUMBER_ID;

    if (!apiKey || !messageId || !phoneNumberId) {
      return reject(new Error('Fast2SMS WhatsApp config missing in .env'));
    }

    // Clean phone number — remove +91, spaces, dashes
    const cleanPhone = phone.replace(/[\s\-+]/g, '').replace(/^91/, '');

    const params = new URLSearchParams({
      authorization: apiKey,
      message_id: messageId,
      phone_number_id: phoneNumberId,
      numbers: cleanPhone,
      variables_values: otp,
    });

    const reqUrl = `https://www.fast2sms.com/dev/whatsapp?${params.toString()}`;
    const parsed = url.parse(reqUrl);

    const req = https.get(
      {
        hostname: parsed.hostname,
        path: parsed.path,
        headers: { 'Cache-Control': 'no-cache' },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode === 200 && json.return !== false) {
              resolve(json);
            } else {
              reject(new Error(json.message || `Fast2SMS error (${res.statusCode})`));
            }
          } catch {
            reject(new Error(`Fast2SMS invalid response: ${data.substring(0, 200)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Generate, store, and send OTP to a phone number.
 * Returns true on success.
 */
async function requestOTP(phone) {
  const otp = generateOTP();
  otpStore.set(phone, { otp, expiresAt: Date.now() + OTP_EXPIRY_MS });
  await sendWhatsAppOTP(phone, otp);
  return true;
}

/**
 * Verify an OTP for a phone number.
 * Returns true if valid, false otherwise. Deletes OTP on success.
 */
function verifyOTP(phone, otp) {
  const entry = otpStore.get(phone);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    otpStore.delete(phone);
    return false;
  }
  if (entry.otp !== otp) return false;
  otpStore.delete(phone);
  return true;
}

/**
 * Send WhatsApp e-bill/invoice message via Fast2SMS.
 * Template has 5 variables: customerName, restaurantName, orderId, amount, ebillUrl
 */
function sendWhatsAppInvoice(phone, variables) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.FAST2SMS_API_KEY;
    const messageId = process.env.FAST2SMS_WA_INVOICE_MESSAGE_ID;
    const phoneNumberId = process.env.FAST2SMS_WA_PHONE_NUMBER_ID;

    if (!apiKey || !messageId || !phoneNumberId) {
      return reject(new Error('Fast2SMS WhatsApp invoice config missing in .env'));
    }

    const cleanPhone = phone.replace(/[\s\-+]/g, '').replace(/^91/, '');

    // variables = [customerName, restaurantName, orderId, amount, ebillUrl]
    const params = new URLSearchParams({
      authorization: apiKey,
      message_id: messageId,
      phone_number_id: phoneNumberId,
      numbers: cleanPhone,
      variables_values: variables.join('|'),
    });

    const reqUrl = `https://www.fast2sms.com/dev/whatsapp?${params.toString()}`;
    const parsed = url.parse(reqUrl);

    const req = https.get(
      {
        hostname: parsed.hostname,
        path: parsed.path,
        headers: { 'Cache-Control': 'no-cache' },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode === 200 && json.return !== false) {
              resolve(json);
            } else {
              reject(new Error(json.message || `Fast2SMS error (${res.statusCode})`));
            }
          } catch {
            reject(new Error(`Fast2SMS invalid response: ${data.substring(0, 200)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Send WhatsApp Google Review message via Fast2SMS.
 * Template has 1 variable: googleReviewUrl
 */
function sendWhatsAppReview(phone, googleReviewUrl) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.FAST2SMS_API_KEY;
    const messageId = process.env.FAST2SMS_WA_REVIEW_MESSAGE_ID;
    const phoneNumberId = process.env.FAST2SMS_WA_PHONE_NUMBER_ID;

    if (!apiKey || !messageId || !phoneNumberId) {
      return reject(new Error('Fast2SMS WhatsApp review config missing in .env'));
    }

    const cleanPhone = phone.replace(/[\s\-+]/g, '').replace(/^91/, '');

    const params = new URLSearchParams({
      authorization: apiKey,
      message_id: messageId,
      phone_number_id: phoneNumberId,
      numbers: cleanPhone,
      variables_values: googleReviewUrl,
    });

    const reqUrl = `https://www.fast2sms.com/dev/whatsapp?${params.toString()}`;
    const parsed = url.parse(reqUrl);

    const req = https.get(
      { hostname: parsed.hostname, path: parsed.path, headers: { 'Cache-Control': 'no-cache' } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode === 200 && json.return !== false) resolve(json);
            else reject(new Error(json.message || `Fast2SMS error (${res.statusCode})`));
          } catch { reject(new Error(`Fast2SMS invalid response: ${data.substring(0, 200)}`)); }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Send combined e-bill + Google Review message via Fast2SMS.
 * Template has 6 variables: customerName, restaurantName, orderId, amount, ebillUrl, googleReviewUrl
 */
function sendWhatsAppInvoiceReview(phone, variables) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.FAST2SMS_API_KEY;
    const messageId = process.env.FAST2SMS_WA_INVOICE_REVIEW_MESSAGE_ID;
    const phoneNumberId = process.env.FAST2SMS_WA_PHONE_NUMBER_ID;

    if (!apiKey || !messageId || !phoneNumberId) {
      return reject(new Error('Fast2SMS WhatsApp invoice+review config missing in .env'));
    }

    const cleanPhone = phone.replace(/[\s\-+]/g, '').replace(/^91/, '');

    const params = new URLSearchParams({
      authorization: apiKey,
      message_id: messageId,
      phone_number_id: phoneNumberId,
      numbers: cleanPhone,
      variables_values: variables.join('|'),
    });

    const reqUrl = `https://www.fast2sms.com/dev/whatsapp?${params.toString()}`;
    const parsed = url.parse(reqUrl);

    const req = https.get(
      { hostname: parsed.hostname, path: parsed.path, headers: { 'Cache-Control': 'no-cache' } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode === 200 && json.return !== false) resolve(json);
            else reject(new Error(json.message || `Fast2SMS error (${res.statusCode})`));
          } catch { reject(new Error(`Fast2SMS invalid response: ${data.substring(0, 200)}`)); }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

module.exports = { requestOTP, verifyOTP, sendWhatsAppInvoice, sendWhatsAppReview, sendWhatsAppInvoiceReview };
