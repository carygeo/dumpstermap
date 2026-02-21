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
app.post('/api/lead', async (req, res) => {
  console.log('\n=== Lead Submission ===');
  
  try {
    const data = req.body;
    const leadId = generateLeadId();
    const name = ((data.firstName || '') + ' ' + (data.lastName || '')).trim();
    
    // Save lead
    db.prepare(`
      INSERT INTO leads (lead_id, name, email, phone, zip, project_type, size, timeframe, message, source, assigned_provider)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(leadId, name, data.email, data.phone, data.zip, data.projectType, data.size, 
           data.timeframe || data.timeline, data.message, data.source || 'Website', data.providerName || '');
    
    console.log('Lead saved:', leadId);
    
    // Find matching providers
    const providers = getProvidersByZip(data.zip);
    console.log(`Found ${providers.length} providers for zip ${data.zip}`);
    
    for (const provider of providers) {
      if (provider.credit_balance > 0) {
        await sendFullLeadToProvider(provider, leadId, data);
        db.prepare('UPDATE providers SET credit_balance = credit_balance - 1, total_leads = total_leads + 1 WHERE id = ?').run(provider.id);
        db.prepare('UPDATE leads SET status = ?, assigned_provider = ?, credits_charged = 1 WHERE lead_id = ?').run('Sent', provider.company_name, leadId);
      } else {
        await sendTeaserToProvider(provider, leadId, data);
      }
    }
    
    await sendAdminNotification(`New lead: ${leadId} - ${data.zip}`,
      `${leadId}\n${name} | ${data.phone} | ${data.email}\n${data.zip} | ${data.size || 'TBD'} | ${providers.length} providers matched`);
    
    res.json({ status: 'ok', leadId, message: 'Lead submitted successfully' });
  } catch (error) {
    console.error('Lead error:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

async function sendFullLeadToProvider(provider, leadId, lead) {
  const timeframe = lead.timeframe === 'asap' ? 'ASAP' : lead.timeframe || 'soon';
  const html = `
<div style="font-family: Arial, sans-serif; max-width: 600px;">
  <p>Hi ${provider.company_name},</p>
  <p>New lead in <strong>${lead.zip}</strong> - needs it <strong>${timeframe}</strong>.</p>
  <div style="background: #f0fdf4; border: 1px solid #86efac; padding: 20px; border-radius: 8px; margin: 20px 0;">
    <strong>Contact:</strong><br>
    Name: ${lead.firstName || ''} ${lead.lastName || ''}<br>
    Phone: ${lead.phone || 'N/A'}<br>
    Email: ${lead.email || 'N/A'}
  </div>
  <div style="background: #f9f9f9; padding: 20px; border-radius: 8px;">
    <strong>Project:</strong><br>
    Size: ${lead.size ? lead.size + ' yard' : 'TBD'}<br>
    Type: ${lead.projectType || 'Not specified'}
  </div>
  <p><strong>Tip:</strong> Call within 5 minutes for best results!</p>
  <p style="color: #666; font-size: 12px;">1 credit used. <a href="https://dumpstermap.io/balance">Check balance</a></p>
</div>`;
  await sendEmail(provider.email, `New lead in ${lead.zip}`, html);
}

async function sendTeaserToProvider(provider, leadId, lead) {
  const paymentLink = `${SINGLE_LEAD_STRIPE_LINK}?client_reference_id=${leadId}`;
  const timeframe = lead.timeframe === 'asap' ? 'ASAP' : lead.timeframe || 'soon';
  const html = `
<div style="font-family: Arial, sans-serif; max-width: 600px;">
  <p>Hi,</p>
  <p>A customer in <strong>${lead.zip}</strong> needs a dumpster <strong>${timeframe}</strong>.</p>
  <div style="background: #f9f9f9; padding: 16px; border-radius: 6px; margin: 16px 0;">
    Location: ${lead.zip}<br>
    Size: ${lead.size ? lead.size + ' yard' : 'Not sure yet'}<br>
    Timeline: ${timeframe}
  </div>
  <p>Get their contact info: <a href="${paymentLink}">${paymentLink}</a></p>
  <p><strong>How it works:</strong></p>
  <ol><li>Pay $40</li><li>Get name, phone, email instantly</li><li>Call and close the deal</li></ol>
  <p>— DumpsterMap</p>
</div>`;
  await sendEmail(provider.email, `Customer looking for dumpster in ${lead.zip}`, html);
}

// ============================================
// STRIPE WEBHOOK
// ============================================

// Credit pack pricing (one-time purchases)
const CREDIT_PACKS = {
  200: { credits: 5, name: 'Starter Pack' },
  700: { credits: 20, name: 'Pro Pack' },
  1500: { credits: 60, name: 'Premium Pack' }
};

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
      event = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
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
    
    // Check if this is a credit pack purchase (by amount)
    const creditPack = CREDIT_PACKS[amount];
    const subscription = SUBSCRIPTIONS[amount];
    
    if (creditPack || subscription) {
      const pack = creditPack || subscription;
      const isSubscription = !!subscription;
      // === CREDIT PACK OR SUBSCRIPTION PURCHASE ===
      console.log(`${isSubscription ? 'Subscription' : 'Credit pack'} purchase: ${pack.name} (${pack.credits} credits) for $${amount}`);
      
      // Get or create provider
      const provider = getOrCreateProvider(customerEmail, customerName);
      
      // Add credits and update last purchase time
      db.prepare("UPDATE providers SET credit_balance = credit_balance + ?, last_purchase_at = datetime('now') WHERE id = ?").run(pack.credits, provider.id);
      
      // Apply subscription perks if any
      if (isSubscription && subscription.perks) {
        if (subscription.perks.includes('verified')) {
          db.prepare('UPDATE providers SET verified = 1 WHERE id = ?').run(provider.id);
        }
        if (subscription.perks.includes('priority')) {
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
    
    // Send full lead details
    const html = `
<div style="font-family: Arial, sans-serif; max-width: 600px;">
  <p>Thanks for your purchase! Here's your lead:</p>
  <div style="background: #f0fdf4; border: 1px solid #86efac; padding: 20px; border-radius: 8px; margin: 20px 0;">
    <strong>Contact:</strong><br>
    Name: ${lead.name}<br>
    Phone: ${lead.phone}<br>
    Email: ${lead.email}
  </div>
  <div style="background: #f9f9f9; padding: 20px; border-radius: 8px;">
    Location: ${lead.zip}<br>
    Size: ${lead.size || 'TBD'}<br>
    Timeline: ${lead.timeframe || 'TBD'}<br>
    Project: ${lead.project_type || 'Not specified'}
  </div>
  <p><strong>Tip:</strong> Call within 5 minutes!</p>
</div>`;
    
    const emailSent = await sendEmail(customerEmail, `Your lead details - ${leadId}`, html);
    
    // Update lead
    db.prepare(`
      UPDATE leads SET status = 'Purchased', purchased_by = ?, purchased_at = datetime('now'), payment_id = ?, email_sent = ?
      WHERE lead_id = ?
    `).run(customerEmail, paymentId, emailSent ? 'Yes' : 'Failed', leadId);
    
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
  
  res.json({
    status: 'ok',
    companyName: provider.company_name,
    creditBalance: provider.credit_balance,
    totalLeadsReceived: provider.total_leads,
    plan: provider.plan
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
    <tr><th>ID</th><th>Date</th><th>Name</th><th>Phone</th><th>Email</th><th>Zip</th><th>Size</th><th>Status</th><th>Provider</th><th>Purchased By</th></tr>
    ${leads.map(l => `
      <tr>
        <td>${l.lead_id}</td>
        <td>${l.created_at?.split('T')[0] || ''}</td>
        <td>${l.name || ''}</td>
        <td>${l.phone || ''}</td>
        <td>${l.email || ''}</td>
        <td>${l.zip || ''}</td>
        <td>${l.size || ''}</td>
        <td class="status-${(l.status||'').toLowerCase()}">${l.status || ''}</td>
        <td>${l.assigned_provider || ''}</td>
        <td>${l.purchased_by || ''}</td>
      </tr>
    `).join('')}
  </table>
  
  <h2 id="providers">Providers (${providers.length})</h2>
  <table>
    <tr><th>ID</th><th>Company</th><th>Email</th><th>Phone</th><th>Zips</th><th>Credits</th><th>Leads</th><th>Status</th><th>Actions</th></tr>
    ${providers.map(p => `
      <tr>
        <td>${p.id}</td>
        <td>${p.company_name}</td>
        <td>${p.email}</td>
        <td>${p.phone || ''}</td>
        <td>${p.service_zips || '<em style="color:#94a3b8">none</em>'}</td>
        <td><span class="credit-badge">${p.credit_balance}</span></td>
        <td>${p.total_leads}</td>
        <td>${p.status}</td>
        <td>
          <a href="/admin/edit-provider/${p.id}?key=${auth}" class="btn btn-sm">Edit</a>
        </td>
      </tr>
    `).join('')}
  </table>
  
  <div class="card">
    <h3>Add New Provider</h3>
    <form action="/admin/add-provider?key=${auth}" method="POST" style="display: flex; gap: 10px; flex-wrap: wrap; align-items: center;">
      <input name="company_name" placeholder="Company Name" required>
      <input name="email" placeholder="Email" required>
      <input name="phone" placeholder="Phone">
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
  
  const { company_name, email, phone, service_zips, credit_balance, status, priority, notes } = req.body;
  db.prepare(`
    UPDATE providers SET company_name = ?, email = ?, phone = ?, service_zips = ?, credit_balance = ?, status = ?, priority = ?, notes = ?
    WHERE id = ?
  `).run(company_name, email, phone, service_zips, parseInt(credit_balance) || 0, status, parseInt(priority) || 0, notes, req.params.id);
  
  console.log(`Provider ${req.params.id} updated`);
  res.redirect(`/admin?key=${req.query.key}`);
});

// Delete provider
app.post('/admin/delete-provider/:id', (req, res) => {
  if (req.query.key !== ADMIN_PASSWORD) return res.status(401).send('Unauthorized');
  db.prepare('DELETE FROM providers WHERE id = ?').run(req.params.id);
  console.log(`Provider ${req.params.id} deleted`);
  res.redirect(`/admin?key=${req.query.key}`);
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
  
  const { company_name, email, phone, service_zips, credit_balance } = req.body;
  db.prepare(`
    INSERT INTO providers (company_name, email, phone, service_zips, credit_balance)
    VALUES (?, ?, ?, ?, ?)
  `).run(company_name, email, phone, service_zips, parseInt(credit_balance) || 0);
  
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

// Admin stats (requires auth)
app.get('/api/admin/stats', (req, res) => {
  const auth = req.query.key || req.headers['x-admin-key'];
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

// ============================================
// HEALTH & STATIC
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
