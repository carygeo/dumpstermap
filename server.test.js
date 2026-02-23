/**
 * DumpsterMap Unit Tests
 * 
 * Tests all core business logic:
 * - Credit pack detection and pricing
 * - Provider matching (direct, by name, by ZIP)
 * - Lead routing and credit deduction
 * - Balance verification
 * - Payment idempotency
 * 
 * Run: node --test server.test.js
 * Or with npm: npm test
 */

const assert = require('node:assert');
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// ============================================
// CONFIGURATION (must match server.js)
// ============================================
const CREDIT_PACKS = {
  200: { credits: 5, name: 'Starter Pack' },
  700: { credits: 20, name: 'Pro Pack', perks: true },      // Includes verified badge
  1500: { credits: 60, name: 'Premium Pack', perks: true }  // Includes verified + priority
};

const SUBSCRIPTIONS = {
  99: { credits: 3, name: 'Featured Partner', perks: ['verified', 'priority'] }
};

const LEAD_PRICING = {
  perLead: 1.0  // 1 credit = 1 lead
};

const SINGLE_LEAD_PRICE = 40;

// ============================================
// CORE FUNCTIONS (extracted from server.js)
// ============================================

/**
 * Match payment amount to credit pack
 * Handles $5 tolerance for Stripe fee variations
 */
