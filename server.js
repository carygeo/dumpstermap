const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const multer = require('multer');

// Configure photo uploads
const UPLOADS_DIR = process.env.NODE_ENV === 'production' ? '/data/uploads' : path.join(__dirname, 'uploads');
const fs = require('fs');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const name = `provider-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
    cb(null, name);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Only .jpg, .jpeg, .png, .webp allowed'));
  }
});

const app = express();
const PORT = process.env.PORT || 8080;

// Configuration
const DATA_DIR = process.env.DATA_DIR || './data';
const DB_PATH = path.join(DATA_DIR, 'dumpstermap.db');
const NOTIFICATION_EMAIL = 'admin@dumpstermap.io';
const SINGLE_LEAD_PRICE = 40;
const SINGLE_LEAD_STRIPE_LINK = 'https://buy.stripe.com/cNidR9aQ76T46IF78j5Rm04';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'dumpstermap2026';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Email config - Resend (primary) or SMTP (fallback)
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SMTP_USER = process.env.SMTP_USER || 'admin@dumpstermap.io';
const SMTP_PASS = process.env.SMTP_PASS;
const EMAIL_FROM = process.env.EMAIL_FROM || 'DumpsterMap <leads@dumpstermap.io>';
const OUTREACH_FROM = process.env.OUTREACH_FROM || 'DumpsterMap Partners <partners@dumpstermap.io>';

// Parse JSON bodies - raw for Stripe webhook verification
app.use('/api/stripe-webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================
// DATABASE SETUP
// ============================================
let db;

function initDatabase() {
  const fs = require('fs');
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  
  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id TEXT UNIQUE NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      name TEXT,
      email TEXT,
      phone TEXT,
      zip TEXT,
      project_type TEXT,
      size TEXT,
      timeframe TEXT,
      message TEXT,
      source TEXT DEFAULT 'Website',
      status TEXT DEFAULT 'New',
      assigned_provider TEXT,
      assigned_provider_id INTEGER,
      credits_charged INTEGER DEFAULT 0,
      purchased_by TEXT,
      purchased_at TEXT,
      payment_id TEXT,
      email_sent TEXT,
      notes TEXT
    );
    
    CREATE TABLE IF NOT EXISTS providers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      company_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      phone TEXT,
      service_zips TEXT,
      credit_balance INTEGER DEFAULT 0,
      total_leads INTEGER DEFAULT 0,
      plan TEXT DEFAULT 'Free',
      status TEXT DEFAULT 'Active',
      verified INTEGER DEFAULT 0,
      priority INTEGER DEFAULT 0,
      last_purchase_at TEXT,
      notes TEXT
    );
    
    CREATE TABLE IF NOT EXISTS purchase_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
      lead_id TEXT,
      buyer_email TEXT,
      amount REAL,
      payment_id TEXT,
      status TEXT
    );
    
    CREATE TABLE IF NOT EXISTS outreach (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      provider_email TEXT NOT NULL,
      company_name TEXT,
      phone TEXT,
      zip TEXT,
      source TEXT,
      campaign TEXT,
      email_sent_at TEXT,
      email_status TEXT DEFAULT 'Pending',
      opened_at TEXT,
      clicked_at TEXT,
      replied_at TEXT,
      converted INTEGER DEFAULT 0,
      notes TEXT
    );
    
    CREATE TABLE IF NOT EXISTS error_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
      type TEXT,
      message TEXT,
      context TEXT
    );
    
    CREATE TABLE IF NOT EXISTS webhook_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      processed_at TEXT DEFAULT CURRENT_TIMESTAMP,
      event_type TEXT,
      event_data TEXT,
      result TEXT
    );
    
    CREATE TABLE IF NOT EXISTS registration_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
      event_type TEXT NOT NULL,
      provider_id INTEGER,
      email TEXT,
      selected_pack TEXT,
      source TEXT,
      metadata TEXT
    );
    
    CREATE TABLE IF NOT EXISTS credit_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
      provider_id INTEGER NOT NULL,
      provider_email TEXT,
      type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      balance_after INTEGER,
      reference TEXT,
      notes TEXT,
      FOREIGN KEY (provider_id) REFERENCES providers(id)
    );
    
    CREATE INDEX IF NOT EXISTS idx_leads_lead_id ON leads(lead_id);
    CREATE INDEX IF NOT EXISTS idx_outreach_email ON outreach(provider_email);
    CREATE INDEX IF NOT EXISTS idx_leads_zip ON leads(zip);
    CREATE INDEX IF NOT EXISTS idx_providers_email ON providers(email);
    CREATE INDEX IF NOT EXISTS idx_credit_tx_provider ON credit_transactions(provider_id);
  `);
  
  // Migration: Add last_purchase_at column if it doesn't exist
  try {
    db.exec('ALTER TABLE providers ADD COLUMN last_purchase_at TEXT');
    console.log('Migration: Added last_purchase_at column to providers');
  } catch (e) {
    // Column already exists, ignore
  }
  
  // Migration: Add address column if it doesn't exist
  try {
    db.exec('ALTER TABLE providers ADD COLUMN address TEXT');
    console.log('Migration: Added address column to providers');
  } catch (e) {
    // Column already exists, ignore
  }
  
  // Migration: Add broken-down address fields for registration form
  try {
    db.exec('ALTER TABLE providers ADD COLUMN street_address TEXT');
    console.log('Migration: Added street_address column to providers');
  } catch (e) {}
  try {
    db.exec('ALTER TABLE providers ADD COLUMN city TEXT');
    console.log('Migration: Added city column to providers');
  } catch (e) {}
  try {
    db.exec('ALTER TABLE providers ADD COLUMN state TEXT');
    console.log('Migration: Added state column to providers');
  } catch (e) {}
  try {
    db.exec('ALTER TABLE providers ADD COLUMN business_zip TEXT');
    console.log('Migration: Added business_zip column to providers');
  } catch (e) {}
  try {
    db.exec('ALTER TABLE providers ADD COLUMN website TEXT');
    console.log('Migration: Added website column to providers');
  } catch (e) {}
  
  // Migration: Add stripe_customer_id for recurring billing
  try {
    db.exec('ALTER TABLE providers ADD COLUMN stripe_customer_id TEXT');
    console.log('Migration: Added stripe_customer_id column to providers');
  } catch (e) {
    // Column already exists, ignore
  }
  
  // Migration: Add providers_notified to leads for better tracking
  try {
    db.exec('ALTER TABLE leads ADD COLUMN providers_notified TEXT');
    console.log('Migration: Added providers_notified column to leads');
  } catch (e) {
    // Column already exists, ignore
  }
  
  // Migration: Add assigned_provider_id to leads for provider tracking
  try {
    db.exec('ALTER TABLE leads ADD COLUMN assigned_provider_id INTEGER');
    console.log('Migration: Added assigned_provider_id column to leads');
  } catch (e) {
    // Column already exists, ignore
  }
  
  // Migration: Add premium_expires_at for 30-day featured partner tracking
  try {
    db.exec('ALTER TABLE providers ADD COLUMN premium_expires_at TEXT');
    console.log('Migration: Added premium_expires_at column to providers');
  } catch (e) {
    // Column already exists, ignore
  }
  
  // Migration: Add lat/lng for map display
  try {
    db.exec('ALTER TABLE providers ADD COLUMN lat REAL');
    db.exec('ALTER TABLE providers ADD COLUMN lng REAL');
    console.log('Migration: Added lat/lng columns to providers');
  } catch (e) {
    // Columns already exist, ignore
  }
  
  // Migration: Add photo_url for provider photos
  try {
    db.exec('ALTER TABLE providers ADD COLUMN photo_url TEXT');
    console.log('Migration: Added photo_url column to providers');
  } catch (e) {
    // Column already exists, ignore
  }
  
  console.log('Database initialized:', DB_PATH);
}

// Helper: Geocode an address using Nominatim (free, no API key)
async function geocodeAddress(address) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}&countrycodes=us&limit=1`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'DumpsterMap/1.0 (support@dumpstermap.io)' }
    });
    const data = await response.json();
    if (data.length > 0) {
      return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    }
    return null;
  } catch (e) {
    console.error('Geocoding error:', e);
    return null;
  }
}

// Helper: Check if provider's premium status is still active
function isPremiumActive(provider) {
  if (!provider.premium_expires_at) return false;
  return new Date(provider.premium_expires_at) > new Date();
}

// Helper: Expire premium status for providers past their 30-day window
function expirePremiumStatus() {
  const expired = db.prepare(`
    SELECT id, company_name FROM providers 
    WHERE premium_expires_at IS NOT NULL 
    AND premium_expires_at < datetime('now')
    AND (verified = 1 OR priority > 0)
  `).all();
  
  for (const provider of expired) {
    db.prepare('UPDATE providers SET verified = 0, priority = 0 WHERE id = ?').run(provider.id);
    console.log(`Premium expired for ${provider.company_name} (ID: ${provider.id})`);
  }
  
  return expired.length;
}

// Helper: Send premium expiration reminder emails (7 days and 3 days before)
async function sendPremiumReminders() {
  const reminders = [];
  
  // Find providers expiring in 7 days (±12 hours window to avoid duplicates)
  const sevenDays = db.prepare(`
    SELECT id, company_name, email, premium_expires_at FROM providers 
    WHERE premium_expires_at IS NOT NULL 
    AND premium_expires_at BETWEEN datetime('now', '+6 days', '+12 hours') AND datetime('now', '+7 days', '+12 hours')
    AND verified = 1
  `).all();
  
  // Find providers expiring in 3 days
  const threeDays = db.prepare(`
    SELECT id, company_name, email, premium_expires_at FROM providers 
    WHERE premium_expires_at IS NOT NULL 
    AND premium_expires_at BETWEEN datetime('now', '+2 days', '+12 hours') AND datetime('now', '+3 days', '+12 hours')
    AND verified = 1
  `).all();
  
  for (const provider of sevenDays) {
    const daysLeft = 7;
    const html = generatePremiumReminderEmail(provider, daysLeft);
    const sent = await sendEmail(provider.email, `Your Featured Partner status expires in ${daysLeft} days`, html);
    if (sent) reminders.push({ provider: provider.company_name, daysLeft });
  }
  
  for (const provider of threeDays) {
    const daysLeft = 3;
    const html = generatePremiumReminderEmail(provider, daysLeft);
    const sent = await sendEmail(provider.email, `⚠️ Featured Partner expiring in ${daysLeft} days - Renew now`, html);
    if (sent) reminders.push({ provider: provider.company_name, daysLeft });
  }
  
  return reminders;
}

function generatePremiumReminderEmail(provider, daysLeft) {
  const urgency = daysLeft <= 3 ? 'urgent' : 'reminder';
  const color = daysLeft <= 3 ? '#dc2626' : '#f59e0b';
  
  return `
<div style="font-family: Arial, sans-serif; max-width: 600px; line-height: 1.6; color: #333;">
  <p>Hi ${provider.company_name},</p>
  
  <div style="background: ${daysLeft <= 3 ? '#fef2f2' : '#fffbeb'}; border-left: 4px solid ${color}; padding: 16px; margin: 20px 0;">
    <strong style="color: ${color};">Your Featured Partner status expires in ${daysLeft} days</strong>
  </div>
  
  <p>Your premium benefits are set to expire on <strong>${new Date(provider.premium_expires_at).toLocaleDateString()}</strong>.</p>
  
  <p><strong>What you'll lose:</strong></p>
  <ul>
    <li>✓ Verified badge on your listing</li>
    <li>🔝 Priority placement in search results</li>
    <li>Higher visibility to customers</li>
  </ul>
  
  <p style="margin: 24px 0;">
    <a href="https://dumpstermap.io/for-providers#pricing" style="background: ${color}; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Renew Featured Partner →</a>
  </p>
  
  <p>Questions? Reply to this email.</p>
  
  <p>— The DumpsterMap Team</p>
</div>`;
}

// ============================================
// EMAIL SETUP (Resend primary, SMTP fallback)
// ============================================
let emailTransporter = null;
let gmailTransporter = null;  // Dedicated Gmail for outreach
let useResend = false;

function initEmail() {
  // Prefer Resend if API key is set
  if (RESEND_API_KEY) {
    useResend = true;
    console.log('Email: Using Resend API');
  }
  
  // Always set up Gmail for outreach if credentials available
  if (SMTP_PASS) {
    gmailTransporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    });
    console.log('Email: Gmail/SMTP configured for outreach');
    
    // Use as fallback if no Resend
    if (!useResend) {
      emailTransporter = gmailTransporter;
      console.log('Email: Using Gmail as primary');
    }
    return true;
  }
  
  if (!useResend) {
    console.log('Email: DISABLED (no RESEND_API_KEY or SMTP_PASS)');
  }
  return useResend;
}

// Send email via Gmail SMTP (for outreach - no rate limits)
async function sendEmailViaGmail(to, subject, html, text, fromAddress = 'DumpsterMap <admin@dumpstermap.io>') {
  if (!gmailTransporter) {
    console.error('Gmail not configured - SMTP_PASS not set');
    return false;
  }
  
  try {
    await gmailTransporter.sendMail({
      from: fromAddress,
      to,
      subject,
      html,
      text
    });
    console.log('Email sent via Gmail to:', to);
    return true;
  } catch (error) {
    console.error('Gmail error:', error.message);
    return false;
  }
}

// ============================================
// HELPER FUNCTIONS
// ============================================

function generateLeadId() {
  const count = db.prepare('SELECT COUNT(*) as cnt FROM leads').get().cnt;
  return 'LEAD-' + String(count + 1).padStart(4, '0');
}

function getLeadById(leadId) {
  return db.prepare('SELECT * FROM leads WHERE lead_id = ?').get(leadId);
}

function getProvidersByZip(zip) {
  if (!zip) return [];
  const providers = db.prepare(`
    SELECT * FROM providers WHERE status = 'Active'
  `).all();
  
  return providers.filter(p => {
    const zips = (p.service_zips || '').split(',').map(z => z.trim());
    return zips.includes(zip);
  });
}

function getProviderByEmail(email) {
  return db.prepare('SELECT * FROM providers WHERE LOWER(email) = LOWER(?)').get(email);
}

async function sendEmail(to, subject, html, text, fromAddress = EMAIL_FROM) {
  // Use Resend if available
  if (useResend && RESEND_API_KEY) {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: fromAddress,
          to: [to],
          subject: subject,
          html: html,
          text: text
        })
      });
      
      if (!response.ok) {
        const error = await response.text();
        console.error('Resend error:', error);
        return false;
      }
      
      const result = await response.json();
      console.log('Email sent via Resend:', result.id);
      return true;
    } catch (error) {
      console.error('Resend error:', error.message);
      return false;
    }
  }
  
  // Fallback to SMTP
  if (emailTransporter) {
    try {
      await emailTransporter.sendMail({
        from: EMAIL_FROM,
        to, subject, html, text
      });
      console.log('Email sent via SMTP to:', to);
      return true;
    } catch (error) {
      console.error('SMTP error:', error.message);
      return false;
    }
  }
  
  console.log('Email disabled - would send to:', to, subject);
  return false;
}

async function sendAdminNotification(subject, body) {
  await sendEmail(NOTIFICATION_EMAIL, subject, `<pre>${body}</pre>`, body);
}

function logError(type, message, context = {}, error = null) {
  // Include stack trace if an Error object is provided
  const enrichedContext = {
    ...context,
    stack: error?.stack || null,
    timestamp: new Date().toISOString()
  };
  
  try {
    db.prepare('INSERT INTO error_log (type, message, context) VALUES (?, ?, ?)').run(
      type, 
      message, 
      JSON.stringify(enrichedContext)
    );
  } catch (e) {
    console.error('Failed to log error:', e);
  }
  console.error(`[${type}] ${message}`, context);
  if (error?.stack) console.error('Stack trace:', error.stack);
}

// Helper: Log credit transaction for audit trail
function logCreditTransaction(providerId, type, amount, reference = null, notes = null) {
  try {
    const provider = db.prepare('SELECT email, credit_balance FROM providers WHERE id = ?').get(providerId);
    if (!provider) return;
    
    db.prepare(`
      INSERT INTO credit_transactions (provider_id, provider_email, type, amount, balance_after, reference, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(providerId, provider.email, type, amount, provider.credit_balance, reference, notes);
  } catch (e) {
    // Table might not exist in older deployments, that's ok
    console.log('Credit transaction log skipped:', e.message);
  }
}

// ============================================
// LEAD SUBMISSION ENDPOINT
// ============================================
// LEAD PRICING CONFIGURATION
// ============================================
const LEAD_PRICING = {
  perLead: 1.0         // 1 credit = 1 lead (simple pricing for now)
};

