const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

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
    
    CREATE INDEX IF NOT EXISTS idx_leads_lead_id ON leads(lead_id);
    CREATE INDEX IF NOT EXISTS idx_outreach_email ON outreach(provider_email);
    CREATE INDEX IF NOT EXISTS idx_leads_zip ON leads(zip);
    CREATE INDEX IF NOT EXISTS idx_providers_email ON providers(email);
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
  
  console.log('Database initialized:', DB_PATH);
}

// ============================================
// EMAIL SETUP (Resend primary, SMTP fallback)
// ============================================
let emailTransporter = null;
let useResend = false;

function initEmail() {
  // Prefer Resend if API key is set
  if (RESEND_API_KEY) {
    useResend = true;
    console.log('Email: Using Resend API');
    return true;
  }
  
  // Fallback to SMTP
  if (SMTP_PASS) {
    emailTransporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    });
    console.log('Email: Using SMTP/Gmail');
    return emailTransporter;
  }
  
  console.log('Email: DISABLED (no RESEND_API_KEY or SMTP_PASS)');
  return null;
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

async function sendEmail(to, subject, html, text) {
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
          from: EMAIL_FROM,
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

function logError(type, message, context = {}) {
  try {
    db.prepare('INSERT INTO error_log (type, message, context) VALUES (?, ?, ?)').run(type, message, JSON.stringify(context));
  } catch (e) {
    console.error('Failed to log error:', e);
  }
  console.error(`[${type}] ${message}`, context);
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
  700: { credits: 20, name: 'Pro Pack' },
  1500: { credits: 60, name: 'Premium Pack' }
};

// Map Stripe product IDs to credit packs (more reliable than amount matching)
// Add your Stripe product/price IDs here as you create them in Stripe
const STRIPE_PRODUCT_MAP = {
  // Format: 'price_xxx' or 'prod_xxx' => { credits: X, name: 'Y' }
  // Example: 'price_1234567890': { credits: 5, name: 'Starter Pack' }
};

// Flexible amount matching (handles minor Stripe fee variations)
function matchCreditPack(amount, session = null) {
  // First, check Stripe product/price IDs if available (most reliable)
  if (session) {
    const lineItems = session.line_items?.data || [];
    for (const item of lineItems) {
      const priceId = item.price?.id;
      const productId = item.price?.product;
      if (priceId && STRIPE_PRODUCT_MAP[priceId]) return STRIPE_PRODUCT_MAP[priceId];
      if (productId && STRIPE_PRODUCT_MAP[productId]) return STRIPE_PRODUCT_MAP[productId];
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
    
    if (event.type !== 'checkout.session.completed') {
      return res.json({ received: true, processed: false });
    }
    
    const session = event.data.object;
    const leadId = session.client_reference_id;
    const customerEmail = session.customer_details?.email || session.customer_email;
    const customerName = session.customer_details?.name;
    const amount = session.amount_total ? session.amount_total / 100 : 0;
    const paymentId = session.payment_intent || session.id;
    const paymentStatus = session.payment_status;
    
    console.log('Payment:', { leadId, customerEmail, amount, paymentStatus });
    
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
    
    if (matchedPack) {
      const pack = matchedPack;
      const isSubscription = !!matchedPack.isSubscription;
      // === CREDIT PACK OR SUBSCRIPTION PURCHASE ===
      console.log(`${isSubscription ? 'Subscription' : 'Credit pack'} purchase: ${pack.name} (${pack.credits} credits) for $${amount}`);
      
      // Get or create provider
      const provider = getOrCreateProvider(customerEmail, customerName);
      
      // Add credits and update last purchase time
      db.prepare("UPDATE providers SET credit_balance = credit_balance + ?, last_purchase_at = datetime('now') WHERE id = ?").run(pack.credits, provider.id);
      
      // Apply subscription perks if any
      if (isSubscription && pack.perks) {
        if (pack.perks.includes('verified')) {
          db.prepare('UPDATE providers SET verified = 1 WHERE id = ?').run(provider.id);
        }
        if (pack.perks.includes('priority')) {
          db.prepare('UPDATE providers SET priority = priority + 10 WHERE id = ?').run(provider.id);
        }
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
    await sendAdminNotification('❌ Webhook Error', error.toString());
    res.json({ received: true, error: error.message });
  }
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
  </div>
  
  <div class="stats">
    <div class="stat"><div class="stat-value">${totalLeads}</div><div class="stat-label">Total Leads</div></div>
    <div class="stat"><div class="stat-value">$${totalRevenue.toFixed(0)}</div><div class="stat-label">Revenue</div></div>
    <div class="stat"><div class="stat-value">${providers.length}</div><div class="stat-label">Providers</div></div>
    <div class="stat"><div class="stat-value">${totalCredits}</div><div class="stat-label">Credits Outstanding</div></div>
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
  <table>
    <tr><th>ID</th><th>Company</th><th>Email</th><th>Phone</th><th>Zips</th><th>Credits</th><th>Leads</th><th>Status</th><th>Last Purchase</th><th>Actions</th></tr>
    ${providers.map(p => {
      const verifiedBadge = p.verified ? '<span title="Verified" style="color:#16a34a">✓</span> ' : '';
      const priorityBadge = p.priority > 0 ? `<span title="Priority: ${p.priority}" style="color:#f59e0b">⭐</span>` : '';
      const lastPurchase = p.last_purchase_at ? p.last_purchase_at.split('T')[0] : '<em style="color:#94a3b8">never</em>';
      const zipCount = p.service_zips ? p.service_zips.split(',').filter(z => z.trim()).length : 0;
      const zipDisplay = zipCount > 0 ? `<span title="${p.service_zips}">${zipCount} zips</span>` : '<em style="color:#dc2626">none!</em>';
      return `
        <tr>
          <td>${p.id}</td>
          <td>${verifiedBadge}${priorityBadge}${p.company_name}</td>
          <td>${p.email}</td>
          <td>${p.phone || ''}</td>
          <td>${zipDisplay}</td>
          <td><span class="credit-badge">${p.credit_balance}</span></td>
          <td>${p.total_leads}</td>
          <td>${p.status}</td>
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
      <input name="company_name" placeholder="Company Name" required>
      <input name="email" placeholder="Email" required>
      <input name="phone" placeholder="Phone">
      <input name="address" placeholder="Address" style="min-width: 200px;">
      <input name="service_zips" placeholder="Zips (comma-separated)">
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
      
      <label>Address</label>
      <input name="address" value="${provider.address || ''}" placeholder="123 Main St, City, State ZIP">
      
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
  
  const { company_name, email, phone, address, service_zips, credit_balance, status, priority, verified, notes } = req.body;
  db.prepare(`
    UPDATE providers SET company_name = ?, email = ?, phone = ?, address = ?, service_zips = ?, credit_balance = ?, status = ?, priority = ?, verified = ?, notes = ?
    WHERE id = ?
  `).run(company_name, email, phone, address, service_zips, parseInt(credit_balance) || 0, status, parseInt(priority) || 0, verified ? 1 : 0, notes, req.params.id);
  
  console.log(`Provider ${req.params.id} updated`);
  res.redirect(`/admin?key=${req.query.key}`);
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
  
  console.log(`Added ${creditAmount} credits to provider ${provider_id}: ${reason || 'no reason'}`);
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
    <div class="stat"><div class="stat-value">${sentCount}</div><div class="stat-label">Emails Sent</div></div>
    <div class="stat"><div class="stat-value">${convertedCount}</div><div class="stat-label">Converted</div></div>
    <div class="stat"><div class="stat-value">${totalOutreach > 0 ? ((convertedCount / totalOutreach) * 100).toFixed(1) : 0}%</div><div class="stat-label">Conversion Rate</div></div>
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
  
  <h2>Export</h2>
  <a href="/admin/export/outreach?key=${req.query.key}" class="btn">Export Outreach CSV</a>
</body>
</html>`;
  res.send(html);
});

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

// System logs page
app.get('/admin/logs', (req, res) => {
  if (req.query.key !== ADMIN_PASSWORD) return res.status(401).send('Unauthorized');
  
  const purchases = db.prepare('SELECT * FROM purchase_log ORDER BY id DESC LIMIT 200').all();
  const errors = db.prepare('SELECT * FROM error_log ORDER BY id DESC LIMIT 100').all();
  
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
</body>
</html>`;
  res.send(html);
});

app.post('/admin/add-provider', (req, res) => {
  if (req.query.key !== ADMIN_PASSWORD) return res.status(401).send('Unauthorized');
  
  const { company_name, email, phone, address, service_zips, credit_balance } = req.body;
  db.prepare(`
    INSERT INTO providers (company_name, email, phone, address, service_zips, credit_balance)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(company_name, email, phone, address, service_zips, parseInt(credit_balance) || 0);
  
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
      lowBalance: lowBalanceProviders
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

// ============================================
// HEALTH & DEBUG
// ============================================
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    database: !!db,
    email: useResend || !!emailTransporter,
    emailProvider: useResend ? 'resend' : (emailTransporter ? 'smtp' : 'none')
  });
});

// Debug endpoint to test webhook flow (admin only)
app.post('/api/admin/test-webhook', async (req, res) => {
  const auth = req.query.key || req.headers['x-admin-key'];
  if (auth !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const { amount, email, leadId } = req.body;
  console.log('\n=== TEST WEBHOOK ===');
  console.log('Amount:', amount, 'Email:', email, 'LeadId:', leadId);
  
  // Simulate what the webhook would detect
  const creditPack = CREDIT_PACKS[amount];
  const subscription = SUBSCRIPTIONS[amount];
  const result = {
    detected: creditPack ? 'credit_pack' : subscription ? 'subscription' : leadId ? 'single_lead' : 'unknown',
    pack: creditPack || subscription || null,
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

app.listen(PORT, () => {
  console.log(`DumpsterMap running on port ${PORT}`);
  console.log(`Database: ${DB_PATH}`);
  console.log(`Email: ${emailTransporter ? 'enabled' : 'disabled'}`);
});
