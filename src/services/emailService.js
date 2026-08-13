const emailjs = require('@emailjs/nodejs');
const pool = require('../config/db');

// Free EmailJS plans only allow 2 templates, so every email purpose funnels into one of two:
// emailjs_template_otp (verification/reset codes) or emailjs_template_notify (everything else).
// The notify template's Subject and body are fully dynamic (EmailJS Subject field set to
// {{subject}}, body set to {{message}}), so its wording is composed here per event.
const OTP_SUBJECTS = {
  register_customer: 'Verify your email to finish signing up',
  register_seller: 'Verify your email to finish your seller application',
  forgot_password: 'Your password reset code',
  change_email: 'Verify your new email address',
  create_staff: 'Verify your email for your new staff account',
};

const OTP_INTROS = {
  register_customer: 'Use the code below to verify your email and complete your registration.',
  register_seller: 'Use the code below to verify your email and complete your seller application.',
  forgot_password: 'Use the code below to reset your password.',
  change_email: 'Use the code below to verify your new email address.',
  create_staff: 'An admin is setting up a staff account for you. Share the code below with them to confirm this is your email.',
};

async function getConfig() {
  const [[row]] = await pool.query(
    `SELECT store_name, store_logo, theme_color_light, emailjs_service_id, emailjs_public_key,
            emailjs_private_key, emailjs_reply_to, emailjs_template_otp, emailjs_template_notify
     FROM settings WHERE id = 1`
  );
  return row;
}

/** store_logo is saved as a relative path (e.g. "/uploads/x.png") - emails need a full URL. */
function resolveLogoUrl(storeLogo) {
  if (!storeLogo) return '';
  if (/^https?:\/\//i.test(storeLogo)) return storeLogo;
  const base = (process.env.BACKEND_URL || 'http://localhost:5000').replace(/\/$/, '');
  return `${base}${storeLogo.startsWith('/') ? '' : '/'}${storeLogo}`;
}

async function send(templateId, config, params) {
  await emailjs.send(
    config.emailjs_service_id,
    templateId,
    {
      reply_to: config.emailjs_reply_to || '',
      store_name: config.store_name || '',
      store_logo: resolveLogoUrl(config.store_logo),
      theme_color: config.theme_color_light || '#1DA851',
      year: new Date().getFullYear(),
      ...params,
    },
    { publicKey: config.emailjs_public_key, privateKey: config.emailjs_private_key || undefined }
  );
}

/** Used for signup/change-email verification codes and password-reset codes - on the critical path, so failures throw. */
async function sendOtpEmail(to, code, purpose, name) {
  const config = await getConfig();

  if (!config?.emailjs_service_id || !config?.emailjs_template_otp) {
    // EmailJS not configured in Admin Settings yet - print the code instead of sending.
    console.log(`[otp] code for ${to} (${purpose}): ${code}`);
    return;
  }

  try {
    await send(config.emailjs_template_otp, config, {
      email: to,
      to_name: name || to,
      code,
      expires_minutes: 10,
      subject: OTP_SUBJECTS[purpose] || 'Your verification code',
      intro: OTP_INTROS[purpose] || 'Use the code below to continue.',
    });
  } catch (err) {
    const detail = err?.text || err?.message || String(err);
    console.error('[emailjs] OTP send failed:', detail);
    const error = new Error(`Failed to send email: ${detail}`);
    error.status = 502;
    throw error;
  }
}

/** Notification emails below are not on any critical path - log and swallow failures instead of throwing. */
async function sendNotification(subject, message, to, name, label) {
  const config = await getConfig();
  if (!config?.emailjs_service_id || !config?.emailjs_template_notify) {
    console.log(`[email] notify template not configured, skipping ${label} send to ${to}`);
    return;
  }
  try {
    await send(config.emailjs_template_notify, config, { email: to, to_name: name || to, subject, message });
  } catch (err) {
    console.error(`[emailjs] ${label} send failed:`, err?.text || err?.message || err);
  }
}

async function sendWelcomeEmail(to, name) {
  await sendNotification(
    'Welcome!',
    'Welcome! Your account has been created successfully. You can now log in and start shopping.',
    to,
    name,
    'welcome'
  );
}

async function sendSellerAppliedEmail(to, name, shopName) {
  await sendNotification(
    'We received your seller application',
    `Thank you for applying to sell with us as "${shopName || ''}". Your application is under review. We'll email you once it's approved.`,
    to,
    name,
    'seller-applied'
  );
}

async function sendSellerApprovedEmail(to, name, shopName) {
  await sendNotification(
    'Your seller account has been approved!',
    `Great news! Your seller account "${shopName || ''}" has been approved. You can now log in and start listing products.`,
    to,
    name,
    'seller-approved'
  );
}

async function sendSellerRejectedEmail(to, name, shopName) {
  await sendNotification(
    'Your seller application was not approved',
    `Thanks for your interest in selling with us. After review, your application for "${shopName || ''}" was not approved this time.`,
    to,
    name,
    'seller-rejected'
  );
}

async function sendStaffCreatedEmail(to, name) {
  await sendNotification(
    'Your staff account is ready',
    'Your staff/cashier account has been created. You can now log in and start using the POS.',
    to,
    name,
    'staff-created'
  );
}

async function sendSetupCompleteEmail(to) {
  await sendNotification(
    'Your store setup is complete!',
    'All required settings are configured — General, Contact, Appearance, Legal Pages, Email, and Google Drive are ready to go.',
    to,
    null,
    'setup-complete'
  );
}

module.exports = {
  sendOtpEmail,
  sendWelcomeEmail,
  sendSellerAppliedEmail,
  sendSellerApprovedEmail,
  sendSellerRejectedEmail,
  sendStaffCreatedEmail,
  sendSetupCompleteEmail,
};
