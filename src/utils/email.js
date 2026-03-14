'use strict';

const nodemailer = require('nodemailer');

const BRAND_COLOR = '#C8102E';
const BRAND_NAME = 'FineDyn';

function createTransporter() {
  return nodemailer.createTransport({
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.EMAIL_PORT, 10) || 587,
    secure: false,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    tls: { rejectUnauthorized: false },
  });
}

function baseTemplate(title, bodyHtml) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><title>${title}</title></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:40px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
<tr><td style="background:${BRAND_COLOR};padding:24px 40px;text-align:center;">
<h1 style="margin:0;color:#fff;font-size:28px;">${BRAND_NAME}</h1>
<p style="margin:4px 0 0;color:rgba(255,255,255,0.85);font-size:13px;">Restaurant Management Platform</p>
</td></tr>
<tr><td style="padding:40px;">${bodyHtml}</td></tr>
<tr><td style="background:#f9f9f9;padding:20px 40px;text-align:center;border-top:1px solid #eee;">
<p style="margin:0;color:#999;font-size:12px;">&copy; ${new Date().getFullYear()} ${BRAND_NAME}. All rights reserved.</p>
</td></tr>
</table></td></tr></table></body></html>`;
}

function buttonHtml(href, label) {
  return `<div style="text-align:center;margin:32px 0;">
<a href="${href}" style="display:inline-block;background:${BRAND_COLOR};color:#fff;text-decoration:none;padding:14px 36px;border-radius:5px;font-size:15px;font-weight:bold;">${label}</a>
</div>`;
}

async function sendEmail(to, subject, htmlContent) {
  const transporter = createTransporter();
  try {
    const info = await transporter.sendMail({
      from: process.env.EMAIL_FROM || `${BRAND_NAME} <noreply@finedyn.com>`,
      to, subject, html: htmlContent,
    });
    console.log(`[Email] Sent to ${to}: ${info.messageId}`);
    return info;
  } catch (err) {
    console.error(`[Email] Failed to send to ${to}:`, err.message);
    throw err;
  }
}

async function sendPasswordReset(email, resetLink) {
  const body = `<h2 style="color:#333;margin-top:0;">Reset Your Password</h2>
<p style="color:#555;line-height:1.6;">We received a request to reset your ${BRAND_NAME} password. Click below to choose a new password.</p>
${buttonHtml(resetLink, 'Reset Password')}
<p style="color:#777;font-size:13px;">This link expires in 1 hour. If you did not request this, ignore this email.</p>`;
  await sendEmail(email, `Reset your ${BRAND_NAME} password`, baseTemplate('Password Reset', body));
}

async function sendWelcome(email, name, restaurantName) {
  const body = `<h2 style="color:#333;margin-top:0;">Welcome to ${BRAND_NAME}, ${name}!</h2>
<p style="color:#555;line-height:1.6;">Your account for <strong>${restaurantName}</strong> has been created successfully.</p>
${buttonHtml(process.env.FRONTEND_URL || 'http://localhost:3000', 'Go to Dashboard')}`;
  await sendEmail(email, `Welcome to ${BRAND_NAME}!`, baseTemplate('Welcome', body));
}

async function sendVerification(email, verificationLink) {
  const body = `<h2 style="color:#333;margin-top:0;">Verify Your Email</h2>
<p style="color:#555;line-height:1.6;">Please verify your email address to activate your ${BRAND_NAME} account.</p>
${buttonHtml(verificationLink, 'Verify Email')}
<p style="color:#777;font-size:13px;">This link expires in 24 hours.</p>`;
  await sendEmail(email, `Verify your ${BRAND_NAME} email`, baseTemplate('Email Verification', body));
}

module.exports = { sendEmail, sendPasswordReset, sendWelcome, sendVerification };
