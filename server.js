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

// Gmail SMTP config
const SMTP_USER = process.env.SMTP_USER || 'admin@dumpstermap.io';
const SMTP_PASS = process.env.SMTP_PASS;

// Parse JSON bodies
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
    
    CREATE INDEX IF NOT EXISTS idx_leads_lead_id ON leads(lead_id);
    CREATE INDEX IF NOT EXISTS idx_leads_zip ON leads(zip);
    CREATE INDEX IF NOT EXISTS idx_providers_email ON providers(email);
  `);
  
  console.log('Database initialized:', DB_PATH);
}

// ============================================
// EMAIL SETUP
// ============================================
let emailTransporter = null;

function initEmail() {
  if (!SMTP_PASS) {
    console.log('No SMTP_PASS - Email disabled');
    return null;
  }
  
  emailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  console.log('Email transporter initialized');
  return emailTransporter;
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
  if (!emailTransporter) {
    console.log('Email disabled - would send to:', to, subject);
    return false;
  }
  try {
    await emailTransporter.sendMail({
      from: `"DumpsterMap" <${SMTP_USER}>`,
      to, subject, html, text
    });
    return true;
  } catch (error) {
    console.error('Email error:', error.message);
    return false;
  }
}

async function sendAdminNotification(subject, body) {
  await sendEmail(NOTIFICATION_EMAIL, subject, `<pre>${body}</pre>`, body);
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
app.post('/api/stripe-webhook', async (req, res) => {
  console.log('\n=== Stripe Webhook ===');
  
  try {
    const event = req.body;
    if (event.type !== 'checkout.session.completed') {
      return res.json({ received: true, processed: false });
    }
    
    const session = event.data.object;
    const leadId = session.client_reference_id;
    const customerEmail = session.customer_details?.email || session.customer_email;
    const amount = session.amount_total ? session.amount_total / 100 : 0;
    const paymentId = session.payment_intent || session.id;
    const paymentStatus = session.payment_status;
    
    console.log('Lead:', leadId, 'Customer:', customerEmail, 'Amount:', amount);
    
    // Log purchase attempt
    db.prepare('INSERT INTO purchase_log (lead_id, buyer_email, amount, payment_id, status) VALUES (?, ?, ?, ?, ?)').run(leadId, customerEmail, amount, paymentId, 'Processing');
    
    if (paymentStatus !== 'paid') {
      return res.json({ received: true, error: 'Not paid' });
    }
    if (!leadId) {
      await sendAdminNotification('⚠️ Payment without Lead ID', `Customer: ${customerEmail}\nAmount: $${amount}`);
      return res.json({ received: true, error: 'No lead ID' });
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
    
    res.json({ received: true, processed: true, emailSent });
  } catch (error) {
    console.error('Webhook error:', error);
    res.json({ received: true, error: error.message });
  }
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
  
  const html = `
<!DOCTYPE html>
<html>
<head>
  <title>DumpsterMap Admin</title>
  <style>
    body { font-family: system-ui; padding: 20px; max-width: 1400px; margin: 0 auto; }
    table { border-collapse: collapse; width: 100%; margin: 20px 0; font-size: 13px; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
    th { background: #f5f5f5; }
    tr:hover { background: #f9f9f9; }
    h2 { margin-top: 40px; }
    .status-new { color: blue; }
    .status-sent { color: green; }
    .status-purchased { color: purple; font-weight: bold; }
    .btn { padding: 8px 16px; background: #2563eb; color: white; border: none; border-radius: 4px; cursor: pointer; margin: 5px; }
    .btn:hover { background: #1d4ed8; }
  </style>
</head>
<body>
  <h1>🗑️ DumpsterMap Admin</h1>
  
  <h2>Leads (${leads.length})</h2>
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
  
  <h2>Providers (${providers.length})</h2>
  <table>
    <tr><th>Company</th><th>Email</th><th>Phone</th><th>Zips</th><th>Credits</th><th>Total Leads</th><th>Status</th></tr>
    ${providers.map(p => `
      <tr>
        <td>${p.company_name}</td>
        <td>${p.email}</td>
        <td>${p.phone || ''}</td>
        <td>${p.service_zips || ''}</td>
        <td><strong>${p.credit_balance}</strong></td>
        <td>${p.total_leads}</td>
        <td>${p.status}</td>
      </tr>
    `).join('')}
  </table>
  
  <h2>Add Provider</h2>
  <form action="/admin/add-provider?key=${auth}" method="POST" style="display: flex; gap: 10px; flex-wrap: wrap;">
    <input name="company_name" placeholder="Company Name" required>
    <input name="email" placeholder="Email" required>
    <input name="phone" placeholder="Phone">
    <input name="service_zips" placeholder="Zips (comma-separated)">
    <input name="credit_balance" placeholder="Credits" type="number" value="0">
    <button class="btn">Add Provider</button>
  </form>
  
  <h2>Recent Purchases</h2>
  <table>
    <tr><th>Time</th><th>Lead</th><th>Buyer</th><th>Amount</th><th>Status</th></tr>
    ${purchases.map(p => `
      <tr>
        <td>${p.timestamp || ''}</td>
        <td>${p.lead_id || ''}</td>
        <td>${p.buyer_email || ''}</td>
        <td>$${p.amount || 0}</td>
        <td>${p.status || ''}</td>
      </tr>
    `).join('')}
  </table>
  
  <h2>Export</h2>
  <a href="/admin/export/leads?key=${auth}" class="btn">Export Leads CSV</a>
  <a href="/admin/export/providers?key=${auth}" class="btn">Export Providers CSV</a>
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
// HEALTH & STATIC
// ============================================
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    database: !!db,
    email: !!emailTransporter
  });
});

app.use(express.static(path.join(__dirname), { extensions: ['html'] }));

app.get('*', (req, res) => {
  const htmlPath = path.join(__dirname, req.path + '.html');
  if (require('fs').existsSync(htmlPath)) return res.sendFile(htmlPath);
  res.sendFile(path.join(__dirname, 'index.html'));
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