app.post('/api/lead', async (req, res) => {
  console.log('\n=== Lead Submission ===');
  
  try {
    const data = req.body;
    const leadId = generateLeadId();
    const name = ((data.firstName || '') + ' ' + (data.lastName || '')).trim();
    
    // Determine lead type: direct (specific provider) vs zip-matched
    const isDirect = !!(data.providerId || data.providerName);
    const leadType = isDirect ? 'direct' : 'zip-matched';
    
    // Simple pricing: 1 credit per lead
    const creditCost = LEAD_PRICING.perLead;
    
    // Save lead
    db.prepare(`
      INSERT INTO leads (lead_id, name, email, phone, zip, project_type, size, timeframe, message, source, assigned_provider)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(leadId, name, data.email, data.phone, data.zip, data.projectType, data.size, 
           data.timeframe || data.timeline, data.message, data.source || 'Website', data.providerName || '');
    
    console.log(`Lead saved: ${leadId} (${leadType}, cost: ${creditCost} credit)`);
    
    // Find target provider(s)
    let providers = [];
    
    // Convert providerId to number if it's a string
    const providerId = data.providerId ? parseInt(data.providerId, 10) : null;
    
    if (providerId) {
      // DIRECT: Specific provider ID - send ONLY to them (ignore ZIP matching)
      const specificProvider = db.prepare('SELECT * FROM providers WHERE id = ? AND status = ?').get(providerId, 'Active');
      if (specificProvider) {
        providers = [specificProvider];
        console.log(`DIRECT lead to: ${specificProvider.company_name} (ID: ${providerId})`);
      } else {
        console.log(`Provider ID ${providerId} not found or inactive`);
      }
    } else if (data.providerName) {
      // DIRECT by name: Look up provider by company name
      const specificProvider = db.prepare('SELECT * FROM providers WHERE LOWER(company_name) = LOWER(?) AND status = ?').get(data.providerName, 'Active');
      if (specificProvider) {
        providers = [specificProvider];
        console.log(`DIRECT lead to: ${specificProvider.company_name} (by name)`);
      } else {
        console.log(`Provider "${data.providerName}" not found or inactive`);
      }
    } else {
      // No specific provider - find all providers serving this ZIP
      providers = getProvidersByZip(data.zip);
      console.log(`ZIP-matched lead to ${providers.length} providers for zip ${data.zip}`);
    }
    
    let sentCount = 0;
    let teaserCount = 0;
    
    for (const provider of providers) {
      // Check if provider has enough credits
      if (provider.credit_balance >= creditCost) {
        await sendFullLeadToProvider(provider, leadId, data, { leadType, creditCost });
        db.prepare('UPDATE providers SET credit_balance = credit_balance - ?, total_leads = total_leads + 1 WHERE id = ?')
          .run(creditCost, provider.id);
        logCreditTransaction(provider.id, 'lead_sent', -creditCost, leadId, `Lead in ${data.zip}`);
        sentCount++;
      } else {
        // Not enough credits - send teaser
        await sendTeaserToProvider(provider, leadId, data, { leadType, creditCost });
        teaserCount++;
      }
    }
    
    // Update lead status with full tracking
    const fullProvidersList = providers.filter(p => p.credit_balance >= creditCost);
    const teaserProvidersList = providers.filter(p => p.credit_balance < creditCost);
    const fullProviders = fullProvidersList.map(p => p.company_name);
    const fullProviderIds = fullProvidersList.map(p => p.id);
    const teaserProviders = teaserProvidersList.map(p => p.company_name);
    const allNotified = [...fullProviders.map(n => `${n} (full)`), ...teaserProviders.map(n => `${n} (teaser)`)].join(', ');
    
    if (sentCount > 0) {
      // Store first provider ID for exclusive leads, or comma-separated for shared
      const assignedProviderId = fullProviderIds.length === 1 ? fullProviderIds[0] : null;
      db.prepare('UPDATE leads SET status = ?, assigned_provider = ?, assigned_provider_id = ?, credits_charged = ?, providers_notified = ? WHERE lead_id = ?')
        .run('Sent', fullProviders.join(', '), assignedProviderId, creditCost * sentCount, allNotified, leadId);
    } else if (teaserCount > 0) {
      db.prepare('UPDATE leads SET status = ?, providers_notified = ? WHERE lead_id = ?')
        .run('Teaser Sent', allNotified, leadId);
    }
    
    const isExclusive = providers.length === 1;
    await sendAdminNotification(`${isExclusive ? '🎯' : '📢'} ${leadType.toUpperCase()} lead: ${leadId}`,
      `${leadId} (${leadType})\n${name} | ${data.phone} | ${data.email}\n${data.zip} | ${data.size || 'TBD'}\nFull: ${sentCount} | Teasers: ${teaserCount} | Cost: ${creditCost}/provider`);
    
    res.json({ status: 'ok', leadId, leadType, message: 'Lead submitted successfully' });
  } catch (error) {
    console.error('Lead error:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

async function sendFullLeadToProvider(provider, leadId, lead, options = {}) {
  const { leadType = 'exclusive', creditCost = 1 } = options;
  const timeframe = lead.timeframe === 'asap' ? 'ASAP' : lead.timeframe || 'soon';
  const isAsap = lead.timeframe === 'asap';
  const newBalance = Math.max(0, (provider.credit_balance || 0) - creditCost);
  const projectType = lead.projectType || lead.project_type || 'Not specified';
  const customerName = [lead.firstName, lead.lastName].filter(Boolean).join(' ') || 'Customer';
  
  // ASAP badge if urgent
  const asapBadge = isAsap ? ' <span style="background: #ef4444; color: white; padding: 2px 8px; border-radius: 4px; font-size: 12px;">⚡ ASAP</span>' : '';
  
  const lowBalanceWarning = newBalance <= 2 ? `
  <div style="background: #fef3c7; border: 1px solid #fcd34d; padding: 12px; border-radius: 6px; margin: 20px 0;">
    ⚠️ <strong>Low balance:</strong> ${newBalance} credit${newBalance === 1 ? '' : 's'} remaining.
    <a href="https://dumpstermap.io/for-providers" style="color: #b45309; font-weight: bold;">Top up →</a>
  </div>` : '';
  
  const html = `
<div style="font-family: Arial, sans-serif; max-width: 600px; line-height: 1.6; color: #333;">
  <p>Hi ${provider.company_name},</p>
  
  ${asapBadge ? `<p>${asapBadge}</p>` : ''}
  
  <p><strong>${customerName}</strong> in <strong>${lead.zip}</strong> just requested a quote — they need a dumpster <strong>${timeframe}</strong>.</p>
  
  <div style="background: #f0fdf4; border-left: 4px solid #22c55e; padding: 16px; margin: 20px 0;">
    <strong style="font-size: 16px;">📞 Contact Info</strong><br><br>
    <strong>Name:</strong> ${customerName}<br>
    <strong>Phone:</strong> ${lead.phone || 'N/A'}<br>
    <strong>Email:</strong> ${lead.email || 'N/A'}
  </div>
  
  <div style="background: #f8f9fa; padding: 16px; border-radius: 6px; margin: 16px 0;">
    <strong>Project Details:</strong><br>
    • Size: ${lead.size ? lead.size + ' yard' : 'To be discussed'}<br>
    • Type: ${projectType}<br>
    • Timeline: ${timeframe}
  </div>
  
  <p>💡 <strong>Pro tip:</strong> Call within 5 minutes — first responder usually wins the job.</p>
  ${lowBalanceWarning}
  <p style="color: #666; font-size: 13px; margin-top: 24px; border-top: 1px solid #eee; padding-top: 16px;">
    1 credit used • <strong>${newBalance} remaining</strong> • <a href="https://dumpstermap.io/balance" style="color: #2563eb;">Check balance</a>
  </p>
</div>`;
  await sendEmail(provider.email, `🗑️ New lead in ${lead.zip} - ${customerName}`, html);
}

async function sendTeaserToProvider(provider, leadId, lead, options = {}) {
  const paymentLink = `${SINGLE_LEAD_STRIPE_LINK}?client_reference_id=${leadId}`;
  const timeframe = lead.timeframe === 'asap' ? 'ASAP' : lead.timeframe || 'soon';
  const projectType = lead.project_type || lead.projectType || 'General';
  const companyName = provider.company_name || 'there';
  const isAsap = lead.timeframe === 'asap';
  
  const html = `
<div style="font-family: Arial, sans-serif; max-width: 600px; line-height: 1.6; color: #333;">
  <p>Hi ${companyName},</p>
  
  <p>Someone in your area just searched DumpsterMap looking for a dumpster rental. They filled out a quote request and are <strong>ready to book</strong>.</p>
  
  <div style="background: #f8f9fa; padding: 16px; border-left: 4px solid #f59e0b; margin: 20px 0;">
    <strong>What we know about this lead:</strong><br>
    • Location: <strong>${lead.zip}</strong><br>
    • Size: ${lead.size ? lead.size + ' yard' : 'Not specified yet'}<br>
    • Timeframe: <strong>${timeframe}</strong>${isAsap ? ' ⚡' : ''}<br>
    • Project: ${projectType}
  </div>
  
  <p><strong>Why DumpsterMap leads convert:</strong><br>
  These are homeowners and contractors <em>actively searching</em> for dumpster service right now — not cold leads from a purchased list.</p>
  
  <p style="margin: 24px 0;">
    <a href="${paymentLink}" style="background: #f59e0b; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Unlock this lead for $40 →</a>
  </p>
  
  <p>You'll get their <strong>name, phone number, and email</strong> instantly so you can reach out while they're still shopping.</p>
  
  <p style="font-size: 14px; color: #666; margin-top: 24px;">
    <strong>Want a better rate?</strong> Lead packs start at $200 for 5 leads.<br>
    <a href="https://dumpstermap.io/for-providers#pricing" style="color: #2563eb;">See all options →</a>
  </p>
  
  <p>— The DumpsterMap Team</p>
  
  <p style="font-size: 13px; color: #888; margin-top: 20px; border-top: 1px solid #eee; padding-top: 16px;">
    P.S. You're receiving this because your business serves ${lead.zip}. Reply to update your service area.
  </p>
</div>`;

  await sendEmail(provider.email, `🔔 New lead in ${lead.zip} - ready to book`, html);
}

// ============================================
// STRIPE WEBHOOK
// ============================================

// Credit pack pricing (one-time purchases)
// Keys are dollar amounts, but we also check Stripe product/price IDs
const CREDIT_PACKS = {
  200: { credits: 5, name: 'Starter Pack' },
  700: { credits: 20, name: 'Pro Pack', perks: true },      // Includes verified badge
  1500: { credits: 60, name: 'Premium Pack', perks: true }  // Includes verified + priority
};

// Map Stripe product IDs to credit packs (more reliable than amount matching)
// This is the MOST RELIABLE way to identify purchases (works even with coupons/discounts)
//
// HOW TO GET YOUR STRIPE PRICE IDs:
// 1. Go to Stripe Dashboard → Products
// 2. Click on a product → Look for "API ID" or "Price ID" (starts with price_)
// 3. Add below: 'price_xxx': { credits: X, name: 'Pack Name' }
//
// Or use Stripe CLI: stripe products list --expand data.default_price
//
// Stripe Payment Links (for reference):
// - Single Lead ($40):     https://buy.stripe.com/cNidR9aQ76T46IF78j5Rm04
// - Starter ($200, 5cr):   https://buy.stripe.com/00w14n5vNa5g5EB2S35Rm00
// - Pro ($700, 20cr):      https://buy.stripe.com/fZu6oH7DVgtE7MJdwH5Rm02
// - Premium ($1500, 60cr): https://buy.stripe.com/bJefZh0btcdod73eAL5Rm03
// - Featured ($99/mo):     https://buy.stripe.com/28EdR9e2jelwgjfgIT5Rm01
//
const STRIPE_PRODUCT_MAP = {
  // Add your Stripe price_xxx IDs here for bulletproof detection:
  // 'price_1xxx': { credits: 5, name: 'Starter Pack' },
  // 'price_2xxx': { credits: 20, name: 'Pro Pack', perks: true },
  // 'price_3xxx': { credits: 60, name: 'Premium Pack', perks: true },
  // 'price_4xxx': { credits: 3, name: 'Featured Partner', perks: ['verified', 'priority'] },
};

// Webhook event log for debugging payment issues
function logWebhookEvent(eventType, data, result = null) {
  try {
    db.prepare(`
      INSERT INTO webhook_log (event_type, event_data, result, processed_at)
      VALUES (?, ?, ?, datetime('now'))
    `).run(eventType, JSON.stringify(data), result ? JSON.stringify(result) : null);
  } catch (e) {
    // Table might not exist yet, that's fine
    console.log('Webhook log skipped (table may not exist):', eventType);
  }
}

// Match credit pack by product name, metadata, or amount
// Works regardless of coupons/discounts
function matchCreditPack(amount, session = null) {
  if (session) {
    // 1. Check session metadata (most reliable if set during checkout creation)
    const metadata = session.metadata || {};
    if (metadata.pack_type) {
      console.log(`Matched by metadata: ${metadata.pack_type}`);
      if (metadata.pack_type === 'starter') return CREDIT_PACKS[200];
      if (metadata.pack_type === 'pro') return CREDIT_PACKS[700];
      if (metadata.pack_type === 'premium') return CREDIT_PACKS[1500];
      if (metadata.pack_type === 'featured') return { ...SUBSCRIPTIONS[99], isSubscription: true };
    }
    if (metadata.credits) {
      const credits = parseInt(metadata.credits);
      console.log(`Matched by metadata credits: ${credits}`);
      if (credits === 5) return CREDIT_PACKS[200];
      if (credits === 20) return CREDIT_PACKS[700];
      if (credits === 60) return CREDIT_PACKS[1500];
      if (credits === 3) return { ...SUBSCRIPTIONS[99], isSubscription: true };
    }
    
    // 2. Check line items for product name (if expanded)
    const lineItems = session.line_items?.data || [];
    for (const item of lineItems) {
      const productName = (
        item.description ||
        item.price?.product?.name ||
        item.price?.nickname ||
        ''
      ).toLowerCase();
      
      if (productName) console.log(`Checking product name: "${productName}"`);
      
      if (productName.includes('starter') || productName.includes('5 credit') || productName.includes('5-credit')) {
        console.log('Matched: Starter Pack by product name');
        return CREDIT_PACKS[200];
      }
      if (productName.includes('pro pack') || productName.includes('20 credit') || productName.includes('20-credit')) {
        console.log('Matched: Pro Pack by product name');
        return CREDIT_PACKS[700];
      }
      if (productName.includes('premium') || productName.includes('60 credit') || productName.includes('60-credit')) {
        console.log('Matched: Premium Pack by product name');
        return CREDIT_PACKS[1500];
      }
      if (productName.includes('featured') || productName.includes('partner')) {
        console.log('Matched: Featured Partner by product name');
        return { ...SUBSCRIPTIONS[99], isSubscription: true };
      }
      
      // Check product/price IDs
      const priceId = item.price?.id;
      const productId = item.price?.product;
      if (priceId && STRIPE_PRODUCT_MAP[priceId]) return STRIPE_PRODUCT_MAP[priceId];
      if (productId && STRIPE_PRODUCT_MAP[productId]) return STRIPE_PRODUCT_MAP[productId];
    }
    
    // 3. Check original amount before discount (amount_subtotal)
    const originalAmount = session.amount_subtotal ? session.amount_subtotal / 100 : null;
    if (originalAmount) {
      console.log(`Checking original amount before discount: $${originalAmount}`);
      if (CREDIT_PACKS[originalAmount]) {
        console.log(`Matched by original amount: $${originalAmount}`);
        return CREDIT_PACKS[originalAmount];
      }
      // Also check with tolerance
      for (const [price, pack] of Object.entries(CREDIT_PACKS)) {
        if (Math.abs(originalAmount - parseInt(price)) <= 5) {
          console.log(`Matched by original amount (with tolerance): $${originalAmount} -> $${price}`);
          return pack;
        }
      }
    }
  }
  
  // Exact amount match
  if (CREDIT_PACKS[amount]) return CREDIT_PACKS[amount];
  if (SUBSCRIPTIONS[amount]) return { ...SUBSCRIPTIONS[amount], isSubscription: true };
  
  // Check within $5 tolerance for each pack (Stripe sometimes has small variations)
  for (const [price, pack] of Object.entries(CREDIT_PACKS)) {
    if (Math.abs(amount - parseInt(price)) <= 5) {
      return pack;
    }
  }
  for (const [price, pack] of Object.entries(SUBSCRIPTIONS)) {
    if (Math.abs(amount - parseInt(price)) <= 5) {
      return { ...pack, isSubscription: true };
    }
  }
  
  return null;
}

// Check if payment was already processed (idempotency)
function isPaymentProcessed(paymentId) {
  if (!paymentId) return false;
  const existing = db.prepare("SELECT * FROM purchase_log WHERE payment_id = ? AND (status LIKE '%Success%' OR status = 'Credits Added')").get(paymentId);
  return !!existing;
}

// Monthly subscription plans
const SUBSCRIPTIONS = {
  99: { credits: 3, name: 'Featured Partner', perks: ['verified', 'priority'] }
};

// Get or create provider by email
function getOrCreateProvider(email, name = null) {
  let provider = db.prepare('SELECT * FROM providers WHERE LOWER(email) = LOWER(?)').get(email);
  
  if (!provider) {
    // Auto-create provider
    const companyName = name || email.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    db.prepare(`
      INSERT INTO providers (company_name, email, status, notes)
      VALUES (?, ?, 'Active', 'Auto-created from purchase')
    `).run(companyName, email.toLowerCase());
    
    provider = db.prepare('SELECT * FROM providers WHERE LOWER(email) = LOWER(?)').get(email);
    console.log('Auto-created provider:', companyName, email);
  }
  
  return provider;
}

// Verify Stripe signature helper
function verifyStripeSignature(payload, signature) {
  if (!STRIPE_WEBHOOK_SECRET || !signature) return null;
  
  try {
    const timestamp = signature.split(',').find(s => s.startsWith('t='))?.split('=')[1];
    const signatures = signature.split(',').filter(s => s.startsWith('v1=')).map(s => s.split('=')[1]);
    
    if (!timestamp || signatures.length === 0) return null;
    
    const signedPayload = `${timestamp}.${payload}`;
    const expectedSig = crypto.createHmac('sha256', STRIPE_WEBHOOK_SECRET)
      .update(signedPayload).digest('hex');
    
    const isValid = signatures.some(sig => {
      try {
        return crypto.timingSafeEqual(Buffer.from(expectedSig), Buffer.from(sig));
      } catch { return false; }
    });
    
    // Check timestamp is within 5 minutes
    const timestampAge = Date.now() / 1000 - parseInt(timestamp);
    if (timestampAge > 300) return null;
    
    return isValid ? JSON.parse(payload) : null;
  } catch (e) {
    console.error('Signature verification failed:', e.message);
    return null;
  }
}

app.post('/api/stripe-webhook', async (req, res) => {
  console.log('\n=== Stripe Webhook ===');
  
  try {
    let event;
    
    // Verify signature if secret is configured
    if (STRIPE_WEBHOOK_SECRET) {
      const signature = req.headers['stripe-signature'];
      const payload = req.body.toString();
      event = verifyStripeSignature(payload, signature);
      
      if (!event) {
        console.warn('Webhook signature verification failed');
        logError('webhook', 'Signature verification failed', { hasSignature: !!signature });
        return res.status(400).json({ error: 'Invalid signature' });
      }
    } else {
      // Dev mode - no signature verification
      // Handle Buffer (from express.raw), string, or object
      if (Buffer.isBuffer(req.body)) {
        event = JSON.parse(req.body.toString());
      } else if (typeof req.body === 'string') {
        event = JSON.parse(req.body);
      } else {
        event = req.body;
      }
    }
    
    // Log all webhook events for debugging
    logWebhookEvent(event.type, { 
      eventId: event.id,
      created: event.created,
      livemode: event.livemode
    });
    
    // Handle subscription renewals (invoice.paid for recurring subscriptions)
    if (event.type === 'invoice.paid') {
      const invoice = event.data.object;
      
      // Only process subscription invoices (not one-time)
      if (invoice.subscription && invoice.billing_reason !== 'subscription_create') {
        const customerEmail = invoice.customer_email;
        const amount = invoice.amount_paid ? invoice.amount_paid / 100 : 0;
        const paymentId = invoice.payment_intent || invoice.id;
        
        // Check if already processed
        if (isPaymentProcessed(paymentId)) {
          console.log('Invoice already processed:', paymentId);
          return res.json({ received: true, processed: false, reason: 'already_processed' });
        }
        
        console.log('Subscription renewal:', { customerEmail, amount, invoiceId: invoice.id });
        
        // Match to subscription by amount
        const subPack = SUBSCRIPTIONS[Math.round(amount)];
        if (subPack && customerEmail) {
          const provider = getOrCreateProvider(customerEmail);
          
          // Add monthly credits
          db.prepare("UPDATE providers SET credit_balance = credit_balance + ?, last_purchase_at = datetime('now') WHERE id = ?")
            .run(subPack.credits, provider.id);
          
          // Extend premium status by 30 days
          const expiresAt = new Date();
          expiresAt.setDate(expiresAt.getDate() + 30);
          db.prepare(`
            UPDATE providers SET verified = 1, priority = CASE WHEN priority < 10 THEN 10 ELSE priority END,
            premium_expires_at = ?
            WHERE id = ?
          `).run(expiresAt.toISOString(), provider.id);
          
          // Log the purchase
          db.prepare('INSERT INTO purchase_log (lead_id, buyer_email, amount, payment_id, status) VALUES (?, ?, ?, ?, ?)')
            .run('SUB_RENEWAL', customerEmail, amount, paymentId, 'Credits Added');
          logCreditTransaction(provider.id, 'renewal', subPack.credits, paymentId, `Monthly subscription renewal - $${amount}`);
          
          // Send confirmation email
          const newBalance = provider.credit_balance + subPack.credits;
          const html = `
<div style="font-family: Arial, sans-serif; max-width: 600px;">
  <h2 style="color: #16a34a;">🔄 Monthly Subscription Renewed!</h2>
  <p>Hi ${provider.company_name},</p>
  <p>Your Featured Partner subscription has been renewed for another month.</p>
  <div style="background: #f0fdf4; border: 1px solid #86efac; padding: 20px; border-radius: 8px; margin: 20px 0;">
    <strong>Credits Added:</strong> ${subPack.credits}<br>
    <strong>New Balance:</strong> ${newBalance} credits
  </div>
  <p><strong>Your benefits continue:</strong></p>
  <ul>
    <li>✅ Verified badge on your listing</li>
    <li>🔝 Priority placement in search results</li>
  </ul>
  <p>— The DumpsterMap Team</p>
</div>`;
          await sendEmail(customerEmail, 'Featured Partner Renewed - Credits Added', html);
          
          await sendAdminNotification('🔄 Subscription Renewed', 
            `Provider: ${provider.company_name}\nEmail: ${customerEmail}\nCredits: +${subPack.credits}\nNew Balance: ${newBalance}`);
          
          logWebhookEvent('invoice.paid', { customerEmail, amount, reason: 'renewal' }, { processed: true, credits: subPack.credits });
          
          return res.json({ received: true, processed: true, type: 'subscription_renewal', credits: subPack.credits });
        }
      }
      
      // Log but don't process (might be initial subscription or non-matching)
      logWebhookEvent('invoice.paid', { 
        invoiceId: invoice.id,
        reason: invoice.billing_reason 
      }, { processed: false });
      
      return res.json({ received: true, processed: false, reason: 'not_renewal_or_no_match' });
    }
    
    if (event.type !== 'checkout.session.completed') {
      return res.json({ received: true, processed: false });
    }
    
    const session = event.data.object;
    const leadId = session.client_reference_id;
    const customerEmail = session.customer_details?.email || session.customer_email;
    const customerName = session.customer_details?.name;
    const amount = session.amount_total ? session.amount_total / 100 : 0;
    const originalAmount = session.amount_subtotal ? session.amount_subtotal / 100 : 0;
    const paymentId = session.payment_intent || session.id;
    const paymentStatus = session.payment_status;
    
    // Log detailed session info for debugging
    console.log('Payment:', { 
      leadId, 
      customerEmail, 
      amount, 
      originalAmount,
      paymentStatus,
      hasLineItems: !!session.line_items,
      metadata: session.metadata
    });
    
    // Log line items if present
    if (session.line_items?.data) {
      console.log('Line items:', JSON.stringify(session.line_items.data, null, 2));
    }
    
    // Idempotency check - don't process same payment twice
    if (isPaymentProcessed(paymentId)) {
      console.log('Payment already processed:', paymentId);
      return res.json({ received: true, processed: false, reason: 'already_processed' });
    }
    
    // Log purchase attempt
    db.prepare('INSERT INTO purchase_log (lead_id, buyer_email, amount, payment_id, status) VALUES (?, ?, ?, ?, ?)').run(leadId || 'CREDIT_PACK', customerEmail, amount, paymentId, 'Processing');
    
    if (paymentStatus !== 'paid') {
      return res.json({ received: true, error: 'Not paid' });
    }
    
    // Check if this is a credit pack purchase (by product ID or amount)
    const matchedPack = matchCreditPack(amount, session);
    
    // Log detection result for debugging
    console.log('Pack detection result:', matchedPack ? `${matchedPack.name} (${matchedPack.credits} credits)` : 'none');
    
    if (matchedPack) {
      const pack = matchedPack;
      const isSubscription = !!matchedPack.isSubscription;
      // === CREDIT PACK OR SUBSCRIPTION PURCHASE ===
      console.log(`${isSubscription ? 'Subscription' : 'Credit pack'} purchase: ${pack.name} (${pack.credits} credits) for $${amount}`);
      
      // Check if this is a pre-registered provider (PROVIDER-{id} reference)
      let provider;
      if (leadId && leadId.startsWith('PROVIDER-')) {
        const providerId = parseInt(leadId.replace('PROVIDER-', ''), 10);
        provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(providerId);
        if (provider) {
          console.log(`Found pre-registered provider: ${provider.company_name} (ID: ${providerId})`);
          // Update email if different (they may have used different email at checkout)
          if (customerEmail && customerEmail.toLowerCase() !== provider.email.toLowerCase()) {
            console.log(`Note: Checkout email (${customerEmail}) differs from registration (${provider.email})`);
          }
        } else {
          console.log(`Provider ID ${providerId} not found, falling back to email lookup`);
        }
      }
      
      // Fallback: Get or create provider by email
      if (!provider) {
        provider = getOrCreateProvider(customerEmail, customerName);
      }
      
      // Add credits and update last purchase time
      db.prepare("UPDATE providers SET credit_balance = credit_balance + ?, last_purchase_at = datetime('now') WHERE id = ?").run(pack.credits, provider.id);
      logCreditTransaction(provider.id, isSubscription ? 'subscription' : 'purchase', pack.credits, paymentId, `${pack.name} - $${amount}`);
      
      // Apply perks for Pro/Premium/Featured Partner purchases
      // Pro Pack ($700), Premium ($1500) and Featured Partner ($99) get 30-day verified + priority
      const hasPremiumPerks = pack.perks || pack.name === 'Premium Pack' || pack.name === 'Pro Pack' || pack.credits >= 20;
      
      if (hasPremiumPerks) {
        // Set 30-day expiration for premium features
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 30);
        
        db.prepare(`
          UPDATE providers SET 
            verified = 1, 
            priority = CASE WHEN priority < 10 THEN 10 ELSE priority END,
            premium_expires_at = ?
          WHERE id = ?
        `).run(expiresAt.toISOString(), provider.id);
        
        console.log(`Premium perks activated for ${provider.company_name} until ${expiresAt.toISOString()}`);
      }
      
      // Update purchase log
      const packType = isSubscription ? `SUB_${pack.credits}` : `PACK_${pack.credits}`;
      db.prepare('UPDATE purchase_log SET status = ?, lead_id = ? WHERE payment_id = ?').run('Credits Added', packType, paymentId);
      
      // Send confirmation email
      const newBalance = provider.credit_balance + pack.credits;
      const subscriptionPerks = isSubscription ? `
  <div style="background: #fef3c7; border: 1px solid #fcd34d; padding: 15px; border-radius: 8px; margin: 10px 0;">
    <strong>🏆 Featured Partner Benefits Active:</strong>
    <ul style="margin: 5px 0 0 15px; padding: 0;">
      <li>✅ Verified Badge on your listing</li>
      <li>🔝 Priority placement in search results</li>
      <li>📧 ${pack.credits} leads included each month</li>
    </ul>
  </div>` : '';
      
      const html = `
<div style="font-family: Arial, sans-serif; max-width: 600px;">
  <h2 style="color: #16a34a;">✅ ${pack.name} Activated!</h2>
  <p>Thanks for your ${isSubscription ? 'subscription' : 'purchase'}! Your account has been credited.</p>
  <div style="background: #f0fdf4; border: 1px solid #86efac; padding: 20px; border-radius: 8px; margin: 20px 0;">
    <strong>Credits Added:</strong> ${pack.credits}<br>
    <strong>New Balance:</strong> ${newBalance} credits
  </div>${subscriptionPerks}
  <p>You'll now automatically receive full contact details for leads in your service area.</p>
  <div style="background: #f9f9f9; padding: 15px; border-radius: 8px; margin: 20px 0;">
    <strong>Next Steps:</strong>
    <ol style="margin: 10px 0 0 0; padding-left: 20px;">
      <li>Make sure your service zips are set up (reply to this email with your zip codes)</li>
      <li>You'll receive leads via email as customers request quotes</li>
      <li>Call leads within 5 minutes for best conversion</li>
    </ol>
  </div>
  <p><a href="https://dumpstermap.io/balance" style="color: #2563eb;">Check your balance</a> | <a href="https://dumpstermap.io/for-providers" style="color: #2563eb;">Buy more credits</a></p>
  <p>Questions? Reply to this email.</p>
  <p>— DumpsterMap</p>
</div>`;
      
      const emailSent = await sendEmail(customerEmail, `${pack.name} Activated - ${pack.credits} Credits Added`, html);
      
      // Notify admin
      const isNewProvider = provider.notes?.includes('Auto-created');
      const purchaseType = isSubscription ? '🔄' : '💰';
      await sendAdminNotification(
        `${purchaseType} ${pack.name} Purchased${isNewProvider ? ' (NEW PROVIDER)' : ''}`,
        `Buyer: ${customerEmail}\nAmount: $${amount}\nCredits: ${pack.credits}\nNew Balance: ${provider.credit_balance + pack.credits}\nType: ${isSubscription ? 'Monthly Subscription' : 'One-time Pack'}\n${isNewProvider ? '⭐ Auto-created provider account' : ''}`
      );
      
      // Log successful webhook processing
      logWebhookEvent('checkout.session.completed', {
        customerEmail,
        amount,
        type: isSubscription ? 'subscription' : 'credit_pack',
        packName: pack.name
      }, { processed: true, credits: pack.credits, emailSent });
      
      // Track conversion event if this was from a pre-registered provider
      if (leadId && leadId.startsWith('PROVIDER-')) {
        try {
          db.prepare(`
            INSERT INTO registration_events (event_type, provider_id, email, selected_pack, source, metadata)
            VALUES ('purchase', ?, ?, ?, 'stripe', ?)
          `).run(provider.id, customerEmail, packType, JSON.stringify({ amount, packName: pack.name }));
        } catch (e) {
          console.log('Purchase tracking skipped:', e.message);
        }
      }
      
      return res.json({ received: true, processed: true, type: isSubscription ? 'subscription' : 'credit_pack', credits: pack.credits, emailSent });
    }
    
    // === SINGLE LEAD PURCHASE ($40) ===
    if (!leadId) {
      // No lead ID and not a credit pack - unknown purchase
      await sendAdminNotification('⚠️ Unknown Payment', `Customer: ${customerEmail}\nAmount: $${amount}\nNo lead ID, not a credit pack.`);
      return res.json({ received: true, error: 'Unknown purchase type' });
    }
    
    const lead = getLeadById(leadId);
    if (!lead) {
      await sendAdminNotification('⚠️ Lead Not Found', `Lead ${leadId} not found\nCustomer: ${customerEmail}`);
      return res.json({ received: true, error: 'Lead not found' });
    }
    
    // Send full lead details - minimal HTML for inbox delivery
    const html = `
<div style="font-family: Arial, sans-serif; max-width: 600px; line-height: 1.6; color: #333;">
  <p>Here are the contact details for your lead:</p>
  
  <p style="margin: 16px 0; padding: 12px; background: #f9f9f9;">
    <strong>${lead.name}</strong><br>
    Phone: ${lead.phone}<br>
    Email: ${lead.email}
  </p>
  
  <p>
    Location: ${lead.zip}<br>
    Size: ${lead.size || 'Not specified'}<br>
    Timeline: ${lead.timeframe || 'Not specified'}<br>
    Project: ${lead.project_type || 'General'}
  </p>
  
  <p>Call them soon - they're actively looking for service.</p>
  
  <p>— DumpsterMap<br>
  <a href="https://dumpstermap.io">dumpstermap.io</a></p>
  
  <p style="font-size: 13px; color: #666; margin-top: 20px;">
    Questions? Reply to this email.
  </p>
</div>`;

    // Plain text version
    const text = `Here are the contact details for your lead:

${lead.name}
Phone: ${lead.phone}
Email: ${lead.email}

Location: ${lead.zip}
Size: ${lead.size || 'Not specified'}
Timeline: ${lead.timeframe || 'Not specified'}
Project: ${lead.project_type || 'General'}

Call them soon - they're actively looking for service.

— DumpsterMap
dumpstermap.io`;
    
    const emailSent = await sendEmail(customerEmail, `Lead details - ${lead.name} in ${lead.zip}`, html, text);
    
    // Look up provider by email for tracking
    const purchasingProvider = getProviderByEmail(customerEmail);
    
    // Update lead with purchase info and provider tracking
    db.prepare(`
      UPDATE leads SET status = 'Purchased', purchased_by = ?, purchased_at = datetime('now'), payment_id = ?, email_sent = ?,
      assigned_provider = COALESCE(assigned_provider, ?), assigned_provider_id = COALESCE(assigned_provider_id, ?)
      WHERE lead_id = ?
    `).run(customerEmail, paymentId, emailSent ? 'Yes' : 'Failed', 
           purchasingProvider?.company_name || null, purchasingProvider?.id || null, leadId);
    
    db.prepare('UPDATE purchase_log SET status = ? WHERE payment_id = ?').run(emailSent ? 'Success' : 'Email Failed', paymentId);
    
    await sendAdminNotification(`${emailSent ? '✅' : '❌'} Lead ${leadId} purchased`, 
      `Buyer: ${customerEmail}\nAmount: $${amount}\nLead: ${lead.name} | ${lead.phone}\nEmail sent: ${emailSent ? 'Yes' : 'FAILED'}`);
    
    res.json({ received: true, processed: true, type: 'single_lead', emailSent });
  } catch (error) {
    console.error('Webhook error:', error);
    logError('webhook', error.message, { 
      eventType: event?.type,
      sessionId: event?.data?.object?.id
    }, error);
    await sendAdminNotification('❌ Webhook Error', `${error.message}\n\nStack: ${error.stack?.slice(0, 500)}`);
    res.json({ received: true, error: error.message });
  }
});

// ============================================
// PROVIDER REGISTRATION (Pre-purchase signup)
// ============================================

// Stripe payment links for credit packs
const STRIPE_PACK_LINKS = {
  single: 'https://buy.stripe.com/cNidR9aQ76T46IF78j5Rm04',    // $40 - Single lead
  starter: 'https://buy.stripe.com/00w14n5vNa5g5EB2S35Rm00',   // $200 - 5 credits
  pro: 'https://buy.stripe.com/fZu6oH7DVgtE7MJdwH5Rm02',       // $700 - 20 credits  
  premium: 'https://buy.stripe.com/bJefZh0btcdod73eAL5Rm03',   // $1500 - 60 credits
  featured: 'https://buy.stripe.com/28EdR9e2jelwgjfgIT5Rm01'   // $99/mo - Featured Partner subscription
};

// Register new provider (before purchase)
app.post('/api/provider/register', async (req, res) => {
  console.log('\n=== Provider Registration ===');
  
  try {
    const {
      company_name,
      street_address,
      city,
      state,
      business_zip,
      phone,
      email,
      website,
      service_areas,
      selected_pack
    } = req.body;
    
    // Validation
    if (!company_name || !email || !phone) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        required: ['company_name', 'email', 'phone']
      });
    }
    
    // Validate email format
    const emailLower = email.toLowerCase().trim();
    if (!emailLower.includes('@') || !emailLower.includes('.')) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    
    // Check if provider already exists
    const existing = getProviderByEmail(emailLower);
    if (existing) {
      // Provider exists - return their ID for purchase
      console.log(`Existing provider found: ${existing.id}`);
      
      // Update their info if provided
      if (street_address || city || state || business_zip) {
        db.prepare(`
          UPDATE providers SET
            street_address = COALESCE(?, street_address),
            city = COALESCE(?, city),
            state = COALESCE(?, state),
            business_zip = COALESCE(?, business_zip),
            website = COALESCE(?, website),
            service_zips = COALESCE(NULLIF(?, ''), service_zips)
          WHERE id = ?
        `).run(street_address, city, state, business_zip, website, service_areas, existing.id);
      }
      
      const packLink = STRIPE_PACK_LINKS[selected_pack] || STRIPE_PACK_LINKS.starter;
      const redirectUrl = `${packLink}?client_reference_id=PROVIDER-${existing.id}&prefilled_email=${encodeURIComponent(emailLower)}`;
      
      return res.json({
        status: 'ok',
        message: 'Welcome back! Redirecting to checkout...',
        provider_id: existing.id,
        redirect_url: redirectUrl,
        is_existing: true
      });
    }
    
    // Create new provider
    const result = db.prepare(`
      INSERT INTO providers (
        company_name, email, phone, street_address, city, state, 
        business_zip, website, service_zips, status, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active', 'Registered via website')
    `).run(
      company_name.trim(),
      emailLower,
      phone.trim(),
      street_address?.trim() || null,
      city?.trim() || null,
      state?.trim()?.toUpperCase() || null,
      business_zip?.trim() || null,
      website?.trim() || null,
      service_areas?.trim() || null
    );
    
    const providerId = result.lastInsertRowid;
    console.log(`New provider created: ${providerId} - ${company_name}`);
    
    // Track registration event for funnel analysis
    try {
      db.prepare(`
        INSERT INTO registration_events (event_type, provider_id, email, selected_pack, source, metadata)
        VALUES ('registration', ?, ?, ?, 'website', ?)
      `).run(providerId, emailLower, selected_pack || 'starter', JSON.stringify({
        company_name: company_name.trim(),
        city: city?.trim(),
        state: state?.trim()?.toUpperCase()
      }));
    } catch (e) {
      console.log('Registration tracking skipped:', e.message);
    }
    
    // Build redirect URL to Stripe with provider ID
    const packLink = STRIPE_PACK_LINKS[selected_pack] || STRIPE_PACK_LINKS.starter;
    const redirectUrl = `${packLink}?client_reference_id=PROVIDER-${providerId}&prefilled_email=${encodeURIComponent(emailLower)}`;
    
    // Notify admin
    await sendAdminNotification('🆕 New Provider Registered', 
      `${company_name}\n${emailLower}\n${phone}\n${city}, ${state} ${business_zip}\nService: ${service_areas || 'Not set'}\nPack: ${selected_pack || 'starter'}`);
    
    res.json({
      status: 'ok',
      message: 'Registration successful! Redirecting to checkout...',
      provider_id: providerId,
      redirect_url: redirectUrl,
      is_existing: false
    });
    
  } catch (error) {
    console.error('Registration error:', error);
    logError('registration', error.message, req.body);
    res.status(500).json({ error: 'Registration failed', message: error.message });
  }
});

// Get provider by ID (for profile completion)
app.get('/api/provider/:id', (req, res) => {
  const provider = db.prepare('SELECT id, company_name, email, phone, street_address, city, state, business_zip, service_zips, credit_balance, verified, priority, lat, lng FROM providers WHERE id = ?').get(req.params.id);
  
  if (!provider) {
    return res.status(404).json({ error: 'Provider not found' });
  }
  
  res.json({ status: 'ok', provider });
});

// ============================================
// PROVIDER SELF-SERVICE
// ============================================

// Update service zips (provider self-service)
app.post('/api/provider/zips', (req, res) => {
  const email = (req.body.email || '').toLowerCase().trim();
  const phoneLast4 = (req.body.phone || '').replace(/\D/g, '').slice(-4);
  const zips = req.body.zips || '';
  
  if (!email || !phoneLast4) {
    return res.status(400).json({ error: 'Email and phone last 4 digits required' });
  }
  
  const provider = getProviderByEmail(email);
  if (!provider) {
    return res.status(404).json({ error: 'Provider not found' });
  }
  
  // Verify phone
  const providerLast4 = (provider.phone || '').replace(/\D/g, '').slice(-4);
  if (phoneLast4 !== providerLast4 && providerLast4) {
    return res.status(401).json({ error: 'Phone verification failed' });
  }
  
  // Clean and validate zips
  const cleanZips = zips.split(/[,\s]+/)
    .map(z => z.trim())
    .filter(z => /^\d{5}$/.test(z))
    .join(', ');
  
  db.prepare('UPDATE providers SET service_zips = ? WHERE id = ?').run(cleanZips, provider.id);
  
  const zipCount = cleanZips ? cleanZips.split(', ').length : 0;
  console.log(`Provider ${email} updated zips: ${zipCount} zips`);
  
  res.json({
    status: 'ok',
    message: `Service zips updated: ${zipCount} zip codes`,
    serviceZips: cleanZips
  });
});

// ============================================
// BALANCE CHECK
// ============================================
app.get('/api/balance', (req, res) => {
  const email = (req.query.email || '').toLowerCase().trim();
  const phoneLast4 = req.query.phone || '';
  
  const provider = getProviderByEmail(email);
  if (!provider) {
    return res.json({ status: 'error', message: 'No provider found' });
  }
  
  const providerLast4 = (provider.phone || '').replace(/\D/g, '').slice(-4);
  if (phoneLast4 !== providerLast4) {
    return res.json({ status: 'error', message: 'Phone verification failed' });
  }
  
  // Get recent purchase history for this provider
  const purchases = db.prepare(`
    SELECT timestamp, lead_id, amount, status 
    FROM purchase_log 
    WHERE LOWER(buyer_email) = LOWER(?) 
    ORDER BY id DESC 
    LIMIT 10
  `).all(email);
  
  // Get leads sent to this provider (credits used)
  const leadsReceived = db.prepare(`
    SELECT created_at, lead_id, name, zip, status 
    FROM leads 
    WHERE LOWER(assigned_provider) = LOWER(?) 
    ORDER BY id DESC 
    LIMIT 10
  `).all(provider.company_name);
  
  res.json({
    status: 'ok',
    companyName: provider.company_name,
    creditBalance: provider.credit_balance,
    totalLeadsReceived: provider.total_leads,
    plan: provider.plan,
    recentPurchases: purchases.map(p => ({
      date: p.timestamp?.split('T')[0] || '',
      type: p.lead_id?.startsWith('PACK_') ? `Credit Pack (+${p.lead_id.replace('PACK_', '')} credits)` : 
            p.lead_id?.startsWith('LEAD-') ? `Single Lead (${p.lead_id})` : p.lead_id,
      amount: p.amount,
      status: p.status
    })),
    recentLeads: leadsReceived.map(l => ({
      date: l.created_at?.split('T')[0] || '',
      leadId: l.lead_id,
      name: l.name,
      zip: l.zip,
      status: l.status
    }))
  });
});

// ============================================
// ADMIN UI
// ============================================
app.get('/admin', (req, res) => {
  const auth = req.query.key;
  if (auth !== ADMIN_PASSWORD) {
    return res.send('<h1>Admin Login</h1><form><input name="key" type="password" placeholder="Password"><button>Login</button></form>');
  }
  
  const leads = db.prepare('SELECT * FROM leads ORDER BY id DESC LIMIT 100').all();
  const providers = db.prepare('SELECT * FROM providers ORDER BY id DESC').all();
  const purchases = db.prepare('SELECT * FROM purchase_log ORDER BY id DESC LIMIT 50').all();
  
  // Stats
  const totalLeads = db.prepare('SELECT COUNT(*) as cnt FROM leads').get().cnt;
  const totalRevenue = db.prepare("SELECT SUM(amount) as total FROM purchase_log WHERE status LIKE '%Success%' OR status LIKE '%credit%'").get().total || 0;
  const totalCredits = providers.reduce((sum, p) => sum + (p.credit_balance || 0), 0);
  
  // Today's activity
  const leadsToday = db.prepare("SELECT COUNT(*) as cnt FROM leads WHERE date(created_at) = date('now')").get().cnt;
  const revenueToday = db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM purchase_log WHERE date(timestamp) = date('now') AND (status LIKE '%Success%' OR status = 'Credits Added')").get().total;
  const newProvidersToday = db.prepare("SELECT COUNT(*) as cnt FROM providers WHERE date(created_at) = date('now')").get().cnt;
  const providersNoZips = db.prepare("SELECT COUNT(*) as cnt FROM providers WHERE status = 'Active' AND (service_zips IS NULL OR service_zips = '')").get().cnt;
  const providersNoZipsList = db.prepare("SELECT id, company_name, email FROM providers WHERE status = 'Active' AND (service_zips IS NULL OR service_zips = '') ORDER BY id DESC LIMIT 10").all();
  const providersWithCreditsNoZips = db.prepare("SELECT COUNT(*) as cnt FROM providers WHERE status = 'Active' AND credit_balance > 0 AND (service_zips IS NULL OR service_zips = '')").get().cnt;
  
  // Outreach stats
  const outreachPending = db.prepare("SELECT COUNT(*) as cnt FROM outreach WHERE email_status = 'Pending'").get().cnt;
  const outreachSentToday = db.prepare("SELECT COUNT(*) as cnt FROM outreach WHERE date(email_sent_at) = date('now')").get().cnt;
  const outreachConverted = db.prepare("SELECT COUNT(*) as cnt FROM outreach WHERE converted = 1").get().cnt;
  
  // Provider states breakdown
  const providersByState = db.prepare("SELECT UPPER(state) as state, COUNT(*) as cnt FROM providers WHERE status = 'Active' AND state IS NOT NULL AND state != '' GROUP BY UPPER(state) ORDER BY cnt DESC LIMIT 5").all();
  
  // Recent errors for dashboard
  const recentErrorCount = db.prepare("SELECT COUNT(*) as cnt FROM error_log WHERE timestamp > datetime('now', '-24 hours')").get().cnt;
  const recentErrors = db.prepare("SELECT * FROM error_log ORDER BY id DESC LIMIT 5").all();
  
  const html = `
<!DOCTYPE html>
<html>
<head>
  <title>DumpsterMap Admin</title>
  <style>
    body { font-family: system-ui; padding: 20px; max-width: 1600px; margin: 0 auto; background: #f8fafc; }
    .stats { display: flex; gap: 20px; margin-bottom: 30px; }
    .stat { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); flex: 1; }
    .stat-value { font-size: 32px; font-weight: bold; color: #1e40af; }
    .stat-label { color: #64748b; font-size: 14px; }
    table { border-collapse: collapse; width: 100%; margin: 20px 0; font-size: 13px; background: white; }
    th, td { border: 1px solid #e2e8f0; padding: 10px; text-align: left; }
    th { background: #f1f5f9; font-weight: 600; }
    tr:hover { background: #f8fafc; }
    h2 { margin-top: 40px; color: #1e293b; }
    .status-new { color: #2563eb; }
    .status-sent { color: #16a34a; }
    .status-purchased { color: #9333ea; font-weight: bold; }
    .btn { padding: 8px 16px; background: #2563eb; color: white; border: none; border-radius: 4px; cursor: pointer; margin: 2px; text-decoration: none; display: inline-block; font-size: 13px; }
    .btn:hover { background: #1d4ed8; }
    .btn-sm { padding: 4px 8px; font-size: 11px; }
    .btn-green { background: #16a34a; }
    .btn-green:hover { background: #15803d; }
    .btn-red { background: #dc2626; }
    .btn-red:hover { background: #b91c1c; }
    .card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 20px; }
    input, select { padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 4px; }
    .credit-badge { background: #dcfce7; color: #16a34a; padding: 2px 8px; border-radius: 999px; font-weight: bold; }
    .nav { background: white; padding: 15px 20px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .nav a { margin-right: 20px; color: #2563eb; text-decoration: none; font-weight: 500; }
    .nav a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <h1>🗑️ DumpsterMap Admin</h1>
  
  <div class="nav">
    <a href="#leads">Leads</a>
    <a href="#providers">Providers</a>
    <a href="#add-credits">Add Credits</a>
    <a href="#purchases">Purchases</a>
    <a href="/admin/outreach?key=${auth}">Outreach</a>
    <a href="/admin/logs?key=${auth}">System Logs</a>
    <a href="/admin/funnel?key=${auth}">📊 Funnel</a>
    <a href="/api/admin/credit-history?key=${auth}" target="_blank">💳 Credit History</a>
    <a href="/api/admin/subscriptions?key=${auth}" target="_blank">🔄 Subscriptions</a>
    <a href="/api/admin/stats?key=${auth}" target="_blank">📈 API Stats</a>
  </div>
  
  <!-- Quick Actions -->
  <div class="card" style="background: linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%); border-left: 4px solid #16a34a;">
    <h3 style="margin: 0 0 15px 0; color: #16a34a;">⚡ Quick Actions</h3>
    <div style="display: flex; gap: 10px; flex-wrap: wrap;">
      <form action="/api/admin/maintenance?key=${auth}" method="POST" style="display: inline;">
        <button class="btn btn-sm btn-green" title="Run premium expiration, send reminders, cleanup logs">🔧 Run Maintenance</button>
      </form>
      <a href="/api/admin/daily-summary?key=${auth}" class="btn btn-sm" target="_blank" title="View today's summary JSON">📊 Daily Summary</a>
      <a href="/api/admin/zip-coverage?key=${auth}" class="btn btn-sm" target="_blank" title="See ZIP coverage gaps">🗺️ ZIP Coverage</a>
      <a href="/api/admin/stripe-status?key=${auth}" class="btn btn-sm" target="_blank" title="Check Stripe webhook config">💳 Stripe Status</a>
      <form action="/api/admin/expire-premium?key=${auth}" method="POST" style="display: inline;">
        <button class="btn btn-sm" style="background: #f59e0b;">⏱️ Expire Premium</button>
      </form>
      <a href="/api/admin/weekly-summary?key=${auth}" class="btn btn-sm" target="_blank" title="Weekly trends and comparison">📈 Weekly Summary</a>
      ${providersWithCreditsNoZips > 0 ? `<form action="/api/admin/send-zip-reminders?key=${auth}" method="POST" style="display: inline;" onsubmit="return confirm('Send ZIP setup reminders to ${providersWithCreditsNoZips} provider(s)?')"><button class="btn btn-sm btn-red" title="Email providers with credits but no ZIPs">📧 Send ZIP Reminders</button></form>` : ''}
    </div>
  </div>
  
  <!-- Today's Activity -->
  <div class="card" style="background: linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%); border-left: 4px solid #2563eb;">
    <h3 style="margin: 0 0 15px 0; color: #1e40af;">📊 Today's Activity</h3>
    <div style="display: flex; gap: 30px; flex-wrap: wrap;">
      <div><span style="font-size: 24px; font-weight: bold; color: #1e40af;">${leadsToday}</span><br><span style="color: #64748b; font-size: 13px;">Leads Today</span></div>
      <div><span style="font-size: 24px; font-weight: bold; color: #16a34a;">$${revenueToday.toFixed(0)}</span><br><span style="color: #64748b; font-size: 13px;">Revenue Today</span></div>
      <div><span style="font-size: 24px; font-weight: bold; color: #9333ea;">${newProvidersToday}</span><br><span style="color: #64748b; font-size: 13px;">New Providers</span></div>
      <div><span style="font-size: 24px; font-weight: bold; color: #2563eb;">${outreachSentToday}</span><br><span style="color: #64748b; font-size: 13px;">Outreach Sent</span><br><span style="color: #94a3b8; font-size: 11px;">${outreachPending} pending, ${outreachConverted} converted</span></div>
      ${providersNoZips > 0 ? `<div style="background: #fef3c7; padding: 8px 12px; border-radius: 6px;"><span style="font-size: 18px; font-weight: bold; color: #b45309;">⚠️ ${providersNoZips}</span><br><span style="color: #92400e; font-size: 13px;">Providers without ZIPs</span>${providersWithCreditsNoZips > 0 ? `<br><span style="color: #dc2626; font-size: 12px; font-weight: bold;">🚨 ${providersWithCreditsNoZips} have credits!</span>` : ''}</div>` : ''}
    </div>
  </div>
  
  ${providersWithCreditsNoZips > 0 ? `
  <div class="card" style="background: linear-gradient(135deg, #fef2f2 0%, #fecaca 100%); border-left: 4px solid #dc2626; margin-bottom: 20px;">
    <h3 style="margin: 0 0 10px 0; color: #dc2626;">🚨 Action Needed: ${providersWithCreditsNoZips} Provider${providersWithCreditsNoZips > 1 ? 's' : ''} with Credits but No Service ZIPs</h3>
    <p style="color: #7f1d1d; font-size: 13px; margin-bottom: 10px;">These providers paid for leads but won't receive any until their service ZIPs are configured:</p>
    <div style="display: flex; gap: 10px; flex-wrap: wrap;">
      ${providersNoZipsList.filter(p => providers.find(pr => pr.id === p.id)?.credit_balance > 0).slice(0, 5).map(p => `
        <a href="/admin/edit-provider/${p.id}?key=${auth}" style="background: white; padding: 8px 12px; border-radius: 4px; text-decoration: none; color: #1e293b; font-size: 13px; box-shadow: 0 1px 2px rgba(0,0,0,0.1);">
          <strong>${p.company_name}</strong><br>
          <span style="color: #64748b; font-size: 11px;">${p.email}</span>
        </a>
      `).join('')}
    </div>
  </div>
  ` : ''}
  
  ${recentErrorCount > 0 ? `
  <div class="card" style="background: linear-gradient(135deg, #fef2f2 0%, #fee2e2 100%); border-left: 4px solid #f87171;">
    <h3 style="margin: 0 0 10px 0; color: #dc2626;">⚠️ Recent Errors (${recentErrorCount} in last 24h)</h3>
    <table style="font-size: 12px; margin: 0;">
      <tr><th style="padding: 6px;">Time</th><th style="padding: 6px;">Type</th><th style="padding: 6px;">Message</th></tr>
      ${recentErrors.slice(0, 5).map(e => `
        <tr>
          <td style="padding: 6px; white-space: nowrap;">${e.timestamp?.split('T')[1]?.slice(0, 8) || ''}</td>
          <td style="padding: 6px; color: #dc2626;">${e.type || ''}</td>
          <td style="padding: 6px; max-width: 400px; overflow: hidden; text-overflow: ellipsis;">${e.message || ''}</td>
        </tr>
      `).join('')}
    </table>
    <a href="/admin/logs?key=${auth}" style="font-size: 12px; color: #dc2626; text-decoration: underline;">View all logs →</a>
  </div>
  ` : ''}
  
  <div class="stats">
    <div class="stat"><div class="stat-value">${totalLeads}</div><div class="stat-label">Total Leads</div></div>
    <div class="stat"><div class="stat-value">$${totalRevenue.toFixed(0)}</div><div class="stat-label">Revenue</div></div>
    <div class="stat"><div class="stat-value">${providers.length}</div><div class="stat-label">Providers</div></div>
    <div class="stat"><div class="stat-value">${totalCredits}</div><div class="stat-label">Credits Outstanding</div></div>
    <div class="stat" style="min-width: 140px;"><div style="font-size: 13px; color: #64748b;">Top States</div><div style="font-size: 12px; margin-top: 6px;">${providersByState.length > 0 ? providersByState.map(s => `<span style="background: #e0e7ff; padding: 2px 6px; border-radius: 4px; margin: 2px;">${s.state}: ${s.cnt}</span>`).join(' ') : '<em>None set</em>'}</div></div>
  </div>
  
  <h2 id="leads">Leads (${leads.length})</h2>
  <table>
    <tr><th>ID</th><th>Date</th><th>Name</th><th>Phone</th><th>Email</th><th>Zip</th><th>Size</th><th>Status</th><th>Notified</th><th>Purchased By</th><th>Actions</th></tr>
    ${leads.map(l => {
      const statusClass = l.status === 'Purchased' ? 'status-purchased' : l.status === 'Sent' ? 'status-sent' : 'status-new';
      const notifiedCount = l.providers_notified ? l.providers_notified.split(',').length : 0;
      const notifiedTitle = l.providers_notified || 'No providers notified';
      return `
      <tr>
        <td>${l.lead_id}</td>
        <td>${l.created_at?.split('T')[0] || ''}</td>
        <td>${l.name || ''}</td>
        <td>${l.phone || ''}</td>
        <td>${l.email || ''}</td>
        <td>${l.zip || ''}</td>
        <td>${l.size || ''}</td>
        <td class="${statusClass}">${l.status || 'New'}</td>
        <td title="${notifiedTitle}">${notifiedCount > 0 ? notifiedCount + ' providers' : '<em style="color:#dc2626">none</em>'}</td>
        <td>${l.purchased_by || ''}</td>
        <td>
          <form action="/admin/resend-lead/${l.lead_id}?key=${auth}" method="POST" style="display:inline;">
            <button class="btn btn-sm" title="Resend to matching providers">↻</button>
          </form>
        </td>
      </tr>`;
    }).join('')}
  </table>
  
  <h2 id="providers">Providers (${providers.length})</h2>
  <div style="margin-bottom: 15px;">
    <input type="text" id="providerSearch" placeholder="Search providers..." style="padding: 10px; width: 300px; border: 1px solid #d1d5db; border-radius: 4px;" onkeyup="filterProviders()">
    <select id="providerFilter" style="padding: 10px; margin-left: 10px;" onchange="filterProviders()">
      <option value="">All Status</option>
      <option value="active">Active Only</option>
      <option value="credits">Has Credits</option>
      <option value="nozips">Missing ZIPs</option>
      <option value="premium">Premium/Verified</option>
    </select>
  </div>
  <script>
    function filterProviders() {
      const search = document.getElementById('providerSearch').value.toLowerCase();
      const filter = document.getElementById('providerFilter').value;
      const rows = document.querySelectorAll('#providerTable tbody tr');
      rows.forEach(row => {
        const text = row.textContent.toLowerCase();
        const credits = parseInt(row.querySelector('.credit-badge')?.textContent || '0');
        const hasZips = !row.innerHTML.includes('none!');
        const isPremium = row.innerHTML.includes('✓ Verified') || row.innerHTML.includes('⭐');
        let show = text.includes(search);
        if (filter === 'active') show = show && row.innerHTML.includes('Active');
        if (filter === 'credits') show = show && credits > 0;
        if (filter === 'nozips') show = show && !hasZips;
        if (filter === 'premium') show = show && isPremium;
        row.style.display = show ? '' : 'none';
      });
    }
  </script>
  <table id="providerTable">
    <tr><th>ID</th><th>Company</th><th>Email</th><th>Phone</th><th>Address</th><th>Zips</th><th>Credits</th><th>Leads</th><th>Premium Status</th><th>Last Purchase</th><th>Actions</th></tr>
    ${providers.map(p => {
      const verifiedBadge = p.verified ? '<span title="Verified" style="color:#16a34a">✓</span> ' : '';
      const priorityBadge = p.priority > 0 ? `<span title="Priority: ${p.priority}" style="color:#f59e0b">⭐</span>` : '';
      const lastPurchase = p.last_purchase_at ? p.last_purchase_at.split('T')[0] : '<em style="color:#94a3b8">never</em>';
      const zipCount = p.service_zips ? p.service_zips.split(',').filter(z => z.trim()).length : 0;
      const zipDisplay = zipCount > 0 ? `<span title="${p.service_zips}">${zipCount} zips</span>` : '<em style="color:#dc2626">none!</em>';
      const addressDisplay = p.address ? `<span title="${p.address}">${p.address.substring(0, 20)}${p.address.length > 20 ? '...' : ''}</span>` : '<em style="color:#94a3b8">-</em>';
      
      // Premium status display
      let premiumStatus = '';
      if (p.premium_expires_at) {
        const expiresDate = new Date(p.premium_expires_at);
        const now = new Date();
        const daysLeft = Math.ceil((expiresDate - now) / (1000 * 60 * 60 * 24));
        if (daysLeft > 0) {
          premiumStatus = `<div style="font-size:11px;">
            ${p.verified ? '<span style="color:#16a34a">✓ Verified</span><br>' : ''}
            ${p.priority > 0 ? '<span style="color:#f59e0b">⭐ Priority: ' + p.priority + '</span><br>' : ''}
            <span style="color:#6366f1">⏱ ${daysLeft}d left</span>
          </div>`;
        } else {
          premiumStatus = '<em style="color:#94a3b8;font-size:11px;">Expired</em>';
        }
      } else if (p.verified || p.priority > 0) {
        premiumStatus = `<div style="font-size:11px;">
          ${p.verified ? '<span style="color:#16a34a">✓ Verified</span><br>' : ''}
          ${p.priority > 0 ? '<span style="color:#f59e0b">⭐ Priority: ' + p.priority + '</span>' : ''}
        </div>`;
      } else {
        premiumStatus = '<em style="color:#94a3b8;font-size:11px;">-</em>';
      }
      
      return `
        <tr>
          <td>${p.id}</td>
          <td>${verifiedBadge}${priorityBadge}${p.company_name}</td>
          <td>${p.email}</td>
          <td>${p.phone || ''}</td>
          <td>${addressDisplay}</td>
          <td>${zipDisplay}</td>
          <td><span class="credit-badge">${p.credit_balance}</span></td>
          <td>${p.total_leads}</td>
          <td>${premiumStatus}</td>
          <td>${lastPurchase}</td>
          <td>
            <a href="/admin/edit-provider/${p.id}?key=${auth}" class="btn btn-sm">Edit</a>
          </td>
        </tr>
      `;
    }).join('')}
  </table>
  
  <div class="card">
    <h3>Add New Provider</h3>
    <form action="/admin/add-provider?key=${auth}" method="POST" style="display: flex; gap: 10px; flex-wrap: wrap; align-items: center;">
      <input name="company_name" placeholder="Company Name" required style="min-width: 180px;">
      <input name="email" placeholder="Email" required type="email">
      <input name="phone" placeholder="Phone">
      <input name="city" placeholder="City">
      <input name="state" placeholder="ST" style="width: 50px;" maxlength="2">
      <input name="service_zips" placeholder="Service ZIPs (comma-sep)" style="min-width: 180px;">
      <input name="credit_balance" placeholder="Credits" type="number" value="0" style="width: 80px;">
      <button class="btn btn-green">Add Provider</button>
    </form>
  </div>
  
  <div class="card" id="add-credits">
    <h3>Quick Add Credits</h3>
    <form action="/admin/add-credits?key=${auth}" method="POST" style="display: flex; gap: 10px; align-items: center;">
      <select name="provider_id" required style="min-width: 200px;">
        <option value="">Select Provider...</option>
        ${providers.map(p => `<option value="${p.id}">${p.company_name} (${p.credit_balance} credits)</option>`).join('')}
      </select>
      <input name="credits" type="number" placeholder="Credits" required style="width: 100px;">
      <input name="reason" placeholder="Reason (optional)" style="width: 200px;">
      <button class="btn btn-green">Add Credits</button>
    </form>
  </div>
  
  <div class="card" id="bulk-credits">
    <h3>📦 Bulk Add Credits</h3>
    <p style="color: #64748b; font-size: 13px; margin-bottom: 10px;">Add credits to multiple providers at once. Hold Ctrl/Cmd to select multiple.</p>
    <form action="/admin/bulk-add-credits?key=${auth}" method="POST" style="display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-start;">
      <select name="provider_ids" multiple required style="min-width: 280px; height: 120px;">
        ${providers.filter(p => p.status === 'Active').map(p => `<option value="${p.id}">${p.company_name} (${p.credit_balance} cr)</option>`).join('')}
      </select>
      <div style="display: flex; flex-direction: column; gap: 8px;">
        <input name="credits" type="number" placeholder="Credits each" required style="width: 120px;">
        <input name="reason" placeholder="Reason" style="width: 200px;">
        <button class="btn btn-green">Add to Selected</button>
      </div>
    </form>
  </div>
  
  <h2 id="purchases">Recent Purchases</h2>
  <table>
    <tr><th>Time</th><th>Type</th><th>Buyer</th><th>Amount</th><th>Status</th><th>Payment ID</th></tr>
    ${purchases.map(p => `
      <tr>
        <td>${p.timestamp || ''}</td>
        <td>${p.lead_id || ''}</td>
        <td>${p.buyer_email || ''}</td>
        <td>$${p.amount || 0}</td>
        <td>${p.status || ''}</td>
        <td style="font-size: 11px; color: #64748b;">${(p.payment_id || '').slice(0, 20)}...</td>
      </tr>
    `).join('')}
  </table>
  
  <h2>Export</h2>
  <a href="/admin/export/leads?key=${auth}" class="btn">Export Leads CSV</a>
  <a href="/admin/export/providers?key=${auth}" class="btn">Export Providers CSV</a>
  <a href="/admin/export/purchases?key=${auth}" class="btn">Export Purchases CSV</a>
  <a href="/admin/export/credit-history?key=${auth}" class="btn">Export Credit History CSV</a>
</body>
</html>`;
  
  res.send(html);
});

// Edit provider page
app.get('/admin/edit-provider/:id', (req, res) => {
  if (req.query.key !== ADMIN_PASSWORD) return res.status(401).send('Unauthorized');
  
  const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(req.params.id);
  if (!provider) return res.status(404).send('Provider not found');
  
  const recentLeads = db.prepare(`
    SELECT * FROM leads WHERE purchased_by = ? OR assigned_provider = ? ORDER BY id DESC LIMIT 10
  `).all(provider.email, provider.company_name);
  
  // Get credit transaction history
  let creditHistory = [];
  try {
    creditHistory = db.prepare(`
      SELECT * FROM credit_transactions WHERE provider_id = ? ORDER BY id DESC LIMIT 20
    `).all(provider.id);
  } catch (e) { /* table may not exist */ }
  
  const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Edit Provider - ${provider.company_name}</title>
  <style>
    body { font-family: system-ui; padding: 20px; max-width: 800px; margin: 0 auto; background: #f8fafc; }
    .card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 20px; }
    label { display: block; margin-bottom: 5px; font-weight: 500; color: #374151; }
    input, textarea, select { width: 100%; padding: 10px; border: 1px solid #d1d5db; border-radius: 4px; margin-bottom: 15px; box-sizing: border-box; }
    .btn { padding: 10px 20px; background: #2563eb; color: white; border: none; border-radius: 4px; cursor: pointer; }
    .btn:hover { background: #1d4ed8; }
    .btn-red { background: #dc2626; }
    .back { color: #2563eb; text-decoration: none; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 8px; border: 1px solid #e2e8f0; text-align: left; }
    th { background: #f1f5f9; }
  </style>
</head>
<body>
  <a href="/admin?key=${req.query.key}" class="back">← Back to Admin</a>
  <h1>Edit: ${provider.company_name}</h1>
  
  <div class="card">
    <form action="/admin/update-provider/${provider.id}?key=${req.query.key}" method="POST">
      <label>Company Name</label>
      <input name="company_name" value="${provider.company_name || ''}" required>
      
      <label>Email</label>
      <input name="email" type="email" value="${provider.email || ''}" required>
      
      <label>Phone</label>
      <input name="phone" value="${provider.phone || ''}">
      
      <label>Street Address</label>
      <input name="street_address" value="${provider.street_address || ''}" placeholder="123 Main St">
      
      <div style="display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 10px;">
        <div>
          <label>City</label>
          <input name="city" value="${provider.city || ''}" placeholder="Naples">
        </div>
        <div>
          <label>State</label>
          <input name="state" value="${provider.state || ''}" placeholder="FL" maxlength="2" style="text-transform: uppercase;">
        </div>
        <div>
          <label>Business ZIP</label>
          <input name="business_zip" value="${provider.business_zip || ''}" placeholder="34102">
        </div>
      </div>
      
      <label>Website</label>
      <input name="website" value="${provider.website || ''}" placeholder="https://example.com" type="url">
      
      <label>Service Zips (comma-separated)</label>
      <input name="service_zips" value="${provider.service_zips || ''}" placeholder="10001, 10002, 10003">
      
      <label>Credit Balance</label>
      <input name="credit_balance" type="number" value="${provider.credit_balance || 0}">
      
      <label>Status</label>
      <select name="status">
        <option value="Active" ${provider.status === 'Active' ? 'selected' : ''}>Active</option>
        <option value="Inactive" ${provider.status === 'Inactive' ? 'selected' : ''}>Inactive</option>
        <option value="Suspended" ${provider.status === 'Suspended' ? 'selected' : ''}>Suspended</option>
      </select>
      
      <label>Priority (higher = gets leads first)</label>
      <input name="priority" type="number" value="${provider.priority || 0}">
      
      <div style="display: flex; gap: 20px; margin: 15px 0;">
        <label style="display: flex; align-items: center; gap: 8px;">
          <input type="checkbox" name="verified" value="1" ${provider.verified ? 'checked' : ''} style="width: auto;">
          Verified Provider ✓
        </label>
      </div>
      
      <label>Notes</label>
      <textarea name="notes" rows="3">${provider.notes || ''}</textarea>
      
      <button type="submit" class="btn">Save Changes</button>
    </form>
  </div>
  
  <div class="card">
    <h3>Recent Leads (${recentLeads.length})</h3>
    <table>
      <tr><th>ID</th><th>Date</th><th>Zip</th><th>Status</th></tr>
      ${recentLeads.map(l => `<tr><td>${l.lead_id}</td><td>${l.created_at?.split('T')[0]||''}</td><td>${l.zip}</td><td>${l.status}</td></tr>`).join('')}
    </table>
  </div>
  
  <div class="card">
    <h3>💳 Credit History (${creditHistory.length})</h3>
    ${creditHistory.length > 0 ? '<table><tr><th>Date</th><th>Type</th><th>Amount</th><th>Balance</th><th>Reference</th><th>Notes</th></tr>' + creditHistory.map(t => {
        const typeLabels = { 'purchase': '📦 Purchase', 'subscription': '🔄 Subscription', 'lead_sent': '📤 Lead Sent', 'admin_add': '🔧 Admin Add', 'renewal': '🔄 Renewal' };
        const typeLabel = typeLabels[t.type] || t.type;
        const amountStyle = t.amount > 0 ? 'color: #16a34a; font-weight: bold;' : 'color: #dc2626;';
        const amountDisplay = (t.amount > 0 ? '+' : '') + t.amount;
        return '<tr><td>' + (t.timestamp?.split('T')[0] || '') + '</td><td>' + typeLabel + '</td><td style="' + amountStyle + '">' + amountDisplay + '</td><td>' + (t.balance_after || '') + '</td><td style="font-size: 11px;">' + (t.reference || '-') + '</td><td style="font-size: 11px; max-width: 150px; overflow: hidden; text-overflow: ellipsis;">' + (t.notes || '') + '</td></tr>';
      }).join('') + '</table>' : '<p style="color: #94a3b8;">No credit transactions yet</p>'}
  </div>
  
  <div class="card">
    <h3>💰 Add Credits</h3>
    <p style="color: #64748b; font-size: 13px; margin-bottom: 12px;">Add credits with proper audit logging (tracked separately from balance edits above).</p>
    <form action="/admin/add-credits/${provider.id}?key=${req.query.key}" method="POST" style="display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap;">
      <div>
        <label style="font-size: 12px;">Credits to Add</label>
        <input name="credits" type="number" min="1" value="5" style="width: 80px;" required>
      </div>
      <div style="flex: 1; min-width: 200px;">
        <label style="font-size: 12px;">Reason</label>
        <input name="reason" placeholder="e.g., Goodwill credit, refund, promo" style="width: 100%;">
      </div>
      <button type="submit" class="btn" style="background: #16a34a;">+ Add Credits</button>
    </form>
  </div>
  
  <div class="card">
    <h3>📧 Provider Communication</h3>
    <div style="display: flex; gap: 10px; flex-wrap: wrap;">
      <form action="/admin/send-welcome/${provider.id}?key=${req.query.key}" method="POST" style="display: inline;">
        <button type="submit" class="btn btn-green">Send Welcome Email</button>
      </form>
      <form action="/admin/send-low-balance/${provider.id}?key=${req.query.key}" method="POST" style="display: inline;">
        <button type="submit" class="btn" ${provider.credit_balance > 2 ? 'disabled title="Balance not low"' : ''}>Send Low Balance Reminder</button>
      </form>
    </div>
  </div>
  
  <div class="card">
    <h3>🧪 Test Lead Flow</h3>
    <p style="color: #64748b; font-size: 14px; margin-bottom: 10px;">Send a test lead to verify email templates are working.</p>
    <form action="/api/admin/send-test-lead?key=${req.query.key}" method="POST" style="display: flex; gap: 10px; align-items: center;">
      <input type="hidden" name="provider_id" value="${provider.id}">
      <input name="zip" placeholder="Test ZIP (default: 34102)" style="width: 160px;">
      <button type="submit" class="btn" style="background: #9333ea;">Send Test Lead Email</button>
      <span style="font-size: 12px; color: #64748b;">(${provider.credit_balance > 0 ? 'Will send full lead' : 'Will send teaser'})</span>
    </form>
  </div>
  
  <div class="card" style="border: 2px solid #fecaca;">
    <h3 style="color: #dc2626;">Danger Zone</h3>
    <form action="/admin/delete-provider/${provider.id}?key=${req.query.key}" method="POST" onsubmit="return confirm('Delete this provider?')">
      <button type="submit" class="btn btn-red">Delete Provider</button>
    </form>
  </div>
</body>
</html>`;
  res.send(html);
});

// Update provider
app.post('/admin/update-provider/:id', (req, res) => {
  if (req.query.key !== ADMIN_PASSWORD) return res.status(401).send('Unauthorized');
  
  const { company_name, email, phone, street_address, city, state, business_zip, website, service_zips, credit_balance, status, priority, verified, notes } = req.body;
  
  // Get current provider to check for credit changes
  const currentProvider = db.prepare('SELECT credit_balance, email FROM providers WHERE id = ?').get(req.params.id);
  const oldBalance = currentProvider?.credit_balance || 0;
  const newBalance = parseInt(credit_balance) || 0;
  
  // Build composite address for legacy compatibility
  const address = [street_address, city, state, business_zip].filter(Boolean).join(', ');
  
  db.prepare(`
    UPDATE providers SET 
      company_name = ?, email = ?, phone = ?, 
      street_address = ?, city = ?, state = ?, business_zip = ?, website = ?,
      address = ?, service_zips = ?, credit_balance = ?, 
      status = ?, priority = ?, verified = ?, notes = ?
    WHERE id = ?
  `).run(
    company_name, email, phone, 
    street_address || null, city || null, (state || '').toUpperCase() || null, business_zip || null, website || null,
    address || null, service_zips, newBalance, 
    status, parseInt(priority) || 0, verified ? 1 : 0, notes, 
    req.params.id
  );
  
  // Log credit change if balance was manually adjusted
  if (newBalance !== oldBalance) {
    const diff = newBalance - oldBalance;
    logCreditTransaction(
      parseInt(req.params.id), 
      diff > 0 ? 'admin_add' : 'admin_adjust', 
      diff, 
      null, 
      `Manual balance edit: ${oldBalance} → ${newBalance}`
    );
    console.log(`Provider ${req.params.id} credit balance changed: ${oldBalance} → ${newBalance}`);
  }
  
  console.log(`Provider ${req.params.id} updated`);
  res.redirect(`/admin?key=${req.query.key}`);
});

// Add credits to provider (with proper audit logging)
app.post('/admin/add-credits/:id', (req, res) => {
  if (req.query.key !== ADMIN_PASSWORD) return res.status(401).send('Unauthorized');
  
  const providerId = parseInt(req.params.id);
  const credits = parseInt(req.body.credits) || 0;
  const reason = req.body.reason || 'Admin credit add';
  
  if (credits <= 0) {
    return res.redirect(`/admin/edit-provider/${providerId}?key=${req.query.key}&msg=invalid_credits`);
  }
  
  const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(providerId);
  if (!provider) return res.status(404).send('Provider not found');
  
  // Add credits
  db.prepare('UPDATE providers SET credit_balance = credit_balance + ? WHERE id = ?').run(credits, providerId);
  
  // Log transaction
  logCreditTransaction(providerId, 'admin_add', credits, 'admin-' + Date.now(), reason);
  
  // Log to purchase log for visibility
  db.prepare('INSERT INTO purchase_log (lead_id, buyer_email, amount, payment_id, status) VALUES (?, ?, ?, ?, ?)').run(
    'MANUAL', provider.email, 0, 'admin-add-' + Date.now(), `Admin: +${credits} credits. ${reason}`
  );
  
  console.log(`Added ${credits} credits to ${provider.company_name}: ${reason}`);
  res.redirect(`/admin/edit-provider/${providerId}?key=${req.query.key}&msg=credits_added`);
});

// Resend lead to matching providers
app.post('/admin/resend-lead/:leadId', async (req, res) => {
  if (req.query.key !== ADMIN_PASSWORD) return res.status(401).send('Unauthorized');
  
  const lead = db.prepare('SELECT * FROM leads WHERE lead_id = ?').get(req.params.leadId);
  if (!lead) return res.status(404).send('Lead not found');
  
  // Find providers for this ZIP
  const providers = getProvidersByZip(lead.zip);
  let sentCount = 0, teaserCount = 0;
  const notified = [];
  
  for (const provider of providers) {
    const creditCost = 1;
    if (provider.credit_balance >= creditCost) {
      await sendFullLeadToProvider(provider, lead.lead_id, lead, { leadType: 'shared', creditCost });
      db.prepare('UPDATE providers SET credit_balance = credit_balance - ?, total_leads = total_leads + 1 WHERE id = ?')
        .run(creditCost, provider.id);
      notified.push(`${provider.company_name} (full)`);
      sentCount++;
    } else {
      await sendTeaserToProvider(provider, lead.lead_id, lead, { leadType: 'shared', creditCost });
      notified.push(`${provider.company_name} (teaser)`);
      teaserCount++;
    }
  }
  
  // Update tracking
  const existingNotified = lead.providers_notified || '';
  const newNotified = existingNotified ? `${existingNotified}; RESEND: ${notified.join(', ')}` : notified.join(', ');
  db.prepare('UPDATE leads SET providers_notified = ? WHERE lead_id = ?').run(newNotified, lead.lead_id);
  
  console.log(`Resent lead ${lead.lead_id}: ${sentCount} full, ${teaserCount} teasers`);
  await sendAdminNotification(`🔄 Lead resent: ${lead.lead_id}`, 
    `Full: ${sentCount} | Teasers: ${teaserCount}\n${notified.join(', ')}`);
  
  res.redirect(`/admin?key=${req.query.key}`);
});

// Delete provider
app.post('/admin/delete-provider/:id', (req, res) => {
  if (req.query.key !== ADMIN_PASSWORD) return res.status(401).send('Unauthorized');
  db.prepare('DELETE FROM providers WHERE id = ?').run(req.params.id);
  console.log(`Provider ${req.params.id} deleted`);
  res.redirect(`/admin?key=${req.query.key}`);
});

// Send welcome email to provider
app.post('/admin/send-welcome/:id', async (req, res) => {
  if (req.query.key !== ADMIN_PASSWORD) return res.status(401).send('Unauthorized');
  
  const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(req.params.id);
  if (!provider) return res.status(404).send('Provider not found');
  
  const html = `
<div style="font-family: Arial, sans-serif; max-width: 600px;">
  <h2 style="color: #16a34a;">Welcome to DumpsterMap! 🗑️</h2>
  <p>Hi ${provider.company_name},</p>
  <p>Thanks for joining DumpsterMap! We connect you with customers actively looking for dumpster rentals in your area.</p>
  
  <div style="background: #f0fdf4; border: 1px solid #86efac; padding: 20px; border-radius: 8px; margin: 20px 0;">
    <strong>Your Account:</strong><br>
    Credits: ${provider.credit_balance}<br>
    Service Zips: ${provider.service_zips || 'Not set - reply with your zip codes!'}
  </div>
  
  <h3>How It Works</h3>
  <ol style="line-height: 1.8;">
    <li><strong>We send you leads</strong> – Customers searching for dumpster rentals in your area</li>
    <li><strong>You get full contact info</strong> – Name, phone, email, project details</li>
    <li><strong>Close the deal</strong> – Call within 5 minutes for best results</li>
  </ol>
  
  <div style="background: #fef3c7; border: 1px solid #fcd34d; padding: 15px; border-radius: 8px; margin: 20px 0;">
    <strong>⚡ Quick Start:</strong><br>
    Reply to this email with the zip codes you serve, and we'll set up your account to receive leads automatically.
  </div>
  
  <p>
    <a href="https://dumpstermap.io/for-providers" style="display: inline-block; background: #16a34a; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Buy Credits</a>
    <a href="https://dumpstermap.io/balance" style="display: inline-block; background: #f1f5f9; color: #1e293b; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin-left: 10px;">Check Balance</a>
  </p>
  
  <p style="color: #64748b; font-size: 14px; margin-top: 30px;">
    Questions? Just reply to this email.<br>
    — The DumpsterMap Team
  </p>
</div>`;

  const sent = await sendEmail(provider.email, 'Welcome to DumpsterMap! 🗑️', html);
  console.log(`Welcome email ${sent ? 'sent' : 'FAILED'} to ${provider.email}`);
  
  res.redirect(`/admin/edit-provider/${req.params.id}?key=${req.query.key}&msg=welcome_${sent ? 'sent' : 'failed'}`);
});

// Send low balance reminder to provider
app.post('/admin/send-low-balance/:id', async (req, res) => {
  if (req.query.key !== ADMIN_PASSWORD) return res.status(401).send('Unauthorized');
  
  const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(req.params.id);
  if (!provider) return res.status(404).send('Provider not found');
  
  const html = `
<div style="font-family: Arial, sans-serif; max-width: 600px;">
  <p>Hi ${provider.company_name},</p>
  
  <div style="background: #fef3c7; border: 1px solid #fcd34d; padding: 20px; border-radius: 8px; margin: 20px 0;">
    <strong>⚠️ Low Credit Balance</strong><br>
    You have <strong>${provider.credit_balance} credit${provider.credit_balance === 1 ? '' : 's'}</strong> remaining.
  </div>
  
  <p>Don't miss out on leads! When your balance hits zero, you'll only receive teaser notifications instead of full contact details.</p>
  
  <h3>Credit Packs</h3>
  <table style="width: 100%; border-collapse: collapse; margin: 15px 0;">
    <tr style="background: #f1f5f9;">
      <th style="padding: 10px; text-align: left; border: 1px solid #e2e8f0;">Pack</th>
      <th style="padding: 10px; text-align: left; border: 1px solid #e2e8f0;">Credits</th>
      <th style="padding: 10px; text-align: left; border: 1px solid #e2e8f0;">Price</th>
      <th style="padding: 10px; text-align: left; border: 1px solid #e2e8f0;">Per Lead</th>
    </tr>
    <tr>
      <td style="padding: 10px; border: 1px solid #e2e8f0;">Starter</td>
      <td style="padding: 10px; border: 1px solid #e2e8f0;">5</td>
      <td style="padding: 10px; border: 1px solid #e2e8f0;">$200</td>
      <td style="padding: 10px; border: 1px solid #e2e8f0;">$40</td>
    </tr>
    <tr>
      <td style="padding: 10px; border: 1px solid #e2e8f0;">Pro</td>
      <td style="padding: 10px; border: 1px solid #e2e8f0;">20</td>
      <td style="padding: 10px; border: 1px solid #e2e8f0;">$700</td>
      <td style="padding: 10px; border: 1px solid #e2e8f0;"><strong>$35</strong></td>
    </tr>
    <tr style="background: #f0fdf4;">
      <td style="padding: 10px; border: 1px solid #e2e8f0;">Premium</td>
      <td style="padding: 10px; border: 1px solid #e2e8f0;">60</td>
      <td style="padding: 10px; border: 1px solid #e2e8f0;">$1,500</td>
      <td style="padding: 10px; border: 1px solid #e2e8f0;"><strong>$25</strong> 🔥</td>
    </tr>
  </table>
  
  <p>
    <a href="https://dumpstermap.io/for-providers" style="display: inline-block; background: #16a34a; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Buy Credits Now</a>
  </p>
  
  <p style="color: #64748b; font-size: 14px; margin-top: 30px;">
    — DumpsterMap
  </p>
</div>`;

  const sent = await sendEmail(provider.email, `Low Balance Alert: ${provider.credit_balance} credits remaining`, html);
  console.log(`Low balance email ${sent ? 'sent' : 'FAILED'} to ${provider.email}`);
  
  res.redirect(`/admin/edit-provider/${req.params.id}?key=${req.query.key}&msg=lowbalance_${sent ? 'sent' : 'failed'}`);
});

// Quick add credits
app.post('/admin/add-credits', (req, res) => {
  if (req.query.key !== ADMIN_PASSWORD) return res.status(401).send('Unauthorized');
  
  const { provider_id, credits, reason } = req.body;
  const creditAmount = parseInt(credits) || 0;
  
  db.prepare('UPDATE providers SET credit_balance = credit_balance + ? WHERE id = ?').run(creditAmount, provider_id);
  
  // Log the manual credit addition
  const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(provider_id);
  db.prepare('INSERT INTO purchase_log (lead_id, buyer_email, amount, payment_id, status) VALUES (?, ?, ?, ?, ?)').run(
    'MANUAL', provider?.email || '', 0, 'admin-' + Date.now(), `Manual: +${creditAmount} credits. ${reason || ''}`
  );
  logCreditTransaction(parseInt(provider_id), 'admin_add', creditAmount, 'admin', reason || 'Manual addition');
  
  console.log(`Added ${creditAmount} credits to provider ${provider_id}: ${reason || 'no reason'}`);
  res.redirect(`/admin?key=${req.query.key}`);
});

// Bulk add credits (form version)
app.post('/admin/bulk-add-credits', (req, res) => {
  if (req.query.key !== ADMIN_PASSWORD) return res.status(401).send('Unauthorized');
  
  let { provider_ids, credits, reason } = req.body;
  
  // Handle both array (multiple select) and single value
  if (!Array.isArray(provider_ids)) {
    provider_ids = provider_ids ? [provider_ids] : [];
  }
  
  const creditAmount = parseInt(credits) || 0;
  if (creditAmount <= 0 || provider_ids.length === 0) {
    return res.redirect(`/admin?key=${req.query.key}`);
  }
  
  let updated = 0;
  for (const id of provider_ids) {
    try {
      db.prepare('UPDATE providers SET credit_balance = credit_balance + ? WHERE id = ?').run(creditAmount, id);
      const provider = db.prepare('SELECT email FROM providers WHERE id = ?').get(id);
      db.prepare('INSERT INTO purchase_log (lead_id, buyer_email, amount, payment_id, status) VALUES (?, ?, ?, ?, ?)').run(
        'BULK_ADD', provider?.email || '', 0, 'admin-bulk-' + Date.now(), `Bulk: +${creditAmount} credits. ${reason || ''}`
      );
      logCreditTransaction(parseInt(id), 'admin_add', creditAmount, 'bulk', reason || 'Bulk addition');
      updated++;
    } catch (e) {
      console.log(`Failed to add credits to provider ${id}:`, e.message);
    }
  }
  
  console.log(`Bulk added ${creditAmount} credits to ${updated} providers: ${reason || 'no reason'}`);
  res.redirect(`/admin?key=${req.query.key}`);
});

// Provider outreach management
app.get('/admin/outreach', (req, res) => {
  if (req.query.key !== ADMIN_PASSWORD) return res.status(401).send('Unauthorized');
  
  const outreach = db.prepare('SELECT * FROM outreach ORDER BY id DESC LIMIT 200').all();
  const campaigns = db.prepare('SELECT DISTINCT campaign FROM outreach WHERE campaign IS NOT NULL').all();
  
  // Stats
  const totalOutreach = db.prepare('SELECT COUNT(*) as cnt FROM outreach').get().cnt;
  const sentCount = db.prepare("SELECT COUNT(*) as cnt FROM outreach WHERE email_status = 'Sent'").get().cnt;
  const failedCount = db.prepare("SELECT COUNT(*) as cnt FROM outreach WHERE email_status = 'Failed'").get().cnt;
  const pendingCount = db.prepare("SELECT COUNT(*) as cnt FROM outreach WHERE email_status = 'Pending'").get().cnt;
  const repliedCount = db.prepare("SELECT COUNT(*) as cnt FROM outreach WHERE replied_at IS NOT NULL").get().cnt;
  const convertedCount = db.prepare('SELECT COUNT(*) as cnt FROM outreach WHERE converted = 1').get().cnt;
  
  const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Provider Outreach - DumpsterMap Admin</title>
  <style>
    body { font-family: system-ui; padding: 20px; max-width: 1600px; margin: 0 auto; background: #f8fafc; }
    .stats { display: flex; gap: 20px; margin-bottom: 30px; }
    .stat { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); flex: 1; }
    .stat-value { font-size: 32px; font-weight: bold; color: #1e40af; }
    .stat-label { color: #64748b; font-size: 14px; }
    table { border-collapse: collapse; width: 100%; font-size: 12px; background: white; margin-top: 20px; }
    th, td { border: 1px solid #e2e8f0; padding: 8px; text-align: left; }
    th { background: #f1f5f9; position: sticky; top: 0; }
    .back { color: #2563eb; text-decoration: none; margin-bottom: 20px; display: inline-block; }
    .btn { padding: 8px 16px; background: #2563eb; color: white; border: none; border-radius: 4px; cursor: pointer; margin: 2px; text-decoration: none; display: inline-block; font-size: 13px; }
    .btn:hover { background: #1d4ed8; }
    .btn-green { background: #16a34a; }
    .btn-sm { padding: 4px 8px; font-size: 11px; }
    .card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 20px; }
    input, select, textarea { padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 4px; }
    .status-pending { color: #f59e0b; }
    .status-sent { color: #2563eb; }
    .status-converted { color: #16a34a; font-weight: bold; }
    .status-replied { color: #9333ea; }
  </style>
</head>
<body>
  <a href="/admin?key=${req.query.key}" class="back">← Back to Admin</a>
  <h1>📧 Provider Outreach</h1>
  
  <div class="stats">
    <div class="stat"><div class="stat-value">${totalOutreach}</div><div class="stat-label">Total Contacts</div></div>
    <div class="stat"><div class="stat-value">${pendingCount}</div><div class="stat-label">Pending</div></div>
    <div class="stat"><div class="stat-value">${sentCount}</div><div class="stat-label">Emails Sent</div></div>
    <div class="stat"><div class="stat-value" style="color: #dc2626;">${failedCount}</div><div class="stat-label">Failed/Bounced</div></div>
    <div class="stat"><div class="stat-value" style="color: #9333ea;">${repliedCount}</div><div class="stat-label">Replied</div></div>
    <div class="stat"><div class="stat-value" style="color: #16a34a;">${convertedCount}</div><div class="stat-label">Converted</div></div>
  </div>
  
  <div class="card">
    <h3>Add Outreach Contact</h3>
    <form action="/admin/outreach/add?key=${req.query.key}" method="POST" style="display: flex; gap: 10px; flex-wrap: wrap; align-items: center;">
      <input name="company_name" placeholder="Company Name" required>
      <input name="provider_email" placeholder="Email" required type="email">
      <input name="phone" placeholder="Phone">
      <input name="zip" placeholder="Zip">
      <input name="source" placeholder="Source (e.g., Google Maps)">
      <input name="campaign" placeholder="Campaign" list="campaigns">
      <datalist id="campaigns">
        ${campaigns.map(c => `<option value="${c.campaign}">`).join('')}
      </datalist>
      <button class="btn btn-green">Add Contact</button>
    </form>
  </div>
  
  <div class="card">
    <h3>Bulk Import (CSV)</h3>
    <form action="/admin/outreach/import?key=${req.query.key}" method="POST" style="display: flex; gap: 10px; align-items: flex-start;">
      <textarea name="csv_data" placeholder="company_name,email,phone,zip,source&#10;ABC Dumpsters,abc@example.com,555-1234,10001,Google Maps" rows="4" style="width: 500px;"></textarea>
      <input name="campaign" placeholder="Campaign name">
      <button class="btn">Import CSV</button>
    </form>
  </div>
  
  <h2>Outreach List (${outreach.length})</h2>
  <table>
    <tr>
      <th>ID</th>
      <th>Date</th>
      <th>Company</th>
      <th>Email</th>
      <th>Phone</th>
      <th>Zip</th>
      <th>Campaign</th>
      <th>Status</th>
      <th>Converted</th>
      <th>Actions</th>
    </tr>
    ${outreach.map(o => {
      const statusClass = o.converted ? 'status-converted' : o.replied_at ? 'status-replied' : o.email_status === 'Sent' ? 'status-sent' : 'status-pending';
      return `
        <tr>
          <td>${o.id}</td>
          <td>${o.created_at?.split('T')[0] || ''}</td>
          <td>${o.company_name || ''}</td>
          <td>${o.provider_email}</td>
          <td>${o.phone || ''}</td>
          <td>${o.zip || ''}</td>
          <td>${o.campaign || ''}</td>
          <td class="${statusClass}">${o.email_status}${o.replied_at ? ' (replied)' : ''}</td>
          <td>${o.converted ? '✅' : ''}</td>
          <td>
            <form action="/admin/outreach/update/${o.id}?key=${req.query.key}" method="POST" style="display: inline;">
              <select name="action" onchange="this.form.submit()" style="padding: 4px; font-size: 11px;">
                <option value="">Actions...</option>
                <option value="sent">Mark Sent</option>
                <option value="replied">Mark Replied</option>
                <option value="converted">Mark Converted</option>
                <option value="delete">Delete</option>
              </select>
            </form>
          </td>
        </tr>
      `;
    }).join('')}
  </table>
  
  <div class="card">
    <h3>📧 Bulk Send Outreach Emails</h3>
    <p style="color: #64748b; font-size: 14px; margin-bottom: 10px;">Send outreach emails to all contacts with "Pending" status.</p>
    <form action="/admin/outreach/bulk-send?key=${req.query.key}" method="POST" style="display: flex; gap: 10px; align-items: center;" onsubmit="return confirm('Send outreach emails to all Pending contacts?')">
      <select name="campaign" style="min-width: 150px;">
        <option value="">All campaigns</option>
        ${campaigns.map(c => `<option value="${c.campaign}">${c.campaign}</option>`).join('')}
      </select>
      <input name="limit" type="number" placeholder="Limit (default: 10)" value="10" style="width: 120px;">
      <button class="btn btn-green">Send Outreach Emails</button>
    </form>
  </div>
  
  <h2>Export</h2>
  <a href="/admin/export/outreach?key=${req.query.key}" class="btn">Export Outreach CSV</a>
</body>
</html>`;
  res.send(html);
});

// Bulk send outreach emails
app.post('/admin/outreach/bulk-send', async (req, res) => {
  if (req.query.key !== ADMIN_PASSWORD) return res.status(401).send('Unauthorized');
  
  const campaign = req.body.campaign || null;
  const limit = Math.min(parseInt(req.body.limit) || 10, 50);
  
  // Get pending outreach contacts
  let query = "SELECT * FROM outreach WHERE email_status = 'Pending'";
  const params = [];
  if (campaign) {
    query += " AND campaign = ?";
    params.push(campaign);
  }
  query += " ORDER BY id ASC LIMIT ?";
  params.push(limit);
  
  const contacts = db.prepare(query).all(...params);
  let sent = 0, failed = 0;
  
  for (const contact of contacts) {
    const html = generateOutreachEmail(contact);
    // Use Gmail directly for outreach (no rate limits)
    const success = await sendEmailViaGmail(
      contact.provider_email,
      `Partner with DumpsterMap - Get Quality Dumpster Leads in ${contact.zip || 'Your Area'}`,
      html,
      null,
      'DumpsterMap Partners <admin@dumpstermap.io>'
    );
    
    if (success) {
      db.prepare("UPDATE outreach SET email_status = 'Sent', email_sent_at = datetime('now') WHERE id = ?").run(contact.id);
      sent++;
    } else {
      db.prepare("UPDATE outreach SET email_status = 'Failed' WHERE id = ?").run(contact.id);
      failed++;
    }
    
    // Small delay between emails
    await new Promise(r => setTimeout(r, 300));
  }
  
  console.log(`Bulk outreach (Gmail): ${sent} sent, ${failed} failed`);
  res.redirect(`/admin/outreach?key=${req.query.key}&sent=${sent}&failed=${failed}`);
});

// API endpoint for cron job to send outreach emails
app.post('/api/outreach/send-batch', async (req, res) => {
  const auth = req.query.key || req.headers['x-admin-key'];
  if (auth !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const limit = Math.min(parseInt(req.body.limit) || 10, 20); // Max 20 per batch
  
  // Get pending outreach contacts
  const contacts = db.prepare(`
    SELECT * FROM outreach 
    WHERE email_status = 'Pending' 
    ORDER BY id ASC 
    LIMIT ?
  `).all(limit);
  
  if (contacts.length === 0) {
    return res.json({ status: 'ok', message: 'No pending contacts', sent: 0, failed: 0 });
  }
  
  let sent = 0, failed = 0;
  const results = [];
  
  for (const contact of contacts) {
    const html = generateOutreachEmail(contact);
    // Use Gmail directly for outreach (no Resend rate limits)
    const success = await sendEmailViaGmail(
      contact.provider_email,
      `Partner with DumpsterMap - Get Quality Dumpster Leads in ${contact.zip || 'Your Area'}`,
      html,
      null,
      'DumpsterMap Partners <admin@dumpstermap.io>'
    );
    
    if (success) {
      db.prepare("UPDATE outreach SET email_status = 'Sent', email_sent_at = datetime('now') WHERE id = ?").run(contact.id);
      sent++;
      results.push({ id: contact.id, email: contact.provider_email, status: 'sent' });
    } else {
      db.prepare("UPDATE outreach SET email_status = 'Failed' WHERE id = ?").run(contact.id);
      failed++;
      results.push({ id: contact.id, email: contact.provider_email, status: 'failed' });
    }
    
    // Small delay between emails
    await new Promise(r => setTimeout(r, 300));
  }
  
  console.log(`Outreach batch (Gmail): ${sent} sent, ${failed} failed`);
  res.json({ status: 'ok', sent, failed, results });
});

// Import providers from static JSON into outreach table
app.post('/api/outreach/import-from-json', async (req, res) => {
  const auth = req.query.key || req.headers['x-admin-key'];
  if (auth !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const limit = parseInt(req.body.limit) || 100;
  const stateFilter = (req.body.state || '').toLowerCase();
  const campaign = req.body.campaign || 'json-import';
  
  try {
    const fs = require('fs');
    const jsonPath = path.join(__dirname, 'data', 'providers.json');
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    let providers = data.providers || [];
    
    // Filter by state if specified (matches full name or abbreviation)
    if (stateFilter) {
      providers = providers.filter(p => {
        const pState = (p.state || '').toLowerCase();
        return pState === stateFilter || pState.startsWith(stateFilter);
      });
    }
    
    // Only get providers with phone (we can look up email or skip)
    providers = providers.filter(p => p.phone);
    
    // Limit and randomize to avoid always getting same ones
    providers = providers.sort(() => Math.random() - 0.5).slice(0, limit);
    
    let imported = 0, skipped = 0;
    
    for (const p of providers) {
      // Skip if already in outreach table
      const existing = db.prepare('SELECT id FROM outreach WHERE provider_email = ? OR (company_name = ? AND zip = ?)').get(
        p.email || `${p.phone}@unknown.com`,
        p.name,
        p.zip
      );
      
      if (existing) {
        skipped++;
        continue;
      }
      
      // Use email if available, or try to generate from website
      let email = p.email || null;
      if (!email && p.website) {
        try {
          const url = new URL(p.website);
          const domain = url.hostname.replace('www.', '');
          // Generate common business email pattern
          email = `info@${domain}`;
        } catch (e) {
          // Invalid URL, skip
        }
      }
      
      if (!email) {
        skipped++;
        continue; // Skip providers without email or website
      }
      
      db.prepare(`
        INSERT INTO outreach (company_name, provider_email, phone, zip, source, campaign, email_status)
        VALUES (?, ?, ?, ?, 'Google Maps Import', ?, 'Pending')
      `).run(p.name, email, p.phone, p.zip, campaign);
      
      imported++;
    }
    
    console.log(`Outreach import: ${imported} imported, ${skipped} skipped`);
    res.json({ status: 'ok', imported, skipped, total: providers.length });
  } catch (error) {
    console.error('Import error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Generate outreach email template
function generateOutreachEmail(contact) {
  const companyName = contact.company_name || 'there';
  const zip = contact.zip || 'your area';
  
  return `
<div style="font-family: Arial, sans-serif; max-width: 600px; line-height: 1.6; color: #333;">
  <p>Hi ${companyName},</p>
  
  <p>I'm reaching out because we're connecting dumpster rental customers in <strong>${zip}</strong> with local providers like you.</p>
  
  <p><strong>DumpsterMap.io</strong> is a lead generation platform where homeowners and contractors search for dumpster rentals. When they submit a quote request, we send you their full contact info so you can reach out directly.</p>
  
  <div style="background: #f8f9fa; padding: 16px; border-radius: 6px; margin: 20px 0;">
    <strong>How it works:</strong>
    <ul style="margin: 10px 0 0 0; padding-left: 20px;">
      <li>Customer fills out a quote request on DumpsterMap</li>
      <li>We send you their name, phone, and email immediately</li>
      <li>You call them and close the deal</li>
      <li>Only pay for leads you receive ($40/lead or volume discounts)</li>
    </ul>
  </div>
  
  <p><strong>Why providers choose us:</strong></p>
  <ul style="margin: 10px 0; padding-left: 20px;">
    <li>✓ Real-time leads (customers actively searching)</li>
    <li>✓ No contracts or monthly fees</li>
    <li>✓ Full contact info (name, phone, email, project details)</li>
    <li>✓ Only pay for leads in your service area</li>
  </ul>
  
  <p style="margin: 24px 0;">
    <a href="https://dumpstermap.io/for-providers" style="background: #16a34a; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Learn More & Get Started →</a>
  </p>
  
  <p>Have questions? Just reply to this email.</p>
  
  <p>Best,<br>
  The DumpsterMap Team</p>
  
  <p style="font-size: 12px; color: #888; margin-top: 30px; border-top: 1px solid #eee; padding-top: 16px;">
    DumpsterMap.io | <a href="https://dumpstermap.io" style="color: #888;">dumpstermap.io</a><br>
    Reply STOP to unsubscribe.
  </p>
</div>`;
}

// Add outreach contact
app.post('/admin/outreach/add', (req, res) => {
  if (req.query.key !== ADMIN_PASSWORD) return res.status(401).send('Unauthorized');
  
  const { company_name, provider_email, phone, zip, source, campaign } = req.body;
  db.prepare(`
    INSERT INTO outreach (company_name, provider_email, phone, zip, source, campaign)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(company_name, provider_email, phone, zip, source, campaign);
  
  res.redirect(`/admin/outreach?key=${req.query.key}`);
});

// Bulk import outreach
app.post('/admin/outreach/import', (req, res) => {
  if (req.query.key !== ADMIN_PASSWORD) return res.status(401).send('Unauthorized');
  
  const { csv_data, campaign } = req.body;
  if (!csv_data) return res.redirect(`/admin/outreach?key=${req.query.key}`);
  
  const lines = csv_data.trim().split('\n');
  let imported = 0;
  
  for (const line of lines) {
    if (!line.trim() || line.toLowerCase().startsWith('company')) continue; // Skip headers
    const parts = line.split(',').map(p => p.trim());
    const [company_name, email, phone, zip, source] = parts;
    
    if (email && email.includes('@')) {
      try {
        db.prepare(`
          INSERT INTO outreach (company_name, provider_email, phone, zip, source, campaign)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(company_name || '', email, phone || '', zip || '', source || '', campaign || '');
        imported++;
      } catch (e) {
        console.log('Import skip (duplicate?):', email);
      }
    }
  }
  
  console.log(`Imported ${imported} outreach contacts`);
  res.redirect(`/admin/outreach?key=${req.query.key}`);
});

// Update outreach status
app.post('/admin/outreach/update/:id', (req, res) => {
  if (req.query.key !== ADMIN_PASSWORD) return res.status(401).send('Unauthorized');
  
  const action = req.body.action;
  const id = req.params.id;
  
  if (action === 'sent') {
    db.prepare("UPDATE outreach SET email_status = 'Sent', email_sent_at = datetime('now') WHERE id = ?").run(id);
  } else if (action === 'replied') {
    db.prepare("UPDATE outreach SET replied_at = datetime('now') WHERE id = ?").run(id);
  } else if (action === 'converted') {
    db.prepare("UPDATE outreach SET converted = 1 WHERE id = ?").run(id);
    // Also create provider record if doesn't exist
    const outreach = db.prepare('SELECT * FROM outreach WHERE id = ?').get(id);
    if (outreach) {
      const existingProvider = getProviderByEmail(outreach.provider_email);
      if (!existingProvider) {
        db.prepare(`
          INSERT INTO providers (company_name, email, phone, service_zips, notes)
          VALUES (?, ?, ?, ?, 'Converted from outreach')
        `).run(outreach.company_name, outreach.provider_email, outreach.phone, outreach.zip);
        console.log(`Created provider from outreach: ${outreach.provider_email}`);
      }
    }
  } else if (action === 'delete') {
    db.prepare('DELETE FROM outreach WHERE id = ?').run(id);
  }
  
  res.redirect(`/admin/outreach?key=${req.query.key}`);
});

// Registration funnel page
app.get('/admin/funnel', async (req, res) => {
  if (req.query.key !== ADMIN_PASSWORD) return res.status(401).send('Unauthorized');
  
  // Fetch funnel data
  let funnelData = { registrations: 0, purchases: 0, conversionRate: '0%', byPack: {}, dailyBreakdown: [] };
  let webhookEvents = [];
  
  try {
    const registrations = db.prepare(`
      SELECT COUNT(*) as count FROM registration_events 
      WHERE event_type = 'registration' AND timestamp > datetime('now', '-30 days')
    `).get().count;
    
    const purchases = db.prepare(`
      SELECT COUNT(*) as count FROM registration_events 
      WHERE event_type = 'purchase' AND timestamp > datetime('now', '-30 days')
    `).get().count;
    
    const byPack = db.prepare(`
      SELECT selected_pack, COUNT(*) as count FROM registration_events 
      WHERE event_type = 'registration' AND timestamp > datetime('now', '-30 days')
      GROUP BY selected_pack
    `).all();
    
    const dailyBreakdown = db.prepare(`
      SELECT date(timestamp) as date, event_type, COUNT(*) as count 
      FROM registration_events 
      WHERE timestamp > datetime('now', '-14 days')
      GROUP BY date(timestamp), event_type
      ORDER BY date DESC
    `).all();
    
    funnelData = {
      registrations,
      purchases,
      conversionRate: registrations > 0 ? ((purchases / registrations) * 100).toFixed(1) + '%' : '0%',
      byPack: Object.fromEntries(byPack.map(p => [p.selected_pack || 'unknown', p.count])),
      dailyBreakdown
    };
  } catch (e) {
    console.log('Funnel data unavailable:', e.message);
  }
  
  try {
    webhookEvents = db.prepare(`SELECT * FROM webhook_log ORDER BY id DESC LIMIT 20`).all();
  } catch (e) {
    console.log('Webhook log unavailable:', e.message);
  }
  
  const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Registration Funnel - DumpsterMap Admin</title>
  <style>
    body { font-family: system-ui; padding: 20px; max-width: 1400px; margin: 0 auto; background: #f8fafc; }
    .stats { display: flex; gap: 20px; margin-bottom: 30px; }
    .stat { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); flex: 1; text-align: center; }
    .stat-value { font-size: 32px; font-weight: bold; color: #1e40af; }
    .stat-label { color: #64748b; font-size: 14px; }
    table { border-collapse: collapse; width: 100%; font-size: 12px; background: white; margin-top: 20px; }
    th, td { border: 1px solid #e2e8f0; padding: 8px; text-align: left; }
    th { background: #f1f5f9; position: sticky; top: 0; }
    .back { color: #2563eb; text-decoration: none; margin-bottom: 20px; display: inline-block; }
    .card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 20px; }
    h2 { margin-top: 30px; color: #1e293b; }
    .funnel-bar { background: #e0e7ff; height: 30px; border-radius: 4px; position: relative; margin: 10px 0; }
    .funnel-fill { background: #4f46e5; height: 100%; border-radius: 4px; }
    .funnel-label { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: white; font-weight: bold; font-size: 13px; }
  </style>
</head>
<body>
  <a href="/admin?key=${req.query.key}" class="back">← Back to Admin</a>
  <h1>📊 Registration Funnel (Last 30 Days)</h1>
  
  <div class="stats">
    <div class="stat">
      <div class="stat-value">${funnelData.registrations}</div>
      <div class="stat-label">Registrations</div>
    </div>
    <div class="stat">
      <div class="stat-value">${funnelData.purchases}</div>
      <div class="stat-label">Purchases</div>
    </div>
    <div class="stat">
      <div class="stat-value" style="color: ${parseFloat(funnelData.conversionRate) > 20 ? '#16a34a' : '#f59e0b'}">${funnelData.conversionRate}</div>
      <div class="stat-label">Conversion Rate</div>
    </div>
  </div>
  
  <div class="card">
    <h3>Visual Funnel</h3>
    <div class="funnel-bar" style="width: 100%">
      <div class="funnel-fill" style="width: 100%"></div>
      <span class="funnel-label">Registrations: ${funnelData.registrations}</span>
    </div>
    <div class="funnel-bar" style="width: ${Math.max(20, (funnelData.purchases / Math.max(1, funnelData.registrations)) * 100)}%">
      <div class="funnel-fill" style="width: 100%; background: #16a34a;"></div>
      <span class="funnel-label">Purchases: ${funnelData.purchases}</span>
    </div>
  </div>
  
  <div class="card">
    <h3>Registrations by Pack Selected</h3>
    <table>
      <tr><th>Pack</th><th>Count</th><th>%</th></tr>
      ${Object.entries(funnelData.byPack).map(([pack, count]) => `
        <tr>
          <td>${pack}</td>
          <td>${count}</td>
          <td>${funnelData.registrations > 0 ? ((count / funnelData.registrations) * 100).toFixed(1) : 0}%</td>
        </tr>
      `).join('') || '<tr><td colspan="3" style="color: #94a3b8;">No data yet</td></tr>'}
    </table>
  </div>
  
  <h2>🔌 Recent Webhook Events</h2>
  <table>
    <tr><th>Time</th><th>Event Type</th><th>Data</th><th>Result</th></tr>
    ${webhookEvents.map(e => `
      <tr>
        <td>${e.processed_at || ''}</td>
        <td>${e.event_type || ''}</td>
        <td style="max-width: 300px; overflow: hidden; text-overflow: ellipsis; font-size: 11px;">${e.event_data || ''}</td>
        <td style="max-width: 200px; overflow: hidden; font-size: 11px;">${e.result || ''}</td>
      </tr>
    `).join('') || '<tr><td colspan="4" style="color: #94a3b8;">No webhook events logged yet</td></tr>'}
  </table>
</body>
</html>`;
  
  res.send(html);
});

// System logs page
app.get('/admin/logs', (req, res) => {
  if (req.query.key !== ADMIN_PASSWORD) return res.status(401).send('Unauthorized');
  
  const purchases = db.prepare('SELECT * FROM purchase_log ORDER BY id DESC LIMIT 200').all();
  const errors = db.prepare('SELECT * FROM error_log ORDER BY id DESC LIMIT 100').all();
  
  // Get webhook events (may not exist yet)
  let webhookEvents = [];
  try {
    webhookEvents = db.prepare('SELECT * FROM webhook_log ORDER BY id DESC LIMIT 50').all();
  } catch (e) { /* table may not exist */ }
  
  // Calculate revenue breakdown
  const singleLeadRev = db.prepare("SELECT SUM(amount) as total FROM purchase_log WHERE lead_id LIKE 'LEAD-%' AND (status LIKE '%Success%' OR status = 'Credits Added')").get().total || 0;
  const starterRev = db.prepare("SELECT SUM(amount) as total FROM purchase_log WHERE lead_id = 'PACK_5' AND status = 'Credits Added'").get().total || 0;
  const proRev = db.prepare("SELECT SUM(amount) as total FROM purchase_log WHERE lead_id = 'PACK_20' AND status = 'Credits Added'").get().total || 0;
  const premiumRev = db.prepare("SELECT SUM(amount) as total FROM purchase_log WHERE lead_id = 'PACK_60' AND status = 'Credits Added'").get().total || 0;
  const subscriptionRev = db.prepare("SELECT SUM(amount) as total FROM purchase_log WHERE lead_id LIKE 'SUB_%' AND status = 'Credits Added'").get().total || 0;
  const totalRev = singleLeadRev + starterRev + proRev + premiumRev + subscriptionRev;
  
  const html = `
<!DOCTYPE html>
<html>
<head>
  <title>System Logs - DumpsterMap</title>
  <style>
    body { font-family: system-ui; padding: 20px; max-width: 1400px; margin: 0 auto; background: #f8fafc; }
    table { border-collapse: collapse; width: 100%; font-size: 12px; background: white; margin-bottom: 30px; }
    th, td { border: 1px solid #e2e8f0; padding: 8px; text-align: left; }
    th { background: #f1f5f9; position: sticky; top: 0; }
    .back { color: #2563eb; text-decoration: none; margin-bottom: 20px; display: inline-block; }
    .success { color: #16a34a; }
    .error { color: #dc2626; }
    .credit { color: #9333ea; }
    h2 { margin-top: 40px; }
  </style>
</head>
<body>
  <a href="/admin?key=${req.query.key}" class="back">← Back to Admin</a>
  <h1>📋 System Logs</h1>
  
  <div style="display: grid; grid-template-columns: repeat(6, 1fr); gap: 15px; margin-bottom: 30px;">
    <div style="background: white; padding: 15px; border-radius: 8px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
      <div style="font-size: 24px; font-weight: bold; color: #1e40af;">$${totalRev.toFixed(0)}</div>
      <div style="font-size: 12px; color: #64748b;">Total Revenue</div>
    </div>
    <div style="background: white; padding: 15px; border-radius: 8px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
      <div style="font-size: 24px; font-weight: bold; color: #64748b;">$${singleLeadRev.toFixed(0)}</div>
      <div style="font-size: 12px; color: #64748b;">Single Leads</div>
    </div>
    <div style="background: white; padding: 15px; border-radius: 8px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
      <div style="font-size: 24px; font-weight: bold; color: #16a34a;">$${starterRev.toFixed(0)}</div>
      <div style="font-size: 12px; color: #64748b;">Starter Packs</div>
    </div>
    <div style="background: white; padding: 15px; border-radius: 8px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
      <div style="font-size: 24px; font-weight: bold; color: #2563eb;">$${proRev.toFixed(0)}</div>
      <div style="font-size: 12px; color: #64748b;">Pro Packs</div>
    </div>
    <div style="background: white; padding: 15px; border-radius: 8px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
      <div style="font-size: 24px; font-weight: bold; color: #9333ea;">$${premiumRev.toFixed(0)}</div>
      <div style="font-size: 12px; color: #64748b;">Premium Packs</div>
    </div>
    <div style="background: white; padding: 15px; border-radius: 8px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
      <div style="font-size: 24px; font-weight: bold; color: #f59e0b;">$${subscriptionRev.toFixed(0)}</div>
      <div style="font-size: 12px; color: #64748b;">Subscriptions</div>
    </div>
  </div>
  
  <h2>Purchase Log</h2>
  <table>
    <tr><th>Timestamp</th><th>Type</th><th>Email</th><th>Amount</th><th>Payment ID</th><th>Status</th></tr>
    ${purchases.map(p => {
      const statusClass = p.status?.includes('Success') ? 'success' : p.status?.includes('credit') ? 'credit' : p.status?.includes('Failed') ? 'error' : '';
      // Format type for better readability
      let typeDisplay = p.lead_id || '';
      if (typeDisplay === 'PACK_5') typeDisplay = '📦 Starter (5 cr)';
      else if (typeDisplay === 'PACK_20') typeDisplay = '📦 Pro (20 cr)';
      else if (typeDisplay === 'PACK_60') typeDisplay = '📦 Premium (60 cr)';
      else if (typeDisplay === 'SUB_3') typeDisplay = '🔄 Featured ($99/mo)';
      else if (typeDisplay === 'MANUAL') typeDisplay = '🔧 Manual';
      else if (typeDisplay === 'CREDIT_PACK') typeDisplay = '📦 Credit Pack';
      return `
        <tr>
          <td>${p.timestamp || ''}</td>
          <td>${typeDisplay}</td>
          <td>${p.buyer_email || ''}</td>
          <td>$${p.amount || 0}</td>
          <td style="font-size: 10px; max-width: 200px; overflow: hidden; text-overflow: ellipsis;">${p.payment_id || ''}</td>
          <td class="${statusClass}">${p.status || ''}</td>
        </tr>
      `;
    }).join('')}
  </table>
  
  ${errors.length > 0 ? `
  <h2 style="color: #dc2626;">⚠️ Error Log (${errors.length})</h2>
  <table>
    <tr><th>Timestamp</th><th>Type</th><th>Message</th><th>Context</th></tr>
    ${errors.map(e => `
      <tr>
        <td>${e.timestamp || ''}</td>
        <td class="error">${e.type || ''}</td>
        <td>${e.message || ''}</td>
        <td style="font-size: 10px; max-width: 300px; overflow: hidden; text-overflow: ellipsis;">${e.context || ''}</td>
      </tr>
    `).join('')}
  </table>
  ` : ''}
  
  ${webhookEvents.length > 0 ? `
  <h2>🔌 Webhook Events (${webhookEvents.length})</h2>
  <table>
    <tr><th>Time</th><th>Event Type</th><th>Data</th><th>Result</th></tr>
    ${webhookEvents.map(e => {
      let dataPreview = '';
      try {
        const data = JSON.parse(e.event_data || '{}');
        dataPreview = data.customerEmail || data.eventId || JSON.stringify(data).slice(0, 50);
      } catch { dataPreview = (e.event_data || '').slice(0, 50); }
      
      let resultPreview = '';
      try {
        const result = JSON.parse(e.result || '{}');
        resultPreview = result.processed ? '✅ ' + (result.type || 'processed') : (result.error || JSON.stringify(result).slice(0, 30));
      } catch { resultPreview = (e.result || '').slice(0, 30); }
      
      return `
        <tr>
          <td style="font-size: 11px;">${e.processed_at || ''}</td>
          <td>${e.event_type || ''}</td>
          <td style="font-size: 10px; max-width: 200px; overflow: hidden; text-overflow: ellipsis;" title="${(e.event_data || '').replace(/"/g, '&quot;')}">${dataPreview}...</td>
          <td style="font-size: 11px;">${resultPreview}</td>
        </tr>
      `;
    }).join('')}
  </table>
  ` : ''}
</body>
</html>`;
  res.send(html);
});

app.post('/admin/add-provider', (req, res) => {
  if (req.query.key !== ADMIN_PASSWORD) return res.status(401).send('Unauthorized');
  
  const { company_name, email, phone, city, state, service_zips, credit_balance } = req.body;
  
  db.prepare(`
    INSERT INTO providers (company_name, email, phone, city, state, service_zips, credit_balance, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'Active')
  `).run(company_name, email.toLowerCase().trim(), phone, city || null, (state || '').toUpperCase() || null, service_zips, parseInt(credit_balance) || 0);
  
  console.log(`Provider added: ${company_name} (${email})`);
  res.redirect(`/admin?key=${req.query.key}`);
});

app.get('/admin/export/:type', (req, res) => {
  if (req.query.key !== ADMIN_PASSWORD) return res.status(401).send('Unauthorized');
  
  const type = req.params.type;
  let data, filename;
  
  if (type === 'leads') {
    data = db.prepare('SELECT * FROM leads ORDER BY id DESC').all();
    filename = 'leads.csv';
  } else if (type === 'purchases') {
    data = db.prepare('SELECT * FROM purchase_log ORDER BY id DESC').all();
    filename = 'purchases.csv';
  } else if (type === 'outreach') {
    data = db.prepare('SELECT * FROM outreach ORDER BY id DESC').all();
    filename = 'outreach.csv';
  } else {
    data = db.prepare('SELECT * FROM providers ORDER BY id DESC').all();
    filename = 'providers.csv';
  }
  
  if (data.length === 0) return res.send('No data');
  
  const headers = Object.keys(data[0]);
  const csv = [headers.join(','), ...data.map(row => headers.map(h => `"${(row[h] || '').toString().replace(/"/g, '""')}"`).join(','))].join('\n');
  
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
  res.send(csv);
});

// ============================================
// PUBLIC PROVIDER DIRECTORY
// ============================================

// List providers serving a specific ZIP (for public directory)
app.get('/api/providers/by-zip/:zip', (req, res) => {
  const zip = req.params.zip;
  if (!/^\d{5}$/.test(zip)) {
    return res.status(400).json({ error: 'Invalid ZIP code format' });
  }
  
  const providers = db.prepare(`
    SELECT id, company_name, phone, website, verified, priority, 
           street_address, city, state, business_zip
    FROM providers WHERE status = 'Active'
  `).all();
  
  // Filter by ZIP and sort by priority/verified
  const matching = providers
    .filter(p => {
      const provider = db.prepare('SELECT service_zips FROM providers WHERE id = ?').get(p.id);
      const zips = (provider?.service_zips || '').split(',').map(z => z.trim());
      return zips.includes(zip);
    })
    .map(p => ({
      id: p.id,
      companyName: p.company_name,
      phone: p.phone,
      website: p.website,
      address: [p.street_address, p.city, p.state, p.business_zip].filter(Boolean).join(', ') || null,
      location: [p.city, p.state].filter(Boolean).join(', ') || null,
      verified: !!p.verified,
      featured: p.priority > 0
    }))
    .sort((a, b) => {
      // Featured first, then verified, then alphabetical
      if (a.featured !== b.featured) return b.featured ? 1 : -1;
      if (a.verified !== b.verified) return b.verified ? 1 : -1;
      return a.companyName.localeCompare(b.companyName);
    });
  
  res.json({
    zip,
    count: matching.length,
    providers: matching
  });
});

// List all active providers (paginated)
app.get('/api/providers/directory', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(10, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;
  const state = (req.query.state || '').toUpperCase();
  
  let whereClause = "status = 'Active'";
  const params = [];
  
  if (state && /^[A-Z]{2}$/.test(state)) {
    whereClause += " AND UPPER(state) = ?";
    params.push(state);
  }
  
  const total = db.prepare(`SELECT COUNT(*) as cnt FROM providers WHERE ${whereClause}`).get(...params).cnt;
  
  const providers = db.prepare(`
    SELECT id, company_name, street_address, city, state, business_zip, phone, website, verified, priority, lat, lng, photo_url
    FROM providers 
    WHERE ${whereClause}
    ORDER BY priority DESC, verified DESC, company_name ASC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  
  res.json({
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
    providers: providers.map(p => ({
      id: p.id,
      companyName: p.company_name,
      address: [p.street_address, p.city, p.state, p.business_zip].filter(Boolean).join(', ') || null,
      location: [p.city, p.state].filter(Boolean).join(', ') || null,
      phone: p.phone,
      website: p.website,
      verified: !!p.verified,
      featured: p.priority > 0,
      lat: p.lat,
      lng: p.lng,
      photo: p.photo_url
    }))
  });
});

// ============================================
// PROVIDER PROFILE LOOKUP
// ============================================
app.get('/api/provider', (req, res) => {
  const email = (req.query.email || '').toLowerCase().trim();
  if (!email) {
    return res.status(400).json({ error: 'Email required' });
  }
  
  const provider = getProviderByEmail(email);
  if (!provider) {
    return res.json({ 
      found: false, 
      message: 'No provider account found for this email. Purchase credits to get started!' 
    });
  }
  
  const serviceZips = (provider.service_zips || '').split(',').map(z => z.trim()).filter(z => z);
  
  res.json({
    found: true,
    companyName: provider.company_name,
    email: provider.email,
    creditBalance: provider.credit_balance,
    totalLeads: provider.total_leads,
    status: provider.status,
    verified: !!provider.verified,
    priority: provider.priority || 0,
    serviceZips: serviceZips,
    serviceZipCount: serviceZips.length,
    warnings: serviceZips.length === 0 ? ['No service zips configured - you won\'t receive leads!'] : [],
    tips: [
      serviceZips.length === 0 ? 'Reply to any DumpsterMap email with your service zip codes to start receiving leads.' : null,
      provider.credit_balance === 0 ? 'Purchase credits at dumpstermap.io/for-providers to receive full lead details.' : null,
      !provider.phone ? 'Add a phone number to receive SMS lead alerts.' : null
    ].filter(Boolean)
  });
});

// ============================================
// STATS API (for dashboards/monitoring)
// ============================================
app.get('/api/stats', (req, res) => {
  // Public stats (no auth required)
  const totalLeads = db.prepare('SELECT COUNT(*) as cnt FROM leads').get().cnt;
  const totalProviders = db.prepare("SELECT COUNT(*) as cnt FROM providers WHERE status = 'Active'").get().cnt;
  const leadsToday = db.prepare("SELECT COUNT(*) as cnt FROM leads WHERE date(created_at) = date('now')").get().cnt;
  
  res.json({
    totalLeads,
    totalProviders,
    leadsToday,
    timestamp: new Date().toISOString()
  });
});

// Admin stats (requires auth - supports query param, x-admin-key header, or Authorization bearer)
app.get('/api/admin/stats', (req, res) => {
  const auth = req.query.key || 
               req.headers['x-admin-key'] || 
               (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (auth !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const totalLeads = db.prepare('SELECT COUNT(*) as cnt FROM leads').get().cnt;
  const purchasedLeads = db.prepare("SELECT COUNT(*) as cnt FROM leads WHERE status = 'Purchased'").get().cnt;
  const totalProviders = db.prepare('SELECT COUNT(*) as cnt FROM providers').get().cnt;
  const activeProviders = db.prepare("SELECT COUNT(*) as cnt FROM providers WHERE status = 'Active'").get().cnt;
  const totalRevenue = db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM purchase_log WHERE status LIKE '%Success%' OR status = 'Credits Added'").get().total;
  const outstandingCredits = db.prepare('SELECT COALESCE(SUM(credit_balance), 0) as total FROM providers').get().total;
  const leadsToday = db.prepare("SELECT COUNT(*) as cnt FROM leads WHERE date(created_at) = date('now')").get().cnt;
  const revenueToday = db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM purchase_log WHERE date(timestamp) = date('now') AND (status LIKE '%Success%' OR status = 'Credits Added')").get().total;
  const recentErrors = db.prepare("SELECT COUNT(*) as cnt FROM error_log WHERE timestamp > datetime('now', '-24 hours')").get().cnt;
  
  res.json({
    leads: { total: totalLeads, purchased: purchasedLeads, today: leadsToday },
    providers: { total: totalProviders, active: activeProviders },
    revenue: { total: totalRevenue, today: revenueToday },
    credits: { outstanding: outstandingCredits },
    errors: { last24h: recentErrors },
    timestamp: new Date().toISOString()
  });
});

// ZIP coverage analysis - which zips have active providers
app.get('/api/admin/zip-coverage', (req, res) => {
  const auth = req.query.key || req.headers['x-admin-key'];
  if (auth !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const providers = db.prepare("SELECT id, company_name, email, service_zips, credit_balance FROM providers WHERE status = 'Active'").all();
  
  // Build zip -> providers map
  const zipMap = {};
  for (const p of providers) {
    const zips = (p.service_zips || '').split(',').map(z => z.trim()).filter(z => /^\d{5}$/.test(z));
    for (const zip of zips) {
      if (!zipMap[zip]) zipMap[zip] = [];
      zipMap[zip].push({
        id: p.id,
        name: p.company_name,
        credits: p.credit_balance,
        hasCredits: p.credit_balance > 0
      });
    }
  }
  
  // Get leads by zip (last 30 days)
  const recentLeads = db.prepare("SELECT zip, COUNT(*) as count FROM leads WHERE created_at > datetime('now', '-30 days') GROUP BY zip").all();
  const leadsByZip = Object.fromEntries(recentLeads.map(r => [r.zip, r.count]));
  
  // Identify gaps - zips with leads but no providers (exclude nulls)
  const gaps = Object.keys(leadsByZip)
    .filter(z => !zipMap[z] && z && z !== 'null' && /^\d{5}$/.test(z))
    .map(z => ({
      zip: z,
      leadCount: leadsByZip[z]
    }))
    .sort((a, b) => b.leadCount - a.leadCount);
  
  res.json({
    totalZipsCovered: Object.keys(zipMap).length,
    totalActiveProviders: providers.length,
    providersWithCredits: providers.filter(p => p.credit_balance > 0).length,
    coverage: zipMap,
    gaps,
    timestamp: new Date().toISOString()
  });
});

// Daily summary for monitoring/cron
app.get('/api/admin/daily-summary', (req, res) => {
  const auth = req.query.key || req.headers['x-admin-key'];
  if (auth !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  // Today's metrics
  const today = new Date().toISOString().split('T')[0];
  const leadsToday = db.prepare("SELECT * FROM leads WHERE date(created_at) = date('now')").all();
  const purchasesToday = db.prepare("SELECT * FROM purchase_log WHERE date(timestamp) = date('now')").all();
  const revenueToday = purchasesToday.filter(p => p.status?.includes('Success') || p.status === 'Credits Added').reduce((sum, p) => sum + (p.amount || 0), 0);
  const errorsToday = db.prepare("SELECT COUNT(*) as cnt FROM error_log WHERE date(timestamp) = date('now')").get().cnt;
  
  // Provider activity
  const newProviders = db.prepare("SELECT * FROM providers WHERE date(created_at) = date('now')").all();
  const lowBalanceProviders = db.prepare("SELECT company_name, email, credit_balance FROM providers WHERE credit_balance > 0 AND credit_balance <= 2 AND status = 'Active'").all();
  
  // Lead status breakdown
  const leadsByStatus = db.prepare("SELECT status, COUNT(*) as count FROM leads WHERE date(created_at) = date('now') GROUP BY status").all();
  
  // Outreach activity
  const outreachSentToday = db.prepare("SELECT COUNT(*) as cnt FROM outreach WHERE date(email_sent_at) = date('now')").get().cnt;
  const outreachConvertedToday = db.prepare("SELECT COUNT(*) as cnt FROM outreach WHERE converted = 1 AND date(created_at) = date('now')").get().cnt;
  const outreachPending = db.prepare("SELECT COUNT(*) as cnt FROM outreach WHERE email_status = 'Pending'").get().cnt;
  
  // Providers needing attention (has credits but no ZIPs)
  const providersNeedingZips = db.prepare(`
    SELECT id, company_name, email, credit_balance FROM providers 
    WHERE status = 'Active' AND credit_balance > 0 AND (service_zips IS NULL OR service_zips = '')
  `).all();
  
  res.json({
    date: today,
    leads: {
      total: leadsToday.length,
      byStatus: Object.fromEntries(leadsByStatus.map(s => [s.status || 'New', s.count])),
      zips: [...new Set(leadsToday.map(l => l.zip).filter(Boolean))]
    },
    revenue: {
      total: revenueToday,
      transactions: purchasesToday.length
    },
    providers: {
      new: newProviders.map(p => ({ name: p.company_name, email: p.email })),
      lowBalance: lowBalanceProviders,
      needingZips: providersNeedingZips.map(p => ({ id: p.id, name: p.company_name, credits: p.credit_balance }))
    },
    outreach: {
      sentToday: outreachSentToday,
      convertedToday: outreachConvertedToday,
      pending: outreachPending
    },
    errors: errorsToday,
    timestamp: new Date().toISOString()
  });
});

// Credit pack pricing config (admin view)
app.get('/api/admin/pricing', (req, res) => {
  const auth = req.query.key || req.headers['x-admin-key'];
  if (auth !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  res.json({
    creditPacks: CREDIT_PACKS,
    subscriptions: SUBSCRIPTIONS,
    stripeProductMap: STRIPE_PRODUCT_MAP,
    singleLeadPrice: SINGLE_LEAD_PRICE,
    leadPricing: LEAD_PRICING,
    instructions: {
      addProductMapping: 'To map a Stripe product/price ID to a credit pack, add it to STRIPE_PRODUCT_MAP in server.js',
      example: "STRIPE_PRODUCT_MAP['price_xxx'] = { credits: 5, name: 'Starter Pack' }"
    }
  });
});

// Geocode providers without lat/lng (admin)
app.post('/api/admin/geocode-providers', async (req, res) => {
  const auth = req.query.key || req.headers['x-admin-key'];
  if (auth !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const providers = db.prepare(`
    SELECT id, company_name, street_address, city, state, business_zip 
    FROM providers 
    WHERE (lat IS NULL OR lat = 0) AND street_address IS NOT NULL AND city IS NOT NULL
  `).all();
  
  const results = [];
  for (const p of providers) {
    const fullAddress = `${p.street_address}, ${p.city}, ${p.state} ${p.business_zip || ''}`;
    const coords = await geocodeAddress(fullAddress);
    if (coords) {
      db.prepare('UPDATE providers SET lat = ?, lng = ? WHERE id = ?').run(coords.lat, coords.lng, p.id);
      results.push({ id: p.id, name: p.company_name, ...coords });
      // Rate limit: 1 request per second (Nominatim policy)
      await new Promise(r => setTimeout(r, 1000));
    } else {
      results.push({ id: p.id, name: p.company_name, error: 'Geocoding failed' });
    }
  }
  
  res.json({ geocoded: results.length, results });
});

// Upload provider photo
app.post('/api/provider/upload-photo', upload.single('photo'), (req, res) => {
  try {
    const email = (req.body.email || '').toLowerCase().trim();
    const phoneLast4 = (req.body.phone || '').replace(/\D/g, '').slice(-4);
    
    if (!email || !phoneLast4) {
      return res.status(400).json({ error: 'Email and phone last 4 digits required for verification' });
    }
    
    const provider = getProviderByEmail(email);
    if (!provider || !provider.phone?.endsWith(phoneLast4)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    if (!req.file) {
      return res.status(400).json({ error: 'No photo uploaded' });
    }
    
    const photoUrl = `/uploads/${req.file.filename}`;
    db.prepare('UPDATE providers SET photo_url = ? WHERE id = ?').run(photoUrl, provider.id);
    
    console.log(`Photo uploaded for ${provider.company_name}: ${photoUrl}`);
    res.json({ status: 'ok', photo_url: photoUrl });
  } catch (error) {
    console.error('Photo upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Admin upload photo for any provider
app.post('/api/admin/upload-photo/:id', upload.single('photo'), (req, res) => {
  const auth = req.query.key || req.headers['x-admin-key'];
  if (auth !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  if (!req.file) {
    return res.status(400).json({ error: 'No photo uploaded' });
  }
  
  const providerId = parseInt(req.params.id);
  const photoUrl = `/uploads/${req.file.filename}`;
  db.prepare('UPDATE providers SET photo_url = ? WHERE id = ?').run(photoUrl, providerId);
  
  const provider = db.prepare('SELECT id, company_name, photo_url FROM providers WHERE id = ?').get(providerId);
  console.log(`Admin uploaded photo for ${provider?.company_name}: ${photoUrl}`);
  
  res.json({ status: 'ok', provider });
});

// Clear test data (admin)
app.post('/api/admin/clear-test-data', (req, res) => {
  const auth = req.query.key || req.headers['x-admin-key'];
  if (auth !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  // Delete test leads
  const leadsDeleted = db.prepare("DELETE FROM leads WHERE email LIKE '%test%' OR email LIKE '%example.com'").run().changes;
  
  // Delete test purchase logs (keep real ones)
  const purchasesDeleted = db.prepare("DELETE FROM purchase_log WHERE buyer_email IN ('carygreenwood@gmail.com', 'ogpressvinyl@gmail.com')").run().changes;
  
  // Clear webhook logs older than 1 day
  const webhooksDeleted = db.prepare("DELETE FROM webhook_log WHERE processed_at < datetime('now', '-1 day')").run().changes;
  
  console.log(`Cleared test data: ${leadsDeleted} leads, ${purchasesDeleted} purchases, ${webhooksDeleted} webhooks`);
  
  res.json({ 
    status: 'ok', 
    deleted: { 
      leads: leadsDeleted, 
      purchases: purchasesDeleted,
      webhooks: webhooksDeleted
    }
  });
});

// Delete provider (admin)
app.delete('/api/admin/provider/:id', (req, res) => {
  const auth = req.query.key || req.headers['x-admin-key'];
  if (auth !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const providerId = parseInt(req.params.id);
  const provider = db.prepare('SELECT id, company_name FROM providers WHERE id = ?').get(providerId);
  
  if (!provider) {
    return res.status(404).json({ error: 'Provider not found' });
  }
  
  db.prepare('DELETE FROM providers WHERE id = ?').run(providerId);
  console.log(`Deleted provider: ${provider.company_name} (ID: ${providerId})`);
  
  res.json({ status: 'ok', deleted: provider });
});

// Update provider priority/featured status (admin)
app.post('/api/admin/set-featured/:id', (req, res) => {
  const auth = req.query.key || req.headers['x-admin-key'];
  if (auth !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const providerId = parseInt(req.params.id);
  const priority = parseInt(req.body.priority) || 10;
  const verified = req.body.verified !== undefined ? (req.body.verified ? 1 : 0) : 1;
  
  db.prepare('UPDATE providers SET priority = ?, verified = ? WHERE id = ?').run(priority, verified, providerId);
  
  const provider = db.prepare('SELECT id, company_name, priority, verified FROM providers WHERE id = ?').get(providerId);
  console.log(`Set featured: ${provider?.company_name} (priority=${priority}, verified=${verified})`);
  
  res.json({ status: 'ok', provider });
});

// Error log viewer API (admin)
app.get('/api/admin/errors', (req, res) => {
  const auth = req.query.key || req.headers['x-admin-key'];
  if (auth !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const hours = parseInt(req.query.hours) || 24;
  
  const errors = db.prepare(`
    SELECT * FROM error_log 
    WHERE timestamp > datetime('now', '-${hours} hours')
    ORDER BY id DESC 
    LIMIT ?
  `).all(limit);
  
  res.json({
    count: errors.length,
    timeRange: `Last ${hours} hours`,
    errors: errors.map(e => ({
      timestamp: e.timestamp,
      type: e.type,
      message: e.message,
      context: e.context ? JSON.parse(e.context) : null
    }))
  });
});

// Clear old error logs (admin) - keeps last 7 days
app.post('/api/admin/errors/cleanup', (req, res) => {
  const auth = req.query.key || req.headers['x-admin-key'];
  if (auth !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const result = db.prepare("DELETE FROM error_log WHERE timestamp < datetime('now', '-7 days')").run();
  res.json({ success: true, deleted: result.changes });
});

// Admin endpoint: Get provider details by ID
app.get('/api/admin/provider/:id', (req, res) => {
  const auth = req.query.key || req.headers['x-admin-key'];
  if (auth !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  
  const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(req.params.id);
  if (!provider) return res.status(404).json({ error: 'Provider not found' });
  
  // Get recent leads for this provider
  const recentLeads = db.prepare(`
    SELECT lead_id, created_at, name, zip, status 
    FROM leads 
    WHERE assigned_provider = ? OR assigned_provider_id = ?
    ORDER BY id DESC LIMIT 20
  `).all(provider.company_name, provider.id);
  
  // Get purchase history
  const purchases = db.prepare(`
    SELECT timestamp, lead_id, amount, status 
    FROM purchase_log 
    WHERE LOWER(buyer_email) = LOWER(?)
    ORDER BY id DESC LIMIT 20
  `).all(provider.email);
  
  // Parse service zips
  const serviceZips = (provider.service_zips || '').split(',').map(z => z.trim()).filter(z => z);
  
  res.json({
    id: provider.id,
    companyName: provider.company_name,
    email: provider.email,
    phone: provider.phone,
    address: provider.address,
    serviceZips,
    serviceZipCount: serviceZips.length,
    creditBalance: provider.credit_balance,
    totalLeads: provider.total_leads,
    status: provider.status,
    verified: !!provider.verified,
    priority: provider.priority || 0,
    premiumExpiresAt: provider.premium_expires_at,
    lastPurchaseAt: provider.last_purchase_at,
    createdAt: provider.created_at,
    notes: provider.notes,
    recentLeads,
    purchases
  });
});

// Admin endpoint: Update provider programmatically (API)
app.put('/api/admin/provider/:id', (req, res) => {
  const auth = req.query.key || req.headers['x-admin-key'];
  if (auth !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  
  const providerId = parseInt(req.params.id);
  const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(providerId);
  if (!provider) return res.status(404).json({ error: 'Provider not found' });
  
  // Extract updateable fields from request body
  const updates = {};
  const allowedFields = [
    'company_name', 'email', 'phone', 'street_address', 'city', 'state', 
    'business_zip', 'website', 'service_zips', 'status', 'priority', 
    'verified', 'notes'
  ];
  
  for (const field of allowedFields) {
    if (req.body[field] !== undefined) {
      updates[field] = req.body[field];
    }
  }
  
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update', allowedFields });
  }
  
  // Handle state normalization
  if (updates.state) {
    updates.state = updates.state.toUpperCase();
  }
  
  // Handle verified as boolean → integer
  if (updates.verified !== undefined) {
    updates.verified = updates.verified ? 1 : 0;
  }
  
  // Build composite address if address fields are updated
  if (updates.street_address || updates.city || updates.state || updates.business_zip) {
    const street = updates.street_address ?? provider.street_address;
    const city = updates.city ?? provider.city;
    const state = updates.state ?? provider.state;
    const zip = updates.business_zip ?? provider.business_zip;
    updates.address = [street, city, state, zip].filter(Boolean).join(', ');
  }
  
  // Build UPDATE query dynamically
  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const values = [...Object.values(updates), providerId];
  
  try {
    db.prepare(`UPDATE providers SET ${setClauses} WHERE id = ?`).run(...values);
    
    // Fetch updated provider
    const updated = db.prepare('SELECT * FROM providers WHERE id = ?').get(providerId);
    
    console.log(`API: Provider ${providerId} updated - fields: ${Object.keys(updates).join(', ')}`);
    
    res.json({
      status: 'ok',
      provider: {
        id: updated.id,
        companyName: updated.company_name,
        email: updated.email,
        phone: updated.phone,
        serviceZips: (updated.service_zips || '').split(',').map(z => z.trim()).filter(z => z),
        creditBalance: updated.credit_balance,
        status: updated.status,
        verified: !!updated.verified,
        priority: updated.priority || 0,
        notes: updated.notes
      }
    });
  } catch (e) {
    logError('api', 'Provider update failed', { providerId, updates }, e);
    res.status(500).json({ error: 'Update failed', message: e.message });
  }
});

// Admin endpoint: View credit transaction history
app.get('/api/admin/credit-history', (req, res) => {
  const auth = req.query.key || req.headers['x-admin-key'];
  if (auth !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  
  const providerId = req.query.provider_id ? parseInt(req.query.provider_id) : null;
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const type = req.query.type || null; // 'purchase', 'lead_sent', 'admin_add', 'subscription'
  
  let query = 'SELECT * FROM credit_transactions';
  const params = [];
  const conditions = [];
  
  if (providerId) {
    conditions.push('provider_id = ?');
    params.push(providerId);
  }
  if (type) {
    conditions.push('type = ?');
    params.push(type);
  }
  
  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  query += ' ORDER BY id DESC LIMIT ?';
  params.push(limit);
  
  try {
    const transactions = db.prepare(query).all(...params);
    
    // Summary stats
    const summary = {
      totalCreditsAdded: transactions.filter(t => t.amount > 0).reduce((sum, t) => sum + t.amount, 0),
      totalCreditsUsed: Math.abs(transactions.filter(t => t.amount < 0).reduce((sum, t) => sum + t.amount, 0)),
      transactionCount: transactions.length
    };
    
    res.json({
      transactions: transactions.map(t => ({
        id: t.id,
        timestamp: t.timestamp,
        providerId: t.provider_id,
        providerEmail: t.provider_email,
        type: t.type,
        amount: t.amount,
        balanceAfter: t.balance_after,
        reference: t.reference,
        notes: t.notes
      })),
      summary
    });
  } catch (e) {
    res.json({ error: 'Table may not exist yet - run a credit operation first', message: e.message, transactions: [] });
  }
});

// Admin endpoint: View and manage premium status
app.get('/api/admin/premium-status', (req, res) => {
  const auth = req.query.key || req.headers['x-admin-key'];
  if (auth !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  
  const premiumProviders = db.prepare(`
    SELECT id, company_name, email, verified, priority, premium_expires_at, credit_balance
    FROM providers 
    WHERE premium_expires_at IS NOT NULL OR verified = 1 OR priority > 0
    ORDER BY premium_expires_at DESC
  `).all();
  
  const now = new Date();
  const providers = premiumProviders.map(p => ({
    ...p,
    isActive: p.premium_expires_at ? new Date(p.premium_expires_at) > now : false,
    daysRemaining: p.premium_expires_at ? Math.ceil((new Date(p.premium_expires_at) - now) / (1000 * 60 * 60 * 24)) : null
  }));
  
  res.json({
    total: providers.length,
    active: providers.filter(p => p.isActive).length,
    expired: providers.filter(p => !p.isActive && p.premium_expires_at).length,
    providers
  });
});

// Admin endpoint: View subscription statistics
app.get('/api/admin/subscriptions', (req, res) => {
  const auth = req.query.key || req.headers['x-admin-key'];
  if (auth !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  
  // Get all subscription-related purchases
  const subscriptionPurchases = db.prepare(`
    SELECT * FROM purchase_log 
    WHERE lead_id LIKE 'SUB_%' 
    ORDER BY id DESC 
    LIMIT 100
  `).all();
  
  // Get active premium providers
  const activePremium = db.prepare(`
    SELECT id, company_name, email, credit_balance, premium_expires_at, last_purchase_at
    FROM providers 
    WHERE premium_expires_at > datetime('now')
    AND verified = 1
    ORDER BY premium_expires_at ASC
  `).all();
  
  // Get expiring soon (within 7 days)
  const expiringSoon = db.prepare(`
    SELECT id, company_name, email, premium_expires_at
    FROM providers 
    WHERE premium_expires_at BETWEEN datetime('now') AND datetime('now', '+7 days')
  `).all();
  
  // Revenue stats
  const monthlyRevenue = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM purchase_log 
    WHERE lead_id LIKE 'SUB_%' AND timestamp > datetime('now', '-30 days')
  `).get().total;
  
  const totalRevenue = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM purchase_log 
    WHERE lead_id LIKE 'SUB_%'
  `).get().total;
  
  res.json({
    activePremiumCount: activePremium.length,
    expiringSoonCount: expiringSoon.length,
    monthlyRecurringRevenue: monthlyRevenue,
    totalSubscriptionRevenue: totalRevenue,
    activePremium: activePremium.map(p => ({
      id: p.id,
      company: p.company_name,
      email: p.email,
      credits: p.credit_balance,
      expiresAt: p.premium_expires_at,
      daysLeft: Math.ceil((new Date(p.premium_expires_at) - new Date()) / (1000 * 60 * 60 * 24))
    })),
    expiringSoon: expiringSoon.map(p => ({
      id: p.id,
      company: p.company_name,
      email: p.email,
      expiresAt: p.premium_expires_at,
      daysLeft: Math.ceil((new Date(p.premium_expires_at) - new Date()) / (1000 * 60 * 60 * 24))
    })),
    recentPurchases: subscriptionPurchases.slice(0, 20).map(p => ({
      timestamp: p.timestamp,
      email: p.buyer_email,
      amount: p.amount,
      type: p.lead_id,
      status: p.status
    }))
  });
});

// Admin endpoint: Manually expire premium status
app.post('/api/admin/expire-premium', (req, res) => {
  const auth = req.query.key || req.headers['x-admin-key'];
  if (auth !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  
  const expiredCount = expirePremiumStatus();
  res.json({ success: true, expiredCount });
});

// Admin endpoint: Send premium expiration reminders now
app.post('/api/admin/send-premium-reminders', async (req, res) => {
  const auth = req.query.key || req.headers['x-admin-key'];
  if (auth !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  
  try {
    const reminders = await sendPremiumReminders();
    res.json({ success: true, remindersSent: reminders.length, details: reminders });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin endpoint: View webhook event log
app.get('/api/admin/webhook-log', (req, res) => {
  const auth = req.query.key || req.headers['x-admin-key'];
  if (auth !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  
  try {
    const events = db.prepare(`
      SELECT * FROM webhook_log ORDER BY id DESC LIMIT ?
    `).all(limit);
    
    res.json({
      count: events.length,
      events: events.map(e => ({
        id: e.id,
        processedAt: e.processed_at,
        eventType: e.event_type,
        data: e.event_data ? JSON.parse(e.event_data) : null,
        result: e.result ? JSON.parse(e.result) : null
      }))
    });
  } catch (e) {
    res.json({ error: 'Table may not exist yet', message: e.message, events: [] });
  }
});

// Admin endpoint: Registration funnel stats
app.get('/api/admin/registration-funnel', (req, res) => {
  const auth = req.query.key || req.headers['x-admin-key'];
  if (auth !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  
  const days = parseInt(req.query.days) || 30;
  
  try {
    // Total registrations
    const registrations = db.prepare(`
      SELECT COUNT(*) as count FROM registration_events 
      WHERE event_type = 'registration' 
      AND timestamp > datetime('now', '-' || ? || ' days')
    `).get(days).count;
    
    // Purchases from registered providers
    const purchases = db.prepare(`
      SELECT COUNT(*) as count FROM registration_events 
      WHERE event_type = 'purchase' 
      AND timestamp > datetime('now', '-' || ? || ' days')
    `).get(days).count;
    
    // Registrations by pack
    const byPack = db.prepare(`
      SELECT selected_pack, COUNT(*) as count FROM registration_events 
      WHERE event_type = 'registration' 
      AND timestamp > datetime('now', '-' || ? || ' days')
      GROUP BY selected_pack
    `).all(days);
    
    // Daily breakdown
    const dailyRegistrations = db.prepare(`
      SELECT date(timestamp) as date, COUNT(*) as count FROM registration_events 
      WHERE event_type = 'registration' 
      AND timestamp > datetime('now', '-' || ? || ' days')
      GROUP BY date(timestamp)
      ORDER BY date DESC
    `).all(days);
    
    const conversionRate = registrations > 0 ? ((purchases / registrations) * 100).toFixed(1) : 0;
    
    res.json({
      timeRange: `Last ${days} days`,
      registrations,
      purchases,
      conversionRate: `${conversionRate}%`,
      byPack: Object.fromEntries(byPack.map(p => [p.selected_pack || 'unknown', p.count])),
      dailyBreakdown: dailyRegistrations,
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    res.json({ 
      error: 'Tables may not exist yet', 
      message: e.message,
      registrations: 0,
      purchases: 0,
      conversionRate: '0%'
    });
  }
});

// Admin endpoint: Send batch email to providers (announcements, promotions)
app.post('/api/admin/batch-email', async (req, res) => {
  const auth = req.query.key || req.headers['x-admin-key'];
  if (auth !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  
  const { subject, html, filter, dryRun } = req.body;
  
  if (!subject || !html) {
    return res.status(400).json({ error: 'subject and html required' });
  }
  
  // Build query based on filter
  let whereClause = "status = 'Active'";
  const params = [];
  
  if (filter === 'with_credits') {
    whereClause += " AND credit_balance > 0";
  } else if (filter === 'no_credits') {
    whereClause += " AND credit_balance = 0";
  } else if (filter === 'premium') {
    whereClause += " AND (verified = 1 OR priority > 0)";
  } else if (filter === 'low_balance') {
    whereClause += " AND credit_balance > 0 AND credit_balance <= 2";
  }
  
  const providers = db.prepare(`SELECT id, company_name, email FROM providers WHERE ${whereClause}`).all(...params);
  
  // Dry run - just return who would receive
  if (dryRun) {
    return res.json({
      dryRun: true,
      wouldSendTo: providers.length,
      recipients: providers.map(p => ({ id: p.id, name: p.company_name, email: p.email }))
    });
  }
  
  // Send emails
  let sent = 0, failed = 0;
  const results = [];
  
  for (const provider of providers) {
    // Replace {{company_name}} placeholder
    const personalizedHtml = html.replace(/\{\{company_name\}\}/g, provider.company_name);
    const success = await sendEmail(provider.email, subject, personalizedHtml);
    
    if (success) {
      sent++;
      results.push({ email: provider.email, status: 'sent' });
    } else {
      failed++;
      results.push({ email: provider.email, status: 'failed' });
    }
    
    // Rate limit: 2 emails per second
    await new Promise(r => setTimeout(r, 500));
  }
  
  console.log(`Batch email sent: ${sent}/${providers.length} (${failed} failed)`);
  
  res.json({
    success: true,
    sent,
    failed,
    total: providers.length,
    filter: filter || 'all_active',
    results
  });
});

// Admin endpoint: Add credits to single provider (API)
app.post('/api/admin/provider/:id/credits', (req, res) => {
  const auth = req.query.key || req.headers['x-admin-key'];
  if (auth !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  
  const providerId = parseInt(req.params.id);
  const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(providerId);
  if (!provider) return res.status(404).json({ error: 'Provider not found' });
  
  const credits = parseInt(req.body.credits) || 0;
  const reason = req.body.reason || 'API credit addition';
  
  if (credits === 0) {
    return res.status(400).json({ error: 'credits must be non-zero' });
  }
  
  // Update balance
  db.prepare('UPDATE providers SET credit_balance = credit_balance + ? WHERE id = ?').run(credits, providerId);
  
  // Get new balance
  const newBalance = db.prepare('SELECT credit_balance FROM providers WHERE id = ?').get(providerId).credit_balance;
  
  // Log transaction
  const type = credits > 0 ? 'admin_add' : 'admin_deduct';
  logCreditTransaction(providerId, type, credits, 'api-' + Date.now(), reason);
  
  // Log to purchase log
  db.prepare('INSERT INTO purchase_log (lead_id, buyer_email, amount, payment_id, status) VALUES (?, ?, ?, ?, ?)').run(
    credits > 0 ? 'API_ADD' : 'API_DEDUCT', 
    provider.email, 
    0, 
    'api-' + Date.now(), 
    `API: ${credits > 0 ? '+' : ''}${credits} credits. ${reason}`
  );
  
  console.log(`API: Added ${credits} credits to ${provider.company_name} (ID: ${providerId}) - new balance: ${newBalance}`);
  
  res.json({
    status: 'ok',
    providerId,
    companyName: provider.company_name,
    creditsAdded: credits,
    newBalance,
    reason
  });
});

// Admin endpoint: Bulk add credits to multiple providers
app.post('/api/admin/bulk-add-credits', (req, res) => {
  const auth = req.query.key || req.headers['x-admin-key'];
  if (auth !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  
  const { provider_ids, credits, reason } = req.body;
  if (!provider_ids || !Array.isArray(provider_ids) || provider_ids.length === 0) {
    return res.status(400).json({ error: 'provider_ids array required' });
  }
  
  const creditAmount = parseInt(credits) || 0;
  if (creditAmount <= 0) {
    return res.status(400).json({ error: 'credits must be positive' });
  }
  
  let updated = 0;
  for (const id of provider_ids) {
    try {
      db.prepare('UPDATE providers SET credit_balance = credit_balance + ? WHERE id = ?').run(creditAmount, id);
      const provider = db.prepare('SELECT email FROM providers WHERE id = ?').get(id);
      db.prepare('INSERT INTO purchase_log (lead_id, buyer_email, amount, payment_id, status) VALUES (?, ?, ?, ?, ?)').run(
        'BULK_ADD', provider?.email || '', 0, 'admin-bulk-' + Date.now(), `Bulk: +${creditAmount} credits. ${reason || ''}`
      );
      updated++;
    } catch (e) {
      console.log(`Failed to add credits to provider ${id}:`, e.message);
    }
  }
  
  console.log(`Bulk added ${creditAmount} credits to ${updated} providers`);
  res.json({ success: true, updated, credits: creditAmount, reason });
});

// ============================================
// PROVIDER ZIP ALERTS & REMINDERS
// ============================================

// Send ZIP setup reminders to providers with credits but no ZIPs
app.post('/api/admin/send-zip-reminders', async (req, res) => {
  const auth = req.query.key || req.headers['x-admin-key'];
  if (auth !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  
  const { dryRun } = req.body;
  
  // Find providers who have credits but no service ZIPs
  const providers = db.prepare(`
    SELECT id, company_name, email, credit_balance, created_at
    FROM providers 
    WHERE status = 'Active' 
    AND credit_balance > 0 
    AND (service_zips IS NULL OR service_zips = '')
  `).all();
  
  if (dryRun) {
    return res.json({
      dryRun: true,
      wouldSendTo: providers.length,
      providers: providers.map(p => ({ id: p.id, name: p.company_name, credits: p.credit_balance }))
    });
  }
  
  let sent = 0, failed = 0;
  
  for (const provider of providers) {
    const html = `
<div style="font-family: Arial, sans-serif; max-width: 600px; line-height: 1.6; color: #333;">
  <p>Hi ${provider.company_name},</p>
  
  <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 16px; margin: 20px 0;">
    <strong>⚠️ Action Needed: Set Up Your Service Area</strong>
  </div>
  
  <p>You have <strong>${provider.credit_balance} credit${provider.credit_balance === 1 ? '' : 's'}</strong> ready to use, but we don't know which zip codes you serve yet!</p>
  
  <p>Until you tell us your service area, you won't receive any leads.</p>
  
  <h3 style="color: #1e293b; margin-top: 24px;">How to Fix This (2 minutes)</h3>
  <ol style="line-height: 2;">
    <li><strong>Reply to this email</strong> with your service zip codes (e.g., "34102, 34103, 34104")</li>
    <li>We'll set them up and confirm within 24 hours</li>
    <li>Start receiving leads in your area!</li>
  </ol>
  
  <p style="margin: 24px 0;">
    <a href="mailto:admin@dumpstermap.io?subject=Service%20ZIPs%20for%20${encodeURIComponent(provider.company_name)}&body=My%20service%20zip%20codes%20are:%20" style="background: #f59e0b; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Set My Service ZIPs →</a>
  </p>
  
  <p style="font-size: 14px; color: #64748b; margin-top: 30px;">
    Questions? Just reply to this email.<br>
    — The DumpsterMap Team
  </p>
</div>`;
    
    const success = await sendEmail(provider.email, '⚠️ Action needed: Set your service zip codes', html);
    if (success) {
      sent++;
      console.log(`ZIP reminder sent to ${provider.email}`);
    } else {
      failed++;
    }
    
    // Rate limit
    await new Promise(r => setTimeout(r, 300));
  }
  
  await sendAdminNotification('📧 ZIP Reminders Sent', 
    `Sent: ${sent}\nFailed: ${failed}\nTotal providers needing ZIPs: ${providers.length}`);
  
  res.json({ success: true, sent, failed, total: providers.length });
});

// Export credit transactions as CSV
app.get('/admin/export/credit-history', (req, res) => {
  if (req.query.key !== ADMIN_PASSWORD) return res.status(401).send('Unauthorized');
  
  try {
    const transactions = db.prepare(`
      SELECT 
        ct.id,
        ct.timestamp,
        ct.provider_id,
        ct.provider_email,
        p.company_name,
        ct.type,
        ct.amount,
        ct.balance_after,
        ct.reference,
        ct.notes
      FROM credit_transactions ct
      LEFT JOIN providers p ON ct.provider_id = p.id
      ORDER BY ct.id DESC
    `).all();
    
    if (transactions.length === 0) return res.send('No transactions');
    
    const headers = ['id', 'timestamp', 'provider_id', 'provider_email', 'company_name', 'type', 'amount', 'balance_after', 'reference', 'notes'];
    const csv = [
      headers.join(','),
      ...transactions.map(row => 
        headers.map(h => `"${(row[h] || '').toString().replace(/"/g, '""')}"`).join(',')
      )
    ].join('\n');
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=credit-history.csv');
    res.send(csv);
  } catch (e) {
    res.status(500).send('Error: ' + e.message);
  }
});

// Quick provider search (for admin autocomplete/lookup)
app.get('/api/admin/search-providers', (req, res) => {
  const auth = req.query.key || req.headers['x-admin-key'];
  if (auth !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q || q.length < 2) {
    return res.status(400).json({ error: 'Query must be at least 2 characters' });
  }
  
  const providers = db.prepare(`
    SELECT id, company_name, email, phone, credit_balance, status, verified
    FROM providers 
    WHERE LOWER(company_name) LIKE ? OR LOWER(email) LIKE ? OR phone LIKE ?
    ORDER BY credit_balance DESC
    LIMIT 20
  `).all(`%${q}%`, `%${q}%`, `%${q}%`);
  
  res.json({ count: providers.length, providers });
});

// Get provider leads (for admin deep-dive)
app.get('/api/admin/provider/:id/leads', (req, res) => {
  const auth = req.query.key || req.headers['x-admin-key'];
  if (auth !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  
  const providerId = parseInt(req.params.id);
  const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(providerId);
  if (!provider) return res.status(404).json({ error: 'Provider not found' });
  
  const leads = db.prepare(`
    SELECT * FROM leads 
    WHERE assigned_provider_id = ? 
    OR LOWER(assigned_provider) = LOWER(?)
    OR providers_notified LIKE ?
    ORDER BY id DESC
    LIMIT 100
  `).all(providerId, provider.company_name, `%${provider.company_name}%`);
  
  // Categorize leads
  const fullLeads = leads.filter(l => l.status === 'Sent' || l.status === 'Purchased');
  const teaserLeads = leads.filter(l => l.status === 'Teaser Sent');
  
  res.json({
    provider: { id: provider.id, name: provider.company_name, credits: provider.credit_balance },
    leadCount: leads.length,
    fullLeadCount: fullLeads.length,
    teaserCount: teaserLeads.length,
    leads: leads.map(l => ({
      id: l.lead_id,
      date: l.created_at?.split('T')[0],
      name: l.name,
      zip: l.zip,
      status: l.status,
      notified: l.providers_notified
    }))
  });
});

// Weekly stats summary (for reports)
app.get('/api/admin/weekly-summary', (req, res) => {
  const auth = req.query.key || req.headers['x-admin-key'];
  if (auth !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  
  const weeks = parseInt(req.query.weeks) || 4;
  const summaries = [];
  
  for (let i = 0; i < weeks; i++) {
    const weekStart = `-${i * 7 + 7} days`;
    const weekEnd = `-${i * 7} days`;
    
    const leads = db.prepare(`
      SELECT COUNT(*) as cnt FROM leads 
      WHERE created_at BETWEEN datetime('now', ?) AND datetime('now', ?)
    `).get(weekStart, weekEnd).cnt;
    
    const revenue = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total FROM purchase_log 
      WHERE timestamp BETWEEN datetime('now', ?) AND datetime('now', ?)
      AND (status LIKE '%Success%' OR status = 'Credits Added')
    `).get(weekStart, weekEnd).total;
    
    const newProviders = db.prepare(`
      SELECT COUNT(*) as cnt FROM providers 
      WHERE created_at BETWEEN datetime('now', ?) AND datetime('now', ?)
    `).get(weekStart, weekEnd).cnt;
    
    summaries.push({
      weekNumber: i + 1,
      weeksAgo: i,
      leads,
      revenue,
      newProviders
    });
  }
  
  // Calculate trends
  const thisWeek = summaries[0];
  const lastWeek = summaries[1] || { leads: 0, revenue: 0 };
  
  res.json({
    currentWeek: thisWeek,
    previousWeek: lastWeek,
    trends: {
      leads: lastWeek.leads > 0 ? ((thisWeek.leads - lastWeek.leads) / lastWeek.leads * 100).toFixed(1) + '%' : 'N/A',
      revenue: lastWeek.revenue > 0 ? ((thisWeek.revenue - lastWeek.revenue) / lastWeek.revenue * 100).toFixed(1) + '%' : 'N/A'
    },
    weeklyData: summaries
  });
});

// ============================================
// HEALTH & DEBUG
// ============================================
// Convenience redirect
app.get('/health', (req, res) => res.redirect('/api/health'));

app.get('/api/health', (req, res) => {
  // Check recent webhook activity (last 24h)
  let webhookStatus = 'unknown';
  let lastWebhook = null;
  try {
    const recent = db.prepare(`
      SELECT COUNT(*) as cnt, MAX(processed_at) as last 
      FROM webhook_log 
      WHERE processed_at > datetime('now', '-24 hours')
    `).get();
    webhookStatus = recent.cnt > 0 ? 'active' : 'no_recent_events';
    lastWebhook = recent.last;
  } catch (e) {
    webhookStatus = 'table_not_ready';
  }

  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    database: !!db,
    email: useResend || !!emailTransporter,
    emailProvider: useResend ? 'resend' : (emailTransporter ? 'smtp' : 'none'),
    webhook: {
      status: webhookStatus,
      signatureVerification: !!STRIPE_WEBHOOK_SECRET,
      lastEvent: lastWebhook
    }
  });
});

// Stripe configuration status (admin only)
app.get('/api/admin/stripe-status', (req, res) => {
  const auth = req.query.key || req.headers['x-admin-key'];
  if (auth !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  // Check webhook activity
  let webhookStats = { total: 0, last24h: 0, lastEvent: null, successRate: '0%' };
  try {
    const total = db.prepare('SELECT COUNT(*) as cnt FROM webhook_log').get().cnt;
    const recent = db.prepare(`
      SELECT COUNT(*) as cnt FROM webhook_log 
      WHERE processed_at > datetime('now', '-24 hours')
    `).get().cnt;
    const lastEvent = db.prepare('SELECT * FROM webhook_log ORDER BY id DESC LIMIT 1').get();
    const successful = db.prepare(`
      SELECT COUNT(*) as cnt FROM webhook_log 
      WHERE result LIKE '%"processed":true%'
    `).get().cnt;
    
    webhookStats = {
      total,
      last24h: recent,
      lastEvent: lastEvent ? {
        at: lastEvent.processed_at,
        type: lastEvent.event_type,
        success: lastEvent.result?.includes('"processed":true')
      } : null,
      successRate: total > 0 ? ((successful / total) * 100).toFixed(1) + '%' : 'N/A'
    };
  } catch (e) {
    webhookStats.error = e.message;
  }
  
  res.json({
    config: {
      webhookSecretSet: !!STRIPE_WEBHOOK_SECRET,
      productMappingsCount: Object.keys(STRIPE_PRODUCT_MAP).length,
      singleLeadPrice: SINGLE_LEAD_PRICE
    },
    creditPacks: CREDIT_PACKS,
    subscriptions: SUBSCRIPTIONS,
    productMappings: STRIPE_PRODUCT_MAP,
    paymentLinks: {
      single: SINGLE_LEAD_STRIPE_LINK,
      starter: STRIPE_PACK_LINKS.starter,
      pro: STRIPE_PACK_LINKS.pro,
      premium: STRIPE_PACK_LINKS.premium,
      featured: STRIPE_PACK_LINKS.featured
    },
    webhookStats,
    tips: [
      STRIPE_WEBHOOK_SECRET ? null : '⚠️ STRIPE_WEBHOOK_SECRET not set - webhooks will not verify signatures',
      Object.keys(STRIPE_PRODUCT_MAP).length === 0 ? '💡 Add Stripe price IDs to STRIPE_PRODUCT_MAP for reliable product detection' : null,
    ].filter(Boolean)
  });
});

// Debug endpoint to test webhook flow (admin only)
app.post('/api/admin/test-webhook', async (req, res) => {
  const auth = req.query.key || req.headers['x-admin-key'];
  if (auth !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const { amount, originalAmount, email, leadId, metadata, productName } = req.body;
  console.log('\n=== TEST WEBHOOK ===');
  console.log('Amount:', amount, 'Original:', originalAmount, 'Email:', email, 'LeadId:', leadId);
  
  // Build a mock session object to test full detection logic
  const mockSession = {
    amount_total: amount * 100,
    amount_subtotal: (originalAmount || amount) * 100,
    metadata: metadata || {},
    line_items: productName ? {
      data: [{ description: productName }]
    } : undefined
  };
  
  // Use the same matchCreditPack function as the real webhook
  const matchedPack = matchCreditPack(amount, mockSession);
  
  const result = {
    detected: matchedPack?.isSubscription ? 'subscription' : matchedPack ? 'credit_pack' : leadId ? 'single_lead' : 'unknown',
    pack: matchedPack || null,
    originalAmount: originalAmount || amount,
    wouldAutoCreateProvider: !getProviderByEmail(email || ''),
    existingProvider: getProviderByEmail(email || '') ? true : false
  };
  
  res.json({ test: true, ...result });
});

// Send a test lead to a provider (admin only)
app.post('/api/admin/send-test-lead', async (req, res) => {
  const auth = req.query.key || req.headers['x-admin-key'];
  if (auth !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const { provider_id, zip } = req.body;
  const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(provider_id);
  if (!provider) {
    return res.status(404).json({ error: 'Provider not found' });
  }
  
  const testLead = {
    lead_id: 'TEST-' + Date.now().toString(36).toUpperCase(),
    firstName: 'Test',
    lastName: 'Customer',
    name: 'Test Customer',
    phone: '239-555-' + String(Math.floor(1000 + Math.random() * 9000)),
    email: 'test@example.com',
    zip: zip || '34102',
    size: ['10', '15', '20', '30'][Math.floor(Math.random() * 4)],
    timeframe: ['asap', 'this-week', 'this-month'][Math.floor(Math.random() * 3)],
    projectType: ['Home Renovation', 'Construction', 'Cleanout', 'Roofing'][Math.floor(Math.random() * 4)]
  };
  
  let result = { provider: provider.company_name, testLead };
  
  if (provider.credit_balance > 0) {
    await sendFullLeadToProvider(provider, testLead.lead_id, testLead);
    result.emailType = 'full_lead';
    result.note = 'Sent full lead (provider has credits)';
  } else {
    await sendTeaserToProvider(provider, testLead.lead_id, testLead);
    result.emailType = 'teaser';
    result.note = 'Sent teaser (provider has no credits)';
  }
  
  console.log(`Test lead sent to ${provider.email}:`, result);
  
  // If submitted via form, redirect back
  if (req.headers['content-type']?.includes('form')) {
    return res.redirect(`/admin/edit-provider/${provider_id}?key=${req.query.key}&msg=test_sent`);
  }
  res.json({ success: true, ...result });
});

// Test email templates (admin only)
app.post('/api/admin/test-emails', async (req, res) => {
  const auth = req.query.key || req.headers['x-admin-key'];
  if (auth !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const testEmail = req.body.email || 'admin@dumpstermap.io';
  const results = { sent: [], failed: [] };
  
  // Test data
  const testProvider = {
    id: 999,
    company_name: 'Naples Premium Dumpsters',
    email: testEmail,
    credit_balance: 3
  };
  
  const testLead = {
    lead_id: 'LEAD-TEST-001',
    name: 'Test Customer',
    firstName: 'Test',
    lastName: 'Customer',
    phone: '239-555-9999',
    email: 'testcustomer@example.com',
    zip: '34102',
    size: '20',
    timeframe: 'asap',
    project_type: 'Home Renovation',
    projectType: 'Home Renovation'
  };
  
  try {
    // 1. Teaser email (no credits)
    await sendTeaserToProvider(testProvider, 'LEAD-TEST-001', testLead);
    results.sent.push('teaser');
  } catch (e) {
    results.failed.push({ type: 'teaser', error: e.message });
  }
  
  try {
    // 2. Full lead email (with credits)
    await sendFullLeadToProvider(testProvider, 'LEAD-TEST-001', testLead);
    results.sent.push('full_lead');
  } catch (e) {
    results.failed.push({ type: 'full_lead', error: e.message });
  }
  
  try {
    // 3. Single lead purchase confirmation
    const timeframe = 'ASAP';
    const html = `
<div style="font-family: Arial, sans-serif; max-width: 600px; line-height: 1.6; color: #333;">
  <p>Thanks for your purchase! Here's your lead:</p>
  
  <div style="background: #f0fdf4; border-left: 4px solid #22c55e; padding: 16px; margin: 20px 0;">
    <strong style="font-size: 16px;">📞 Contact</strong><br><br>
    <strong>Name:</strong> ${testLead.name}<br>
    <strong>Phone:</strong> ${testLead.phone}<br>
    <strong>Email:</strong> ${testLead.email}
  </div>
  
  <div style="background: #f8f9fa; padding: 16px; border-radius: 6px; margin: 16px 0;">
    <strong>Project Details:</strong><br>
    • Location: <strong>${testLead.zip}</strong><br>
    • Size: ${testLead.size} yard<br>
    • Timeline: <strong>${timeframe}</strong><br>
    • Project: ${testLead.project_type}
  </div>
  
  <p>💡 <strong>Tip:</strong> Call within 5 minutes — first responder usually wins the job!</p>
  
  <div style="background: #eff6ff; border: 1px solid #bfdbfe; padding: 16px; border-radius: 6px; margin: 20px 0;">
    <strong>Want to pre-purchase future leads?</strong><br>
    Skip the per-lead checkout and get better rates with credit packs.<br>
    <a href="https://dumpstermap.io/for-providers#pricing" style="color: #2563eb; font-weight: bold;">Add credits to your account →</a>
  </div>
  
  <p>— The DumpsterMap Team</p>
</div>`;
    await sendEmail(testEmail, 'Your lead details - LEAD-TEST-001', html);
    results.sent.push('purchase_confirmation');
  } catch (e) {
    results.failed.push({ type: 'purchase_confirmation', error: e.message });
  }
  
  res.json({ 
    success: results.failed.length === 0,
    sentTo: testEmail,
    results 
  });
});

// Provider activity / performance metrics (admin)
app.get('/api/admin/provider-activity', (req, res) => {
  const auth = req.query.key || req.headers['x-admin-key'];
  if (auth !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  
  const days = parseInt(req.query.days) || 30;
  
  // Top providers by leads received
  const topByLeads = db.prepare(`
    SELECT 
      p.id, p.company_name, p.email, p.credit_balance, p.total_leads,
      COUNT(l.id) as recent_leads
    FROM providers p
    LEFT JOIN leads l ON (l.assigned_provider_id = p.id OR LOWER(l.assigned_provider) = LOWER(p.company_name))
      AND l.created_at > datetime('now', '-' || ? || ' days')
    WHERE p.status = 'Active'
    GROUP BY p.id
    ORDER BY recent_leads DESC
    LIMIT 10
  `).all(days);
  
  // Top purchasers (by total spend)
  const topPurchasers = db.prepare(`
    SELECT 
      p.id, p.company_name, p.email, p.credit_balance,
      COALESCE(SUM(pl.amount), 0) as total_spent,
      COUNT(pl.id) as purchase_count
    FROM providers p
    LEFT JOIN purchase_log pl ON LOWER(pl.buyer_email) = LOWER(p.email)
      AND pl.timestamp > datetime('now', '-' || ? || ' days')
      AND (pl.status LIKE '%Success%' OR pl.status = 'Credits Added')
    WHERE p.status = 'Active'
    GROUP BY p.id
    HAVING total_spent > 0
    ORDER BY total_spent DESC
    LIMIT 10
  `).all(days);
  
  // Providers with high credit balances (potential churn risk if not using)
  const highBalanceInactive = db.prepare(`
    SELECT 
      p.id, p.company_name, p.email, p.credit_balance, p.last_purchase_at,
      (SELECT COUNT(*) FROM leads l WHERE l.assigned_provider_id = p.id AND l.created_at > datetime('now', '-30 days')) as leads_30d
    FROM providers p
    WHERE p.status = 'Active' 
    AND p.credit_balance >= 5
    AND (
      SELECT COUNT(*) FROM leads l WHERE l.assigned_provider_id = p.id AND l.created_at > datetime('now', '-14 days')
    ) = 0
    ORDER BY p.credit_balance DESC
    LIMIT 10
  `).all();
  
  // New providers (last 7 days)
  const newProviders = db.prepare(`
    SELECT id, company_name, email, credit_balance, created_at
    FROM providers
    WHERE created_at > datetime('now', '-7 days')
    ORDER BY created_at DESC
    LIMIT 10
  `).all();
  
  // Summary stats
  const totalActive = db.prepare("SELECT COUNT(*) as cnt FROM providers WHERE status = 'Active'").get().cnt;
  const totalWithCredits = db.prepare("SELECT COUNT(*) as cnt FROM providers WHERE status = 'Active' AND credit_balance > 0").get().cnt;
  const avgCredits = db.prepare("SELECT AVG(credit_balance) as avg FROM providers WHERE status = 'Active'").get().avg || 0;
  
  res.json({
    timeRange: `Last ${days} days`,
    summary: {
      activeProviders: totalActive,
      providersWithCredits: totalWithCredits,
      averageCredits: parseFloat(avgCredits.toFixed(1))
    },
    topByLeads: topByLeads.map(p => ({
      id: p.id,
      name: p.company_name,
      email: p.email,
      credits: p.credit_balance,
      totalLeads: p.total_leads,
      recentLeads: p.recent_leads
    })),
    topPurchasers: topPurchasers.map(p => ({
      id: p.id,
      name: p.company_name,
      email: p.email,
      credits: p.credit_balance,
      totalSpent: p.total_spent,
      purchaseCount: p.purchase_count
    })),
    highBalanceInactive: highBalanceInactive.map(p => ({
      id: p.id,
      name: p.company_name,
      credits: p.credit_balance,
      leads30d: p.leads_30d,
      lastPurchase: p.last_purchase_at
    })),
    newProviders: newProviders.map(p => ({
      id: p.id,
      name: p.company_name,
      credits: p.credit_balance,
      createdAt: p.created_at
    })),
    timestamp: new Date().toISOString()
  });
});

// Daily health check endpoint (cron-friendly, returns alerts)
app.get('/api/admin/health-check', (req, res) => {
  const auth = req.query.key || req.headers['x-admin-key'];
  if (auth !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  
  const alerts = [];
  const metrics = {};
  
  // Check providers with credits but no ZIPs (they paid but can't receive leads)
  const providersNoZips = db.prepare(`
    SELECT COUNT(*) as cnt FROM providers 
    WHERE status = 'Active' AND credit_balance > 0 AND (service_zips IS NULL OR service_zips = '')
  `).get().cnt;
  if (providersNoZips > 0) {
    alerts.push({ level: 'critical', message: `${providersNoZips} provider(s) have credits but no service ZIPs` });
  }
  metrics.providersNeedingZips = providersNoZips;
  
  // Check for errors in last 24h
  const recentErrors = db.prepare(`SELECT COUNT(*) as cnt FROM error_log WHERE timestamp > datetime('now', '-24 hours')`).get().cnt;
  if (recentErrors > 5) {
    alerts.push({ level: 'warning', message: `${recentErrors} errors in last 24 hours` });
  }
  metrics.errorsLast24h = recentErrors;
  
  // Check webhook health
  let lastWebhook = null;
  try {
    lastWebhook = db.prepare(`SELECT MAX(processed_at) as last FROM webhook_log`).get().last;
  } catch (e) {}
  metrics.lastWebhookEvent = lastWebhook;
  
  // Check leads today
  const leadsToday = db.prepare(`SELECT COUNT(*) as cnt FROM leads WHERE date(created_at) = date('now')`).get().cnt;
  metrics.leadsToday = leadsToday;
  
  // Check revenue today
  const revenueToday = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM purchase_log 
    WHERE date(timestamp) = date('now') AND (status LIKE '%Success%' OR status = 'Credits Added')
  `).get().total;
  metrics.revenueToday = revenueToday;
  
  // Check premium expiring soon
  const expiringSoon = db.prepare(`
    SELECT COUNT(*) as cnt FROM providers 
    WHERE premium_expires_at BETWEEN datetime('now') AND datetime('now', '+3 days')
  `).get().cnt;
  if (expiringSoon > 0) {
    alerts.push({ level: 'info', message: `${expiringSoon} premium subscription(s) expiring in next 3 days` });
  }
  metrics.premiumExpiringSoon = expiringSoon;
  
  // Overall health status
  const hasCritical = alerts.some(a => a.level === 'critical');
  const hasWarning = alerts.some(a => a.level === 'warning');
  
  res.json({
    status: hasCritical ? 'critical' : hasWarning ? 'warning' : 'healthy',
    timestamp: new Date().toISOString(),
    alerts,
    metrics
  });
});

// Admin maintenance endpoint - run all cleanup tasks
app.post('/api/admin/maintenance', async (req, res) => {
  const auth = req.query.key || req.headers['x-admin-key'];
  if (auth !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const results = {
    timestamp: new Date().toISOString(),
    tasks: {}
  };
  
  // 1. Expire premium status for providers past their 30-day window
  try {
    const expiredCount = expirePremiumStatus();
    results.tasks.premiumExpiration = { success: true, expiredCount };
  } catch (e) {
    results.tasks.premiumExpiration = { success: false, error: e.message };
  }
  
  // 2. Clean up old error logs (older than 7 days)
  try {
    const errorCleanup = db.prepare("DELETE FROM error_log WHERE timestamp < datetime('now', '-7 days')").run();
    results.tasks.errorLogCleanup = { success: true, deleted: errorCleanup.changes };
  } catch (e) {
    results.tasks.errorLogCleanup = { success: false, error: e.message };
  }
  
  // 3. Clean up old webhook logs (older than 7 days)
  try {
    const webhookCleanup = db.prepare("DELETE FROM webhook_log WHERE processed_at < datetime('now', '-7 days')").run();
    results.tasks.webhookLogCleanup = { success: true, deleted: webhookCleanup.changes };
  } catch (e) {
    results.tasks.webhookLogCleanup = { success: false, error: e.message };
  }
  
  // 4. Send premium expiration reminders
  try {
    const reminders = await sendPremiumReminders();
    results.tasks.premiumReminders = { success: true, sent: reminders.length, details: reminders };
  } catch (e) {
    results.tasks.premiumReminders = { success: false, error: e.message };
  }
  
  // 5. Count providers with credits but no ZIPs (action needed)
  try {
    const problemProviders = db.prepare(`
      SELECT id, company_name, email, credit_balance 
      FROM providers 
      WHERE status = 'Active' 
      AND credit_balance > 0 
      AND (service_zips IS NULL OR service_zips = '')
    `).all();
    results.tasks.providersNeedingZips = { 
      success: true, 
      count: problemProviders.length,
      providers: problemProviders.map(p => ({ id: p.id, name: p.company_name, credits: p.credit_balance }))
    };
  } catch (e) {
    results.tasks.providersNeedingZips = { success: false, error: e.message };
  }
  
  // Summary
  const allSuccessful = Object.values(results.tasks).every(t => t.success);
  results.status = allSuccessful ? 'ok' : 'partial';
  
  console.log('[Maintenance]', JSON.stringify(results.tasks));
  res.json(results);
});

// Serve uploaded photos
app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '7d' }));

// Static files with caching
app.use(express.static(path.join(__dirname), { 
  extensions: ['html'],
  maxAge: '1d',  // Cache static assets for 1 day
  setHeaders: (res, filePath) => {
    // Longer cache for immutable assets
    if (filePath.endsWith('.json') && filePath.includes('/data/')) {
      res.setHeader('Cache-Control', 'public, max-age=3600'); // 1 hour for data
    }
  }
}));

app.get('*', (req, res) => {
  const htmlPath = path.join(__dirname, req.path + '.html');
  if (require('fs').existsSync(htmlPath)) return res.sendFile(htmlPath);
  // 404 for unknown routes
  res.status(404).sendFile(path.join(__dirname, '404.html'));
});

// ============================================
// START
// ============================================
initDatabase();
initEmail();

// Check and expire premium status on startup
const expiredCount = expirePremiumStatus();
if (expiredCount > 0) {
  console.log(`Expired premium status for ${expiredCount} providers`);
}

// Check premium expiration and send reminders daily (every 24 hours)
setInterval(async () => {
  // Expire any past-due premium status
  const expired = expirePremiumStatus();
  if (expired > 0) {
    console.log(`[Daily check] Expired premium status for ${expired} providers`);
  }
  
  // Send reminder emails for upcoming expirations
  try {
    const reminders = await sendPremiumReminders();
    if (reminders.length > 0) {
      console.log(`[Daily check] Sent ${reminders.length} premium expiration reminders`);
    }
  } catch (e) {
    console.error('[Daily check] Error sending reminders:', e.message);
  }
}, 24 * 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`DumpsterMap running on port ${PORT}`);
  console.log(`Database: ${DB_PATH}`);
  console.log(`Email: ${emailTransporter ? 'enabled' : 'disabled'}`);
});