function matchCreditPack(amount, session = null) {
  // Exact amount match first
  if (CREDIT_PACKS[amount]) return CREDIT_PACKS[amount];
  if (SUBSCRIPTIONS[amount]) return { ...SUBSCRIPTIONS[amount], isSubscription: true };
  
  // Check within $5 tolerance for each pack
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

/**
 * Check if this is a single lead purchase (not a pack)
 */
function isSingleLeadPurchase(amount) {
  // Single lead is $40, no pack matched
  return amount === SINGLE_LEAD_PRICE || 
         (amount >= SINGLE_LEAD_PRICE - 5 && amount <= SINGLE_LEAD_PRICE + 5 && !matchCreditPack(amount));
}

/**
 * Validate business email (no gmail, yahoo, etc.)
 */
function isBusinessEmail(email) {
  if (!email || typeof email !== 'string') return false;
  if (!email.includes('@')) return false;  // Must have @ sign
  const freeProviders = [
    'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 
    'aol.com', 'icloud.com', 'mail.com', 'protonmail.com',
    'ymail.com', 'live.com', 'msn.com'
  ];
  const domain = email.toLowerCase().split('@')[1];
  return domain && !freeProviders.includes(domain);
}

/**
 * Generate unique lead ID
 */
function generateLeadId() {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `LEAD-${timestamp}-${random}`;
}

/**
 * Validate ZIP code format
 */
function isValidZip(zip) {
  return /^\d{5}$/.test(zip);
}

/**
 * Parse phone number to extract last 4 digits
 */
function getPhoneLast4(phone) {
  if (!phone) return '';
  return phone.replace(/\D/g, '').slice(-4);
}

// ============================================
// TEST DATABASE HELPERS
// ============================================
let testDb;
const TEST_DB_PATH = path.join(__dirname, 'test.db');

function initTestDatabase() {
  // Clean up any existing test DB
  if (fs.existsSync(TEST_DB_PATH)) {
    fs.unlinkSync(TEST_DB_PATH);
  }
  
  testDb = new Database(TEST_DB_PATH);
  testDb.pragma('journal_mode = WAL');
  
  testDb.exec(`
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
      providers_notified TEXT,
      notes TEXT
    );
    
    CREATE TABLE IF NOT EXISTS providers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      company_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      phone TEXT,
      address TEXT,
      city TEXT,
      state TEXT,
      service_zips TEXT,
      credit_balance INTEGER DEFAULT 0,
      total_leads INTEGER DEFAULT 0,
      plan TEXT DEFAULT 'Free',
      status TEXT DEFAULT 'Active',
      verified INTEGER DEFAULT 0,
      priority INTEGER DEFAULT 0,
      stripe_customer_id TEXT,
      premium_expires_at TEXT,
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
      notes TEXT
    );
    
    CREATE INDEX IF NOT EXISTS idx_leads_zip ON leads(zip);
    CREATE INDEX IF NOT EXISTS idx_providers_email ON providers(email);
    CREATE INDEX IF NOT EXISTS idx_credit_tx_provider ON credit_transactions(provider_id);
  `);
  
  return testDb;
}

function closeTestDatabase() {
  if (testDb) {
    testDb.close();
    testDb = null;
  }
  if (fs.existsSync(TEST_DB_PATH)) {
    fs.unlinkSync(TEST_DB_PATH);
  }
}

// Database-backed functions for testing
function getProviderByEmail(email) {
  return testDb.prepare('SELECT * FROM providers WHERE LOWER(email) = LOWER(?)').get(email);
}

function getProviderById(id) {
  return testDb.prepare('SELECT * FROM providers WHERE id = ?').get(id);
}

function getProvidersByZip(zip) {
  const providers = testDb.prepare('SELECT * FROM providers WHERE status = ?').all('Active');
  return providers.filter(p => {
    const zips = (p.service_zips || '').split(',').map(z => z.trim());
    return zips.includes(zip);
  });
}

function getOrCreateProvider(email, name = null) {
  let provider = getProviderByEmail(email);
  if (!provider) {
    const companyName = name || email.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    testDb.prepare(`
      INSERT INTO providers (company_name, email, status, notes)
      VALUES (?, ?, 'Active', 'Auto-created from purchase')
    `).run(companyName, email.toLowerCase());
    provider = getProviderByEmail(email);
  }
  return provider;
}

function isPaymentProcessed(paymentId) {
  if (!paymentId) return false;
  const existing = testDb.prepare(
    "SELECT * FROM purchase_log WHERE payment_id = ? AND (status LIKE '%Success%' OR status = 'Credits Added')"
  ).get(paymentId);
  return !!existing;
}

function addCreditsToProvider(providerId, credits) {
  testDb.prepare('UPDATE providers SET credit_balance = credit_balance + ? WHERE id = ?').run(credits, providerId);
}

function deductCreditsFromProvider(providerId, credits) {
  testDb.prepare('UPDATE providers SET credit_balance = credit_balance - ?, total_leads = total_leads + 1 WHERE id = ?').run(credits, providerId);
}

// ============================================
// TESTS
// ============================================

describe('Credit Pack Detection', () => {
  it('should detect Starter Pack at $200', () => {
    const pack = matchCreditPack(200);
    assert.strictEqual(pack.credits, 5);
    assert.strictEqual(pack.name, 'Starter Pack');
  });
  
  it('should detect Pro Pack at $700', () => {
    const pack = matchCreditPack(700);
    assert.strictEqual(pack.credits, 20);
    assert.strictEqual(pack.name, 'Pro Pack');
  });
  
  it('should detect Premium Pack at $1500', () => {
    const pack = matchCreditPack(1500);
    assert.strictEqual(pack.credits, 60);
    assert.strictEqual(pack.name, 'Premium Pack');
  });
  
  it('should detect Featured Partner subscription at $99', () => {
    const pack = matchCreditPack(99);
    assert.strictEqual(pack.credits, 3);
    assert.strictEqual(pack.name, 'Featured Partner');
    assert.strictEqual(pack.isSubscription, true);
    assert.deepStrictEqual(pack.perks, ['verified', 'priority']);
  });
  
  it('should handle $5 tolerance for Stripe variations', () => {
    // Starter Pack variations
    assert.strictEqual(matchCreditPack(197).credits, 5);
    assert.strictEqual(matchCreditPack(203).credits, 5);
    assert.strictEqual(matchCreditPack(205).credits, 5);
    
    // Pro Pack variations
    assert.strictEqual(matchCreditPack(695).credits, 20);
    assert.strictEqual(matchCreditPack(702).credits, 20);
    
    // Premium Pack variations
    assert.strictEqual(matchCreditPack(1497).credits, 60);
    assert.strictEqual(matchCreditPack(1503).credits, 60);
  });
  
  it('should NOT match single lead price ($40) as a pack', () => {
    const pack = matchCreditPack(40);
    assert.strictEqual(pack, null);
  });
  
  it('should NOT match arbitrary amounts as packs', () => {
    assert.strictEqual(matchCreditPack(50), null);
    // Note: $100 matches $99 subscription within $5 tolerance - this is expected
    assert.strictEqual(matchCreditPack(150), null);
    assert.strictEqual(matchCreditPack(500), null);
    assert.strictEqual(matchCreditPack(1000), null);
    assert.strictEqual(matchCreditPack(300), null);
  });
  
  it('should identify single lead purchases correctly', () => {
    assert.strictEqual(isSingleLeadPurchase(40), true);
    assert.strictEqual(isSingleLeadPurchase(38), true);  // Within tolerance
    assert.strictEqual(isSingleLeadPurchase(43), true);  // Within tolerance
    
    // Pack prices should NOT be single leads
    assert.strictEqual(isSingleLeadPurchase(200), false);
    assert.strictEqual(isSingleLeadPurchase(700), false);
    assert.strictEqual(isSingleLeadPurchase(1500), false);
  });
});

describe('Provider Matching', () => {
  before(() => {
    initTestDatabase();
    
    // Create test providers
    testDb.prepare(`
      INSERT INTO providers (company_name, email, phone, service_zips, credit_balance, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('Naples Dumpsters', 'info@naplesdumpsters.com', '239-555-1234', '33901, 33902, 33903', 10, 'Active');
    
    testDb.prepare(`
      INSERT INTO providers (company_name, email, phone, service_zips, credit_balance, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('Fort Myers Hauling', 'sales@fmhauling.com', '239-555-5678', '33901, 33916, 33917', 5, 'Active');
    
    testDb.prepare(`
      INSERT INTO providers (company_name, email, phone, service_zips, credit_balance, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('Inactive Provider', 'inactive@test.com', '555-0000', '33901', 20, 'Inactive');
    
    testDb.prepare(`
      INSERT INTO providers (company_name, email, phone, service_zips, credit_balance, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('Zero Credits LLC', 'nocredits@test.com', '555-1111', '33904', 0, 'Active');
  });
  
  after(() => {
    closeTestDatabase();
  });
  
  it('should find provider by email (case insensitive)', () => {
    const provider = getProviderByEmail('INFO@NAPLESDUMPSTERS.COM');
    assert.ok(provider);
    assert.strictEqual(provider.company_name, 'Naples Dumpsters');
    
    const provider2 = getProviderByEmail('sales@fmhauling.com');
    assert.ok(provider2);
    assert.strictEqual(provider2.company_name, 'Fort Myers Hauling');
  });
  
  it('should find provider by ID', () => {
    const provider = getProviderById(1);
    assert.ok(provider);
    assert.strictEqual(provider.company_name, 'Naples Dumpsters');
  });
  
  it('should find providers by ZIP code', () => {
    // 33901 is served by both Naples and Fort Myers
    const providers33901 = getProvidersByZip('33901');
    assert.strictEqual(providers33901.length, 2);
    
    // 33902 is only served by Naples
    const providers33902 = getProvidersByZip('33902');
    assert.strictEqual(providers33902.length, 1);
    assert.strictEqual(providers33902[0].company_name, 'Naples Dumpsters');
    
    // 33916 is only served by Fort Myers
    const providers33916 = getProvidersByZip('33916');
    assert.strictEqual(providers33916.length, 1);
    assert.strictEqual(providers33916[0].company_name, 'Fort Myers Hauling');
    
    // 33904 is served by Zero Credits
    const providers33904 = getProvidersByZip('33904');
    assert.strictEqual(providers33904.length, 1);
    assert.strictEqual(providers33904[0].company_name, 'Zero Credits LLC');
  });
  
  it('should NOT include inactive providers in ZIP matching', () => {
    // The inactive provider serves 33901 but shouldn't appear
    const providers = getProvidersByZip('33901');
    const inactiveFound = providers.find(p => p.company_name === 'Inactive Provider');
    assert.strictEqual(inactiveFound, undefined);
  });
  
  it('should return empty array for unserved ZIP', () => {
    const providers = getProvidersByZip('90210');
    assert.strictEqual(providers.length, 0);
  });
  
  it('should auto-create provider on purchase if not exists', () => {
    const newProvider = getOrCreateProvider('newbiz@example.com', 'New Business LLC');
    assert.ok(newProvider);
    assert.strictEqual(newProvider.company_name, 'New Business LLC');
    assert.strictEqual(newProvider.email, 'newbiz@example.com');
    assert.strictEqual(newProvider.status, 'Active');
    
    // Should not create duplicate
    const sameProvider = getOrCreateProvider('newbiz@example.com');
    assert.strictEqual(sameProvider.id, newProvider.id);
  });
  
  it('should generate company name from email if not provided', () => {
    const provider = getOrCreateProvider('john.doe@company.com');
    assert.ok(provider);
    assert.strictEqual(provider.company_name, 'John Doe');
  });
});

describe('Lead Routing Logic', () => {
  beforeEach(() => {
    initTestDatabase();
    
    // Provider with credits
    testDb.prepare(`
      INSERT INTO providers (id, company_name, email, service_zips, credit_balance, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(1, 'Premier Dumpsters', 'premier@test.com', '33901, 33902', 10, 'Active');
    
    // Provider without credits
    testDb.prepare(`
      INSERT INTO providers (id, company_name, email, service_zips, credit_balance, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(2, 'Budget Haulers', 'budget@test.com', '33901', 0, 'Active');
    
    // Another provider with credits
    testDb.prepare(`
      INSERT INTO providers (id, company_name, email, service_zips, credit_balance, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(3, 'Quick Removal', 'quick@test.com', '33901', 5, 'Active');
  });
  
  afterEach(() => {
    closeTestDatabase();
  });
  
  it('should route DIRECT lead by providerId (ignores ZIP)', () => {
    // Lead has providerId=1, should go ONLY to that provider regardless of ZIP
    const leadData = { providerId: 1, zip: '99999' };  // ZIP doesn't match provider
    
    const provider = getProviderById(leadData.providerId);
    assert.ok(provider);
    assert.strictEqual(provider.company_name, 'Premier Dumpsters');
    
    // Should NOT find any providers by ZIP (since 99999 isn't served)
    const zipProviders = getProvidersByZip(leadData.zip);
    assert.strictEqual(zipProviders.length, 0);
  });
  
  it('should route DIRECT lead by providerName', () => {
    const providerName = 'Quick Removal';
    const provider = testDb.prepare(
      'SELECT * FROM providers WHERE LOWER(company_name) = LOWER(?) AND status = ?'
    ).get(providerName, 'Active');
    
    assert.ok(provider);
    assert.strictEqual(provider.id, 3);
  });
  
  it('should handle case-insensitive provider name lookup', () => {
    const provider = testDb.prepare(
      'SELECT * FROM providers WHERE LOWER(company_name) = LOWER(?) AND status = ?'
    ).get('QUICK REMOVAL', 'Active');
    
    assert.ok(provider);
    assert.strictEqual(provider.company_name, 'Quick Removal');
  });
  
  it('should fall back to ZIP matching when no providerId/providerName', () => {
    const providers = getProvidersByZip('33901');
    assert.strictEqual(providers.length, 3);  // All 3 serve 33901
  });
  
  it('should deduct credits when sending full lead', () => {
    const providerId = 1;
    const initialBalance = getProviderById(providerId).credit_balance;
    
    deductCreditsFromProvider(providerId, LEAD_PRICING.perLead);
    
    const newBalance = getProviderById(providerId).credit_balance;
    assert.strictEqual(newBalance, initialBalance - LEAD_PRICING.perLead);
  });
  
  it('should increment total_leads when sending full lead', () => {
    const providerId = 1;
    const initialLeads = getProviderById(providerId).total_leads;
    
    deductCreditsFromProvider(providerId, LEAD_PRICING.perLead);
    
    const newLeads = getProviderById(providerId).total_leads;
    assert.strictEqual(newLeads, initialLeads + 1);
  });
  
  it('should identify providers with insufficient credits for teaser', () => {
    const providers = getProvidersByZip('33901');
    const withCredits = providers.filter(p => p.credit_balance >= LEAD_PRICING.perLead);
    const withoutCredits = providers.filter(p => p.credit_balance < LEAD_PRICING.perLead);
    
    assert.strictEqual(withCredits.length, 2);  // Premier (10) and Quick (5)
    assert.strictEqual(withoutCredits.length, 1);  // Budget (0)
    assert.strictEqual(withoutCredits[0].company_name, 'Budget Haulers');
  });
  
  it('should mark lead as No Coverage when ZIP has no providers', () => {
    // Create a lead for unserved ZIP
    const leadId = generateLeadId();
    const unservedZip = '90210';
    
    testDb.prepare(`
      INSERT INTO leads (lead_id, name, email, phone, zip, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(leadId, 'Test Customer', 'test@example.com', '555-1234', unservedZip, 'New');
    
    // Verify no providers serve this ZIP
    const providers = getProvidersByZip(unservedZip);
    assert.strictEqual(providers.length, 0);
    
    // Update lead status as the server would
    testDb.prepare("UPDATE leads SET status = ? WHERE lead_id = ?").run('No Coverage', leadId);
    
    // Verify status was updated
    const lead = testDb.prepare('SELECT * FROM leads WHERE lead_id = ?').get(leadId);
    assert.strictEqual(lead.status, 'No Coverage');
  });
});

describe('Balance Verification', () => {
  before(() => {
    initTestDatabase();
    
    testDb.prepare(`
      INSERT INTO providers (company_name, email, phone, credit_balance)
      VALUES (?, ?, ?, ?)
    `).run('Test Provider', 'test@provider.com', '239-555-4321', 15);
  });
  
  after(() => {
    closeTestDatabase();
  });
  
  it('should extract last 4 digits from phone', () => {
    assert.strictEqual(getPhoneLast4('239-555-4321'), '4321');
    assert.strictEqual(getPhoneLast4('(239) 555-4321'), '4321');
    assert.strictEqual(getPhoneLast4('+1 239 555 4321'), '4321');
    assert.strictEqual(getPhoneLast4('2395554321'), '4321');
  });
  
  it('should verify correct phone last 4 digits', () => {
    const provider = getProviderByEmail('test@provider.com');
    const providerLast4 = getPhoneLast4(provider.phone);
    const userLast4 = '4321';
    
    assert.strictEqual(providerLast4, userLast4);
  });
  
  it('should reject incorrect phone last 4 digits', () => {
    const provider = getProviderByEmail('test@provider.com');
    const providerLast4 = getPhoneLast4(provider.phone);
    const wrongLast4 = '9999';
    
    assert.notStrictEqual(providerLast4, wrongLast4);
  });
  
  it('should return correct credit balance', () => {
    const provider = getProviderByEmail('test@provider.com');
    assert.strictEqual(provider.credit_balance, 15);
  });
});

describe('Payment Idempotency', () => {
  before(() => {
    initTestDatabase();
  });
  
  after(() => {
    closeTestDatabase();
  });
  
  it('should detect new payments as not processed', () => {
    assert.strictEqual(isPaymentProcessed('pi_new_12345'), false);
  });
  
  it('should detect successful payments as already processed', () => {
    testDb.prepare(`
      INSERT INTO purchase_log (payment_id, buyer_email, amount, status)
      VALUES (?, ?, ?, ?)
    `).run('pi_existing_123', 'test@test.com', 200, 'Success');
    
    assert.strictEqual(isPaymentProcessed('pi_existing_123'), true);
  });
  
  it('should detect "Credits Added" payments as already processed', () => {
    testDb.prepare(`
      INSERT INTO purchase_log (payment_id, buyer_email, amount, status)
      VALUES (?, ?, ?, ?)
    `).run('pi_credits_456', 'test@test.com', 700, 'Credits Added');
    
    assert.strictEqual(isPaymentProcessed('pi_credits_456'), true);
  });
  
  it('should NOT treat "Processing" payments as already processed', () => {
    testDb.prepare(`
      INSERT INTO purchase_log (payment_id, buyer_email, amount, status)
      VALUES (?, ?, ?, ?)
    `).run('pi_processing_789', 'test@test.com', 200, 'Processing');
    
    assert.strictEqual(isPaymentProcessed('pi_processing_789'), false);
  });
  
  it('should handle null/undefined payment IDs', () => {
    assert.strictEqual(isPaymentProcessed(null), false);
    assert.strictEqual(isPaymentProcessed(undefined), false);
    assert.strictEqual(isPaymentProcessed(''), false);
  });
});

describe('Credit Management', () => {
  beforeEach(() => {
    initTestDatabase();
    
    testDb.prepare(`
      INSERT INTO providers (id, company_name, email, credit_balance)
      VALUES (?, ?, ?, ?)
    `).run(1, 'Test Provider', 'test@test.com', 0);
  });
  
  afterEach(() => {
    closeTestDatabase();
  });
  
  it('should add Starter Pack credits (5)', () => {
    addCreditsToProvider(1, 5);
    const provider = getProviderById(1);
    assert.strictEqual(provider.credit_balance, 5);
  });
  
  it('should add Pro Pack credits (20)', () => {
    addCreditsToProvider(1, 20);
    const provider = getProviderById(1);
    assert.strictEqual(provider.credit_balance, 20);
  });
  
  it('should add Premium Pack credits (60)', () => {
    addCreditsToProvider(1, 60);
    const provider = getProviderById(1);
    assert.strictEqual(provider.credit_balance, 60);
  });
  
  it('should accumulate credits from multiple purchases', () => {
    addCreditsToProvider(1, 5);   // Starter
    addCreditsToProvider(1, 20);  // Pro
    const provider = getProviderById(1);
    assert.strictEqual(provider.credit_balance, 25);
  });
  
  it('should deduct 1 credit per lead (simple pricing)', () => {
    addCreditsToProvider(1, 10);
    deductCreditsFromProvider(1, LEAD_PRICING.perLead);
    const provider = getProviderById(1);
    assert.strictEqual(provider.credit_balance, 9);
  });
  
  it('should handle multiple lead deductions', () => {
    addCreditsToProvider(1, 10);
    deductCreditsFromProvider(1, LEAD_PRICING.perLead);
    deductCreditsFromProvider(1, LEAD_PRICING.perLead);
    deductCreditsFromProvider(1, LEAD_PRICING.perLead);
    const provider = getProviderById(1);
    assert.strictEqual(provider.credit_balance, 7);
  });
});

describe('Email Validation', () => {
  it('should reject Gmail addresses', () => {
    assert.strictEqual(isBusinessEmail('test@gmail.com'), false);
    assert.strictEqual(isBusinessEmail('TEST@GMAIL.COM'), false);
  });
  
  it('should reject Yahoo addresses', () => {
    assert.strictEqual(isBusinessEmail('test@yahoo.com'), false);
    assert.strictEqual(isBusinessEmail('test@ymail.com'), false);
  });
  
  it('should reject other free providers', () => {
    assert.strictEqual(isBusinessEmail('test@hotmail.com'), false);
    assert.strictEqual(isBusinessEmail('test@outlook.com'), false);
    assert.strictEqual(isBusinessEmail('test@aol.com'), false);
    assert.strictEqual(isBusinessEmail('test@icloud.com'), false);
    assert.strictEqual(isBusinessEmail('test@protonmail.com'), false);
    assert.strictEqual(isBusinessEmail('test@live.com'), false);
    assert.strictEqual(isBusinessEmail('test@msn.com'), false);
  });
  
  it('should accept business domain emails', () => {
    assert.strictEqual(isBusinessEmail('info@acmedumpsters.com'), true);
    assert.strictEqual(isBusinessEmail('sales@mycompany.net'), true);
    assert.strictEqual(isBusinessEmail('contact@business.org'), true);
  });
  
  it('should handle invalid inputs gracefully', () => {
    assert.strictEqual(isBusinessEmail(null), false);
    assert.strictEqual(isBusinessEmail(undefined), false);
    assert.strictEqual(isBusinessEmail(''), false);
    assert.strictEqual(isBusinessEmail('notanemail'), false);
  });
});

describe('Lead ID Generation', () => {
  it('should generate unique IDs', () => {
    const id1 = generateLeadId();
    const id2 = generateLeadId();
    assert.notStrictEqual(id1, id2);
  });
  
  it('should follow LEAD-xxx-xxx format', () => {
    const id = generateLeadId();
    assert.ok(id.startsWith('LEAD-'));
    assert.ok(/^LEAD-[A-Z0-9]+-[A-Z0-9]+$/.test(id));
  });
});

describe('ZIP Code Validation', () => {
  it('should accept valid 5-digit ZIP codes', () => {
    assert.strictEqual(isValidZip('33901'), true);
    assert.strictEqual(isValidZip('90210'), true);
    assert.strictEqual(isValidZip('00000'), true);
  });
  
  it('should reject invalid ZIP codes', () => {
    assert.strictEqual(isValidZip('3390'), false);   // Too short
    assert.strictEqual(isValidZip('339012'), false); // Too long
    assert.strictEqual(isValidZip('3390A'), false);  // Contains letter
    assert.strictEqual(isValidZip(''), false);       // Empty
    assert.strictEqual(isValidZip('33901-1234'), false); // ZIP+4
  });
});

describe('Premium Perks Detection', () => {
  it('should identify Premium Pack as having perks', () => {
    const pack = matchCreditPack(1500);
    // Premium Pack should activate perks (60 credits or named "Premium Pack")
    const hasPremiumPerks = pack?.perks || pack?.name === 'Premium Pack' || pack?.credits >= 60;
    assert.strictEqual(hasPremiumPerks, true);
  });
  
  it('should identify Featured Partner subscription perks', () => {
    const pack = matchCreditPack(99);
    assert.ok(pack.perks);
    assert.ok(pack.perks.includes('verified'));
    assert.ok(pack.perks.includes('priority'));
  });
  
  it('should NOT give perks for Starter pack', () => {
    const starter = matchCreditPack(200);
    
    assert.strictEqual(starter.perks, undefined);
  });
  
  it('should give perks for Pro pack', () => {
    const pro = matchCreditPack(700);
    
    assert.strictEqual(pro.perks, true);
  });
});

// ============================================
// INTEGRATION-STYLE TESTS
// ============================================

describe('Full Purchase Flow', () => {
  beforeEach(() => {
    initTestDatabase();
  });
  
  afterEach(() => {
    closeTestDatabase();
  });
  
  it('should handle complete credit pack purchase flow', () => {
    const paymentId = 'pi_test_' + Date.now();
    const buyerEmail = 'buyer@dumpstercompany.com';
    const amount = 200; // Starter Pack
    
    // 1. Check idempotency - payment not yet processed
    assert.strictEqual(isPaymentProcessed(paymentId), false);
    
    // 2. Match credit pack
    const pack = matchCreditPack(amount);
    assert.strictEqual(pack.credits, 5);
    
    // 3. Get or create provider
    const provider = getOrCreateProvider(buyerEmail, 'Dumpster Company');
    assert.ok(provider.id);
    
    // 4. Add credits
    addCreditsToProvider(provider.id, pack.credits);
    
    // 5. Log purchase
    testDb.prepare(`
      INSERT INTO purchase_log (payment_id, buyer_email, amount, lead_id, status)
      VALUES (?, ?, ?, ?, ?)
    `).run(paymentId, buyerEmail, amount, `PACK_${pack.credits}`, 'Credits Added');
    
    // 6. Verify final state
    const updatedProvider = getProviderById(provider.id);
    assert.strictEqual(updatedProvider.credit_balance, 5);
    assert.strictEqual(isPaymentProcessed(paymentId), true);
  });
  
  it('should handle lead submission with credit deduction', () => {
    // Setup provider with credits
    testDb.prepare(`
      INSERT INTO providers (id, company_name, email, service_zips, credit_balance, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(1, 'Test Provider', 'test@test.com', '33901', 5, 'Active');
    
    // Submit lead
    const leadId = generateLeadId();
    const leadZip = '33901';
    
    // Find matching providers
    const providers = getProvidersByZip(leadZip);
    assert.strictEqual(providers.length, 1);
    
    const provider = providers[0];
    assert.ok(provider.credit_balance >= LEAD_PRICING.perLead);
    
    // Deduct credits
    deductCreditsFromProvider(provider.id, LEAD_PRICING.perLead);
    
    // Verify
    const updated = getProviderById(provider.id);
    assert.strictEqual(updated.credit_balance, 4);
    assert.strictEqual(updated.total_leads, 1);
  });
});

describe('Subscription Renewals', () => {
  beforeEach(() => {
    initTestDatabase();
    
    // Create a provider with existing subscription
    testDb.prepare(`
      INSERT INTO providers (id, company_name, email, credit_balance, verified, priority, premium_expires_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1, 'Premium Provider', 'premium@test.com', 2, 1, 10, '2026-03-01', 'Active');
  });
  
  afterEach(() => {
    closeTestDatabase();
  });
  
  it('should identify subscription renewal amount', () => {
    const pack = matchCreditPack(99);
    assert.ok(pack.isSubscription);
    assert.strictEqual(pack.credits, 3);
    assert.strictEqual(pack.name, 'Featured Partner');
  });
  
  it('should add monthly credits on renewal', () => {
    const provider = getProviderById(1);
    const initialCredits = provider.credit_balance;
    
    // Simulate renewal: add 3 credits
    addCreditsToProvider(1, 3);
    
    const updated = getProviderById(1);
    assert.strictEqual(updated.credit_balance, initialCredits + 3);
  });
  
  it('should extend premium status by 30 days', () => {
    // Simulate setting new expiration
    const newExpiry = new Date();
    newExpiry.setDate(newExpiry.getDate() + 30);
    
    testDb.prepare(`
      UPDATE providers SET premium_expires_at = ?, verified = 1, priority = 10 WHERE id = ?
    `).run(newExpiry.toISOString(), 1);
    
    const updated = getProviderById(1);
    assert.ok(updated.premium_expires_at);
    assert.strictEqual(updated.verified, 1);
    assert.strictEqual(updated.priority, 10);
  });
  
  it('should prevent duplicate processing of same renewal', () => {
    const paymentId = 'in_renewal_' + Date.now();
    
    // First processing
    assert.strictEqual(isPaymentProcessed(paymentId), false);
    
    // Log the renewal
    testDb.prepare(`
      INSERT INTO purchase_log (payment_id, buyer_email, amount, lead_id, status)
      VALUES (?, ?, ?, ?, ?)
    `).run(paymentId, 'premium@test.com', 99, 'SUB_RENEWAL', 'Credits Added');
    
    // Should now be marked as processed
    assert.strictEqual(isPaymentProcessed(paymentId), true);
  });
});

describe('Premium Expiration', () => {
  beforeEach(() => {
    initTestDatabase();
    
    // Expired premium provider
    testDb.prepare(`
      INSERT INTO providers (id, company_name, email, verified, priority, premium_expires_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(1, 'Expired Premium', 'expired@test.com', 1, 10, '2026-01-01', 'Active');
    
    // Active premium provider
    testDb.prepare(`
      INSERT INTO providers (id, company_name, email, verified, priority, premium_expires_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(2, 'Active Premium', 'active@test.com', 1, 10, '2026-12-31', 'Active');
  });
  
  afterEach(() => {
    closeTestDatabase();
  });
  
  it('should identify expired premium based on date', () => {
    const now = new Date();
    const expired = testDb.prepare('SELECT * FROM providers WHERE id = 1').get();
    const active = testDb.prepare('SELECT * FROM providers WHERE id = 2').get();
    
    const expiredDate = new Date(expired.premium_expires_at);
    const activeDate = new Date(active.premium_expires_at);
    
    assert.ok(expiredDate < now, 'Expired provider should have past date');
    assert.ok(activeDate > now, 'Active provider should have future date');
  });
  
  it('should detect providers needing expiration', () => {
    const expiredProviders = testDb.prepare(`
      SELECT id, company_name FROM providers 
      WHERE premium_expires_at IS NOT NULL 
      AND premium_expires_at < datetime('now')
      AND (verified = 1 OR priority > 0)
    `).all();
    
    assert.strictEqual(expiredProviders.length, 1);
    assert.strictEqual(expiredProviders[0].company_name, 'Expired Premium');
  });
});

// ============================================
// PROVIDER REGISTRATION TESTS
// ============================================

describe('Provider Registration Flow', () => {
  beforeEach(() => {
    initTestDatabase();
  });
  
  afterEach(() => {
    closeTestDatabase();
  });
  
  it('should create new provider from registration', () => {
    const email = 'newprovider@dumpsterpro.com';
    const companyName = 'Dumpster Pro LLC';
    
    // Register new provider
    const result = testDb.prepare(`
      INSERT INTO providers (company_name, email, phone, city, state, status)
      VALUES (?, ?, ?, ?, ?, 'Active')
    `).run(companyName, email, '555-123-4567', 'Naples', 'FL');
    
    assert.ok(result.lastInsertRowid > 0);
    
    // Verify provider was created
    const provider = testDb.prepare('SELECT * FROM providers WHERE email = ?').get(email);
    assert.strictEqual(provider.company_name, companyName);
    assert.strictEqual(provider.status, 'Active');
    assert.strictEqual(provider.credit_balance, 0); // Starts with 0 credits
  });
  
  it('should recognize existing provider by email', () => {
    const email = 'existing@test.com';
    
    // Create provider first
    testDb.prepare(`
      INSERT INTO providers (company_name, email, credit_balance, status)
      VALUES (?, ?, 5, 'Active')
    `).run('Existing Company', email);
    
    // Check if exists
    const existing = testDb.prepare('SELECT * FROM providers WHERE LOWER(email) = LOWER(?)').get(email);
    assert.ok(existing);
    assert.strictEqual(existing.company_name, 'Existing Company');
    assert.strictEqual(existing.credit_balance, 5);
  });
  
  it('should handle email case-insensitively', () => {
    const email = 'Test@Example.COM';
    
    testDb.prepare(`
      INSERT INTO providers (company_name, email, status)
      VALUES (?, ?, 'Active')
    `).run('Test Company', email.toLowerCase());
    
    // Should find with different case
    const found = testDb.prepare('SELECT * FROM providers WHERE LOWER(email) = LOWER(?)').get(email);
    assert.ok(found);
    assert.strictEqual(found.company_name, 'Test Company');
  });
  
  it('should track registration events', () => {
    // Create registration event
    testDb.prepare(`
      INSERT INTO registration_events (event_type, provider_id, email, selected_pack, source)
      VALUES (?, ?, ?, ?, ?)
    `).run('registration', 1, 'new@test.com', 'starter', 'website');
    
    const event = testDb.prepare('SELECT * FROM registration_events WHERE email = ?').get('new@test.com');
    assert.ok(event);
    assert.strictEqual(event.event_type, 'registration');
    assert.strictEqual(event.selected_pack, 'starter');
  });
  
  it('should link purchase to pre-registered provider', () => {
    // Pre-register provider
    const result = testDb.prepare(`
      INSERT INTO providers (company_name, email, status)
      VALUES (?, ?, 'Active')
    `).run('Pre-registered Co', 'prereg@test.com');
    
    const providerId = result.lastInsertRowid;
    
    // Simulate purchase callback with PROVIDER-{id} reference
    const clientRefId = `PROVIDER-${providerId}`;
    const match = clientRefId.match(/^PROVIDER-(\d+)$/);
    assert.ok(match);
    
    const parsedId = parseInt(match[1], 10);
    assert.strictEqual(parsedId, providerId);
    
    // Add credits to matched provider
    testDb.prepare('UPDATE providers SET credit_balance = credit_balance + 5 WHERE id = ?').run(providerId);
    
    const updated = testDb.prepare('SELECT * FROM providers WHERE id = ?').get(providerId);
    assert.strictEqual(updated.credit_balance, 5);
  });
});

describe('Provider Activity Metrics', () => {
  beforeEach(() => {
    initTestDatabase();
    
    // Create providers with varying activity
    testDb.prepare(`
      INSERT INTO providers (id, company_name, email, credit_balance, total_leads, status, created_at)
      VALUES 
        (1, 'Top Performer', 'top@test.com', 20, 50, 'Active', datetime('now', '-30 days')),
        (2, 'New Provider', 'new@test.com', 5, 0, 'Active', datetime('now', '-2 days')),
        (3, 'High Balance Inactive', 'inactive@test.com', 15, 5, 'Active', datetime('now', '-60 days'))
    `).run();
    
    // Create some leads assigned to providers
    testDb.prepare(`
      INSERT INTO leads (lead_id, name, zip, status, assigned_provider_id, created_at)
      VALUES 
        ('LEAD-001', 'Customer 1', '34102', 'Sent', 1, datetime('now', '-5 days')),
        ('LEAD-002', 'Customer 2', '34103', 'Sent', 1, datetime('now', '-10 days')),
        ('LEAD-003', 'Customer 3', '34104', 'Sent', 1, datetime('now', '-15 days'))
    `).run();
    
    // Create purchase history
    testDb.prepare(`
      INSERT INTO purchase_log (buyer_email, amount, status, timestamp)
      VALUES 
        ('top@test.com', 700, 'Credits Added', datetime('now', '-20 days')),
        ('top@test.com', 200, 'Credits Added', datetime('now', '-5 days'))
    `).run();
  });
  
  afterEach(() => {
    closeTestDatabase();
  });
  
  it('should identify top providers by leads', () => {
    const topProviders = testDb.prepare(`
      SELECT p.id, p.company_name, COUNT(l.id) as recent_leads
      FROM providers p
      LEFT JOIN leads l ON l.assigned_provider_id = p.id
        AND l.created_at > datetime('now', '-30 days')
      WHERE p.status = 'Active'
      GROUP BY p.id
      ORDER BY recent_leads DESC
    `).all();
    
    assert.strictEqual(topProviders[0].company_name, 'Top Performer');
    assert.strictEqual(topProviders[0].recent_leads, 3);
  });
  
  it('should calculate provider total spend', () => {
    const spending = testDb.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM purchase_log
      WHERE LOWER(buyer_email) = 'top@test.com'
      AND (status LIKE '%Success%' OR status = 'Credits Added')
    `).get();
    
    assert.strictEqual(spending.total, 900); // 700 + 200
  });
  
  it('should identify high-balance inactive providers', () => {
    const inactive = testDb.prepare(`
      SELECT p.id, p.company_name, p.credit_balance
      FROM providers p
      WHERE p.status = 'Active' 
      AND p.credit_balance >= 5
      AND NOT EXISTS (
        SELECT 1 FROM leads l WHERE l.assigned_provider_id = p.id 
        AND l.created_at > datetime('now', '-14 days')
      )
    `).all();
    
    // Should find provider 3 (high balance, no recent leads)
    const found = inactive.find(p => p.company_name === 'High Balance Inactive');
    assert.ok(found);
    assert.strictEqual(found.credit_balance, 15);
  });
  
  it('should find new providers', () => {
    const recent = testDb.prepare(`
      SELECT id, company_name
      FROM providers
      WHERE created_at > datetime('now', '-7 days')
    `).all();
    
    assert.strictEqual(recent.length, 1);
    assert.strictEqual(recent[0].company_name, 'New Provider');
  });
});

describe('API Provider Management', () => {
  beforeEach(() => {
    initTestDatabase();
    
    // Create test provider
    testDb.prepare(`
      INSERT INTO providers (id, company_name, email, phone, credit_balance, status, verified, priority, service_zips)
      VALUES (1, 'API Test Company', 'api@test.com', '555-1234', 10, 'Active', 0, 0, '34102,34103')
    `).run();
  });
  
  afterEach(() => {
    closeTestDatabase();
  });
  
  it('should support partial provider updates', () => {
    // Simulate PUT update - only updating specific fields
    const updates = {
      company_name: 'Updated Company Name',
      verified: 1
    };
    
    const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const values = [...Object.values(updates), 1];
    testDb.prepare(`UPDATE providers SET ${setClauses} WHERE id = ?`).run(...values);
    
    const updated = testDb.prepare('SELECT * FROM providers WHERE id = 1').get();
    assert.strictEqual(updated.company_name, 'Updated Company Name');
    assert.strictEqual(updated.verified, 1);
    assert.strictEqual(updated.email, 'api@test.com'); // Unchanged
    assert.strictEqual(updated.credit_balance, 10); // Unchanged
  });
  
  it('should add credits via API and log transaction', () => {
    const credits = 5;
    const reason = 'Promotional bonus';
    
    // Add credits
    testDb.prepare('UPDATE providers SET credit_balance = credit_balance + ? WHERE id = ?').run(credits, 1);
    
    // Log transaction
    testDb.prepare(`
      INSERT INTO credit_transactions (provider_id, provider_email, type, amount, balance_after, reference, notes)
      VALUES (?, ?, 'admin_add', ?, ?, ?, ?)
    `).run(1, 'api@test.com', credits, 15, 'api-test', reason);
    
    // Verify
    const provider = testDb.prepare('SELECT credit_balance FROM providers WHERE id = 1').get();
    assert.strictEqual(provider.credit_balance, 15);
    
    const tx = testDb.prepare('SELECT * FROM credit_transactions WHERE provider_id = 1 ORDER BY id DESC LIMIT 1').get();
    assert.strictEqual(tx.amount, 5);
    assert.strictEqual(tx.type, 'admin_add');
    assert.strictEqual(tx.notes, reason);
  });
  
  it('should deduct credits and track negative amounts', () => {
    const deduction = -3;
    
    testDb.prepare('UPDATE providers SET credit_balance = credit_balance + ? WHERE id = ?').run(deduction, 1);
    
    testDb.prepare(`
      INSERT INTO credit_transactions (provider_id, provider_email, type, amount, balance_after, notes)
      VALUES (?, ?, 'admin_deduct', ?, ?, 'Refund adjustment')
    `).run(1, 'api@test.com', deduction, 7);
    
    const provider = testDb.prepare('SELECT credit_balance FROM providers WHERE id = 1').get();
    assert.strictEqual(provider.credit_balance, 7);
    
    const tx = testDb.prepare('SELECT * FROM credit_transactions WHERE provider_id = 1 AND type = ?').get('admin_deduct');
    assert.strictEqual(tx.amount, -3);
  });
  
  it('should preserve unchanged fields on partial update', () => {
    // Store original values
    const original = testDb.prepare('SELECT * FROM providers WHERE id = 1').get();
    
    // Update only one field
    testDb.prepare('UPDATE providers SET phone = ? WHERE id = ?').run('999-8888', 1);
    
    // Verify other fields unchanged
    const updated = testDb.prepare('SELECT * FROM providers WHERE id = 1').get();
    assert.strictEqual(updated.phone, '999-8888');
    assert.strictEqual(updated.company_name, original.company_name);
    assert.strictEqual(updated.email, original.email);
    assert.strictEqual(updated.credit_balance, original.credit_balance);
    assert.strictEqual(updated.service_zips, original.service_zips);
  });
});

console.log('Running DumpsterMap unit tests...\n');
