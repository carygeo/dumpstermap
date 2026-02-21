/**
 * DumpsterMap - Google Apps Script Backend
 * 
 * Handles:
 * 1. Lead form submissions
 * 2. Lead matching to providers by zip code
 * 3. Email notifications with Stripe payment links
 * 4. Balance checking for providers
 */

// ============================================
// CONFIGURATION
// ============================================
const SHEET_ID = '1qDB9c4GndAzLEvJvl8_XsYER02AFlLvw8YpFZat59Dw';
const NOTIFICATION_EMAIL = 'admin@dumpstermap.io';
const SINGLE_LEAD_PRICE = 40;
const SINGLE_LEAD_STRIPE_LINK = 'https://buy.stripe.com/cNidR9aQ76T46IF78j5Rm04';

// Blocked email domains (free email providers) - for provider signup
const BLOCKED_DOMAINS = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com', 'mail.com', 'protonmail.com'];

// ============================================
// MAIN HANDLERS
// ============================================

/**
 * Handle GET requests - balance check, status, and payment processing
 */
function doGet(e) {
  const action = e.parameter.action;
  const email = e.parameter.email;
  
  if (action === 'balance' && email) {
    const phone = e.parameter.phone || '';
    return checkBalance(email, phone);
  }
  
  // Process payment (called from Fly.dev webhook handler)
  if (action === 'process_payment') {
    const leadId = e.parameter.leadId;
    const buyerEmail = e.parameter.email;
    const amount = parseFloat(e.parameter.amount) || 0;
    const paymentId = e.parameter.paymentId || '';
    
    return processPaymentWebhook(leadId, buyerEmail, amount, paymentId);
  }
  
  return ContentService.createTextOutput(JSON.stringify({
    status: 'ok',
    message: 'DumpsterMap API is running',
    timestamp: new Date().toISOString()
  })).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Process payment from webhook (called via GET from Fly.dev)
 */
function processPaymentWebhook(leadId, buyerEmail, amount, paymentId) {
  // Verify we have required data
  if (!leadId) {
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error',
      message: 'No lead ID provided'
    })).setMimeType(ContentService.MimeType.JSON);
  }
  
  // Verify amount is ~$40
  if (amount < 39 || amount > 41) {
    sendAdminAlert('WRONG PAYMENT AMOUNT', `Lead ${leadId} - Amount: $${amount}, expected $${SINGLE_LEAD_PRICE}. Buyer: ${buyerEmail}`);
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error',
      message: 'Invalid payment amount'
    })).setMimeType(ContentService.MimeType.JSON);
  }
  
  // Log the purchase attempt
  logPurchaseAttempt(leadId, buyerEmail, amount, paymentId);
  
  // Get lead details from sheet
  const lead = getLeadById(leadId);
  if (!lead) {
    sendAdminAlert('LEAD NOT FOUND', `Payment received but lead ${leadId} not found. Buyer: ${buyerEmail}, Amount: $${amount}`);
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error',
      message: 'Lead not found'
    })).setMimeType(ContentService.MimeType.JSON);
  }
  
  // Send full lead details to purchaser
  let emailSent = false;
  let emailError = null;
  
  try {
    sendPurchasedLeadEmail(buyerEmail, lead, leadId);
    emailSent = true;
  } catch (error) {
    emailError = error.toString();
    logError('sendPurchasedLeadEmail', error);
  }
  
  // Update lead status in sheet
  updateLeadPurchaseStatus(leadId, buyerEmail, amount, paymentId, emailSent);
  
  // Send admin notification
  sendPurchaseNotification(leadId, lead, buyerEmail, amount, emailSent, emailError);
  
  if (!emailSent) {
    return ContentService.createTextOutput(JSON.stringify({
      status: 'partial',
      message: 'Payment recorded but email failed - admin notified',
      leadId: leadId
    })).setMimeType(ContentService.MimeType.JSON);
  }
  
  return ContentService.createTextOutput(JSON.stringify({
    status: 'ok',
    message: 'Lead delivered successfully',
    leadId: leadId,
    emailSent: true
  })).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Handle POST requests (lead submissions & Stripe webhooks)
 */
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    
    // Lead form submission
    if (data.type === 'lead') {
      return handleLeadSubmission(data);
    }
    
    // Stripe webhook - full event with data.object
    if (data.type === 'checkout.session.completed' && data.data && data.data.object) {
      return handleStripeWebhook(data.data.object);
    }
    
    // Direct session object (object === checkout.session)
    if (data.object === 'checkout.session') {
      return handleStripeWebhook(data);
    }
    
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error',
      message: 'Unknown request type'
    })).setMimeType(ContentService.MimeType.JSON);
    
  } catch (error) {
    console.error('doPost error:', error);
    // Log error for debugging
    logError('doPost', error);
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error',
      message: error.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

// ============================================
// STRIPE WEBHOOK HANDLING
// ============================================

/**
 * Handle Stripe checkout.session.completed webhook
 */
function handleStripeWebhook(session) {
  const leadId = session.client_reference_id;
  const customerEmail = session.customer_details?.email || session.customer_email;
  const amountPaid = session.amount_total ? (session.amount_total / 100) : 0;
  const paymentId = session.payment_intent || session.id;
  const paymentStatus = session.payment_status;
  const mode = session.mode; // 'payment' for one-time, 'subscription' for recurring
  
  // ============================================
  // PAYMENT VERIFICATION
  // ============================================
  
  // 1. Verify payment status is complete
  if (paymentStatus !== 'paid') {
    logError('handleStripeWebhook', `Payment not completed. Status: ${paymentStatus}`);
    sendAdminAlert('PAYMENT NOT COMPLETE', `Lead ${leadId} - Payment status: ${paymentStatus}, not processing.`);
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error',
      message: 'Payment not completed'
    })).setMimeType(ContentService.MimeType.JSON);
  }
  
  // 2. Verify it's a one-time payment (not subscription)
  if (mode !== 'payment') {
    logError('handleStripeWebhook', `Not a one-time payment. Mode: ${mode}`);
    sendAdminAlert('WRONG PAYMENT TYPE', `Lead ${leadId} - Mode: ${mode}, expected 'payment'. Buyer: ${customerEmail}`);
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error',
      message: 'Invalid payment type'
    })).setMimeType(ContentService.MimeType.JSON);
  }
  
  // 3. Verify amount is $40 (allow small variance for currency conversion)
  if (amountPaid < 39 || amountPaid > 41) {
    logError('handleStripeWebhook', `Wrong amount: $${amountPaid}, expected $${SINGLE_LEAD_PRICE}`);
    sendAdminAlert('WRONG PAYMENT AMOUNT', `Lead ${leadId} - Amount: $${amountPaid}, expected $${SINGLE_LEAD_PRICE}. Buyer: ${customerEmail}. NOT delivering lead automatically.`);
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error',
      message: 'Invalid payment amount'
    })).setMimeType(ContentService.MimeType.JSON);
  }
  
  // 4. Verify we have a lead ID
  if (!leadId) {
    logError('handleStripeWebhook', 'No client_reference_id in session');
    sendAdminAlert('NO LEAD ID', `Payment received ($${amountPaid}) but no lead ID. Buyer: ${customerEmail}, Payment: ${paymentId}`);
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error',
      message: 'No lead ID found'
    })).setMimeType(ContentService.MimeType.JSON);
  }
  
  // ============================================
  // VERIFICATION PASSED - Process the lead
  // ============================================
  
  // Log the purchase attempt
  logPurchaseAttempt(leadId, customerEmail, amountPaid, paymentId);
  
  // Get lead details from sheet
  const lead = getLeadById(leadId);
  if (!lead) {
    const error = `Lead ${leadId} not found in sheet`;
    logError('handleStripeWebhook', error);
    sendAdminAlert('PAYMENT ERROR', `Payment received but ${error}. Customer: ${customerEmail}, Amount: $${amountPaid}`);
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error',
      message: error
    })).setMimeType(ContentService.MimeType.JSON);
  }
  
  // Send full lead details to purchaser
  let emailSent = false;
  let emailError = null;
  
  try {
    sendPurchasedLeadEmail(customerEmail, lead, leadId);
    emailSent = true;
  } catch (error) {
    emailError = error.toString();
    logError('sendPurchasedLeadEmail', error);
  }
  
  // Update lead status in sheet
  updateLeadPurchaseStatus(leadId, customerEmail, amountPaid, paymentId, emailSent);
  
  // Send admin notification (ALWAYS - this is your verification)
  sendPurchaseNotification(leadId, lead, customerEmail, amountPaid, emailSent, emailError);
  
  // Secondary check: Schedule verification (Apps Script trigger)
  scheduleVerification(leadId, customerEmail);
  
  if (!emailSent) {
    return ContentService.createTextOutput(JSON.stringify({
      status: 'partial',
      message: 'Payment recorded but email failed - admin notified',
      leadId: leadId
    })).setMimeType(ContentService.MimeType.JSON);
  }
  
  return ContentService.createTextOutput(JSON.stringify({
    status: 'ok',
    message: 'Lead delivered successfully',
    leadId: leadId
  })).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Get lead details by ID
 */
function getLeadById(leadId) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName('Leads');
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  
  for (let i = 1; i < data.length; i++) {
    if (data[i][1] === leadId) { // Lead ID is column B (index 1)
      const lead = {};
      headers.forEach((header, index) => {
        lead[header] = data[i][index];
      });
      lead.rowNumber = i + 1;
      return lead;
    }
  }
  return null;
}

/**
 * Send full lead details to purchaser
 */
function sendPurchasedLeadEmail(email, lead, leadId) {
  const subject = `Your lead details - ${leadId}`;
  
  const name = lead['Name'] || 'Not provided';
  const phone = lead['Phone'] || 'Not provided';
  const leadEmail = lead['Email'] || 'Not provided';
  const zip = lead['Zip Code'] || '';
  const size = lead['Dumpster Size'] || 'Not specified';
  const timeframe = lead['Timeframe'] || 'Not specified';
  const projectType = lead['Project Type'] || 'Not specified';
  
  const htmlBody = `
<div style="font-family: Arial, sans-serif; font-size: 14px; color: #333; line-height: 1.6; max-width: 600px;">
  <p>Hi,</p>
  
  <p>Thanks for your purchase! Here are the full details for your lead:</p>
  
  <div style="margin: 20px 0; padding: 20px; background: #f0fdf4; border: 1px solid #86efac; border-radius: 8px;">
    <p style="margin: 0 0 12px 0;"><strong style="font-size: 16px;">Contact Information</strong></p>
    <p style="margin: 4px 0;"><strong>Name:</strong> ${name}</p>
    <p style="margin: 4px 0;"><strong>Phone:</strong> ${phone}</p>
    <p style="margin: 4px 0;"><strong>Email:</strong> ${leadEmail}</p>
  </div>
  
  <div style="margin: 20px 0; padding: 20px; background: #f9f9f9; border-radius: 8px;">
    <p style="margin: 0 0 12px 0;"><strong>Project Details</strong></p>
    <p style="margin: 4px 0;"><strong>Location:</strong> ${zip}</p>
    <p style="margin: 4px 0;"><strong>Size needed:</strong> ${size}</p>
    <p style="margin: 4px 0;"><strong>Timeline:</strong> ${timeframe}</p>
    <p style="margin: 4px 0;"><strong>Project type:</strong> ${projectType}</p>
  </div>
  
  <p><strong>Pro tip:</strong> Call within 5 minutes for the best chance of winning the job. Text first if they don't answer.</p>
  
  <p>Good luck!</p>
  
  <p>Thanks,<br>
  <strong>DumpsterMap</strong><br>
  <a href="https://dumpstermap.io/for-providers" style="color: #2563eb;">dumpstermap.io/for-providers</a></p>
</div>
`;

  const plainBody = `Thanks for your purchase! Here are the full details for your lead:

CONTACT INFORMATION
Name: ${name}
Phone: ${phone}
Email: ${leadEmail}

PROJECT DETAILS
Location: ${zip}
Size needed: ${size}
Timeline: ${timeframe}
Project type: ${projectType}

Pro tip: Call within 5 minutes for the best chance of winning the job.

Thanks,
DumpsterMap
https://dumpstermap.io/for-providers
`;

  GmailApp.sendEmail(email, subject, plainBody, {
    name: 'DumpsterMap',
    replyTo: 'support@dumpstermap.io',
    htmlBody: htmlBody
  });
}

/**
 * Update lead status after purchase
 */
function updateLeadPurchaseStatus(leadId, buyerEmail, amount, paymentId, emailSent) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName('Leads');
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  
  // Find or create columns for purchase tracking
  let statusCol = headers.indexOf('Status');
  let purchasedByCol = headers.indexOf('Purchased By');
  let purchasedAtCol = headers.indexOf('Purchased At');
  let paymentIdCol = headers.indexOf('Payment ID');
  let emailSentCol = headers.indexOf('Email Sent');
  
  // Add columns if they don't exist
  const lastCol = headers.length;
  if (purchasedByCol === -1) { purchasedByCol = lastCol; sheet.getRange(1, lastCol + 1).setValue('Purchased By'); }
  if (purchasedAtCol === -1) { purchasedAtCol = lastCol + 1; sheet.getRange(1, lastCol + 2).setValue('Purchased At'); }
  if (paymentIdCol === -1) { paymentIdCol = lastCol + 2; sheet.getRange(1, lastCol + 3).setValue('Payment ID'); }
  if (emailSentCol === -1) { emailSentCol = lastCol + 3; sheet.getRange(1, lastCol + 4).setValue('Email Sent'); }
  
  // Find the lead row and update
  for (let i = 1; i < data.length; i++) {
    if (data[i][1] === leadId) {
      const row = i + 1;
      if (statusCol !== -1) sheet.getRange(row, statusCol + 1).setValue('Purchased');
      sheet.getRange(row, purchasedByCol + 1).setValue(buyerEmail);
      sheet.getRange(row, purchasedAtCol + 1).setValue(new Date().toISOString());
      sheet.getRange(row, paymentIdCol + 1).setValue(paymentId);
      sheet.getRange(row, emailSentCol + 1).setValue(emailSent ? 'Yes' : 'FAILED');
      break;
    }
  }
}

/**
 * Send admin notification about purchase
 */
function sendPurchaseNotification(leadId, lead, buyerEmail, amount, emailSent, emailError) {
  const status = emailSent ? '✅ SUCCESS' : '❌ EMAIL FAILED';
  const subject = `${status} - Lead ${leadId} purchased`;
  
  const body = `
LEAD PURCHASE ${status}

Lead: ${leadId}
Buyer: ${buyerEmail}
Amount: $${amount}

Lead Details:
- Name: ${lead['Name']}
- Phone: ${lead['Phone']}
- Email: ${lead['Email']}
- Zip: ${lead['Zip Code']}

Email to buyer: ${emailSent ? 'Sent successfully' : 'FAILED - ' + emailError}

${!emailSent ? '⚠️ ACTION REQUIRED: Manually send lead details to ' + buyerEmail : ''}

Sheet: https://docs.google.com/spreadsheets/d/${SHEET_ID}
`;

  GmailApp.sendEmail(NOTIFICATION_EMAIL, subject, body);
}

/**
 * Send admin alert for critical errors
 */
function sendAdminAlert(type, message) {
  GmailApp.sendEmail(NOTIFICATION_EMAIL, `⚠️ DumpsterMap Alert: ${type}`, message);
}

/**
 * Log purchase attempt for audit trail
 */
function logPurchaseAttempt(leadId, email, amount, paymentId) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let logSheet = ss.getSheetByName('Purchase Log');
  
  if (!logSheet) {
    logSheet = ss.insertSheet('Purchase Log');
    logSheet.appendRow(['Timestamp', 'Lead ID', 'Buyer Email', 'Amount', 'Payment ID', 'Status']);
  }
  
  logSheet.appendRow([new Date().toISOString(), leadId, email, amount, paymentId, 'Attempted']);
}

/**
 * Log errors for debugging
 */
function logError(func, error) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let logSheet = ss.getSheetByName('Error Log');
  
  if (!logSheet) {
    logSheet = ss.insertSheet('Error Log');
    logSheet.appendRow(['Timestamp', 'Function', 'Error']);
  }
  
  logSheet.appendRow([new Date().toISOString(), func, error.toString()]);
}

/**
 * Schedule verification check (creates a time-based trigger)
 */
function scheduleVerification(leadId, buyerEmail) {
  // Store pending verification
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let verifySheet = ss.getSheetByName('Pending Verification');
  
  if (!verifySheet) {
    verifySheet = ss.insertSheet('Pending Verification');
    verifySheet.appendRow(['Lead ID', 'Buyer Email', 'Scheduled At', 'Verified']);
  }
  
  verifySheet.appendRow([leadId, buyerEmail, new Date().toISOString(), 'Pending']);
}

/**
 * Manual function to verify all pending purchases (run daily)
 */
function auditPendingPurchases() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const leadsSheet = ss.getSheetByName('Leads');
  const leads = leadsSheet.getDataRange().getValues();
  const headers = leads[0];
  
  const statusCol = headers.indexOf('Status');
  const emailSentCol = headers.indexOf('Email Sent');
  const purchasedByCol = headers.indexOf('Purchased By');
  
  const problems = [];
  
  for (let i = 1; i < leads.length; i++) {
    const status = leads[i][statusCol];
    const emailSent = leads[i][emailSentCol];
    const purchasedBy = leads[i][purchasedByCol];
    const leadId = leads[i][1];
    
    // Check for purchased leads where email failed
    if (status === 'Purchased' && emailSent !== 'Yes' && purchasedBy) {
      problems.push({
        leadId: leadId,
        buyer: purchasedBy,
        issue: 'Purchased but email not sent'
      });
    }
  }
  
  if (problems.length > 0) {
    const body = `AUDIT ALERT: ${problems.length} leads need attention:\n\n` + 
      problems.map(p => `- ${p.leadId}: ${p.issue} (${p.buyer})`).join('\n') +
      `\n\nSheet: https://docs.google.com/spreadsheets/d/${SHEET_ID}`;
    
    GmailApp.sendEmail(NOTIFICATION_EMAIL, '⚠️ DumpsterMap Audit: Action Required', body);
  }
  
  return problems;
}

/**
 * Manual function to resend lead to buyer
 */
function resendLeadToBuyer(leadId, buyerEmail) {
  const lead = getLeadById(leadId);
  if (!lead) {
    throw new Error('Lead not found: ' + leadId);
  }
  
  sendPurchasedLeadEmail(buyerEmail, lead, leadId);
  
  // Update email sent status
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName('Leads');
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const emailSentCol = headers.indexOf('Email Sent');
  
  if (emailSentCol !== -1 && lead.rowNumber) {
    sheet.getRange(lead.rowNumber, emailSentCol + 1).setValue('Yes (Resent)');
  }
  
  sendAdminAlert('Lead Resent', `${leadId} manually resent to ${buyerEmail}`);
}

// ============================================
// LEAD HANDLING
// ============================================

/**
 * Handle new lead submission
 */
function handleLeadSubmission(data) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const leadsSheet = ss.getSheetByName('Leads');
  
  // Generate lead ID
  const leadId = 'LEAD-' + String(leadsSheet.getLastRow()).padStart(4, '0');
  
  // Add lead to sheet
  leadsSheet.appendRow([
    data.timestamp || new Date().toISOString(),
    leadId,
    ((data.firstName || '') + ' ' + (data.lastName || '')).trim(),
    data.email || '',
    data.phone || '',
    data.zip || '',
    data.projectType || '',
    data.size || '',
    data.timeframe || data.timeline || '',  // Form uses 'timeline'
    data.message || '',
    data.source || 'Website',
    'New',
    data.providerName || '', // Provider from form (if user clicked specific provider)
    '', // Credits Charged
    ''  // Notes
  ]);
  
  // Find matching providers and send notifications
  const zip = data.zip || '';
  if (zip) {
    notifyMatchingProviders(leadId, data, zip);
  }
  
  // Notify admin
  sendAdminNotification(leadId, data);
  
  return ContentService.createTextOutput(JSON.stringify({
    status: 'ok',
    leadId: leadId,
    message: 'Lead submitted successfully'
  })).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Find providers serving the given zip and notify them
 */
function notifyMatchingProviders(leadId, leadData, zip) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const providersSheet = ss.getSheetByName('Providers');
  const providers = providersSheet.getDataRange().getValues();
  const headers = providers[0];
  
  // Find column indexes
  const cols = {
    email: headers.indexOf('Email'),
    serviceZips: headers.indexOf('Service Zips'),
    creditBalance: headers.indexOf('Credit Balance'),
    companyName: headers.indexOf('Company Name'),
    status: headers.indexOf('Status')
  };
  
  // Find matching providers
  for (let i = 1; i < providers.length; i++) {
    const row = providers[i];
    const status = row[cols.status];
    
    // Skip inactive providers
    if (status !== 'Active') continue;
    
    // Check if provider serves this zip
    const serviceZips = (row[cols.serviceZips] || '').toString().split(',').map(z => z.trim());
    if (!serviceZips.includes(zip)) continue;
    
    const providerEmail = row[cols.email];
    const companyName = row[cols.companyName];
    const creditBalance = parseInt(row[cols.creditBalance]) || 0;
    
    if (creditBalance > 0) {
      // Provider has credits - send full lead and deduct
      sendFullLeadEmail(providerEmail, companyName, leadId, leadData);
      deductCredit(providersSheet, i + 1, cols.creditBalance, creditBalance);
      updateLeadAssignment(leadId, companyName);
    } else {
      // No credits - send teaser with payment link
      sendLeadTeaserEmail(providerEmail, companyName, leadId, leadData);
    }
  }
}

/**
 * Send full lead details to provider with credits
 */
function sendFullLeadEmail(email, companyName, leadId, lead) {
  const subject = `New lead in ${lead.zip} - ${lead.size ? lead.size + ' yard' : 'Dumpster rental'}`;
  
  const timeframeText = lead.timeframe === 'asap' ? 'as soon as possible' : 
                        lead.timeframe === 'next-week' ? 'next week' :
                        lead.timeframe === '2-weeks' ? 'within 2 weeks' : 
                        lead.timeframe || 'soon';
  
  const body = `
Hi ${companyName},

A customer in ${lead.zip} just requested a quote for dumpster rental. They need it ${timeframeText}.

Contact Info:
- Name: ${lead.firstName || ''} ${lead.lastName || ''}
- Phone: ${lead.phone || 'Not provided'}
- Email: ${lead.email || 'Not provided'}

Project Details:
- Location: ${lead.zip}
- Size: ${lead.size ? lead.size + ' yard' : 'Not specified yet'}
- Project: ${lead.projectType || 'Not specified'}
${lead.message ? '- Notes: ' + lead.message : ''}

Quick tip: Calling within 5 minutes dramatically increases your chances of winning the job.

1 credit has been used. Check your balance: https://dumpstermap.io/balance

Thanks,
DumpsterMap
`;

  GmailApp.sendEmail(email, subject, body, {
    name: 'DumpsterMap Leads',
    replyTo: 'leads@dumpstermap.io'
  });
}

/**
 * Send teaser email with Stripe payment link
 */
function sendLeadTeaserEmail(email, companyName, leadId, lead) {
  const subject = `Customer looking for dumpster rental in ${lead.zip}`;
  
  // Create payment link with lead ID in metadata
  const paymentLink = `${SINGLE_LEAD_STRIPE_LINK}?client_reference_id=${leadId}`;
  
  const timeframeText = lead.timeframe === 'asap' ? 'as soon as possible' : 
                        lead.timeframe === 'next-week' ? 'next week' :
                        lead.timeframe === '2-weeks' ? 'within 2 weeks' : 
                        lead.timeframe || 'soon';
  
  const htmlBody = `
<div style="font-family: Arial, sans-serif; font-size: 14px; color: #333; line-height: 1.6; max-width: 600px;">
  <p>Hi,</p>
  
  <p>A customer near you is looking for a dumpster rental. Here's what they told us:</p>
  
  <p style="margin: 16px 0; padding: 16px; background: #f9f9f9; border-radius: 6px;">
    <strong>Location:</strong> ${lead.zip}<br>
    <strong>Size needed:</strong> ${lead.size ? lead.size + ' yard' : 'Not sure yet'}<br>
    <strong>Timeline:</strong> ${timeframeText}
  </p>
  
  <p>They found your business on DumpsterMap and requested a quote. These are real people actively looking to rent – not a cold list.</p>
  
  <p>If you'd like their contact info so you can reach out directly, you can get this lead here:<br>
  <a href="${paymentLink}" style="color: #2563eb;">${paymentLink}</a></p>
  
  <p><strong>Here's how it works:</strong></p>
  <ol style="margin: 8px 0; padding-left: 20px;">
    <li>You'll get a receipt from Stripe</li>
    <li>We'll email you the customer's name, phone, and email within minutes</li>
    <li>You call them and close the deal</li>
  </ol>
  
  <p>Questions? Just reply to this email.</p>
  
  <p>Thanks,<br>
  <strong>DumpsterMap</strong><br>
  <a href="https://dumpstermap.io/for-providers" style="color: #2563eb;">dumpstermap.io/for-providers</a></p>
  
  <p style="font-size: 12px; color: #888; margin-top: 24px;">P.S. You're getting this because you serve the ${lead.zip} area. Let us know if that's changed.</p>
</div>
`;

  const body = `Hi,

A customer near you is looking for a dumpster rental. Here's what they told us:

Location: ${lead.zip}
Size needed: ${lead.size ? lead.size + ' yard' : 'Not sure yet'}
Timeline: ${timeframeText}

They found your business on DumpsterMap and requested a quote. These are real people actively looking to rent - not a cold list.

If you'd like their contact info so you can reach out directly, you can get this lead here:
${paymentLink}

Here's how it works:
1. You'll get a receipt from Stripe
2. We'll email you the customer's name, phone, and email within minutes
3. You call them and close the deal

Questions? Just reply to this email.

Thanks,
DumpsterMap
https://dumpstermap.io/for-providers

P.S. You're getting this because you serve the ${lead.zip} area. Let us know if that's changed.
`;

  GmailApp.sendEmail(email, subject, body, {
    name: 'DumpsterMap',
    replyTo: 'support@dumpstermap.io',
    htmlBody: htmlBody
  });
}

/**
 * Deduct credit from provider
 */
function deductCredit(sheet, rowNum, colIndex, currentBalance) {
  sheet.getRange(rowNum, colIndex + 1).setValue(currentBalance - 1);
}

/**
 * Update lead with assigned provider
 */
function updateLeadAssignment(leadId, providerName) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const leadsSheet = ss.getSheetByName('Leads');
  const leads = leadsSheet.getDataRange().getValues();
  
  for (let i = 1; i < leads.length; i++) {
    if (leads[i][1] === leadId) {
      leadsSheet.getRange(i + 1, 13).setValue(providerName); // Assigned Provider column
      leadsSheet.getRange(i + 1, 14).setValue(1); // Credits Charged
      leadsSheet.getRange(i + 1, 12).setValue('Sent'); // Status
      break;
    }
  }
}

/**
 * Send admin notification about new lead
 */
function sendAdminNotification(leadId, lead) {
  const subject = `New lead: ${leadId} - ${lead.zip}`;
  const body = `
${leadId}
${lead.firstName || ''} ${lead.lastName || ''} | ${lead.phone} | ${lead.email}
${lead.zip} | ${lead.size ? lead.size + 'yd' : 'Size TBD'} | ${lead.source}

Sheet: https://docs.google.com/spreadsheets/d/${SHEET_ID}
`;

  GmailApp.sendEmail(NOTIFICATION_EMAIL, subject, body);
}

// ============================================
// BALANCE CHECK
// ============================================

/**
 * Check provider credit balance
 */
function checkBalance(email, phoneLast4) {
  const provider = getProviderByEmail(email.toLowerCase().trim());
  
  if (!provider) {
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error',
      message: 'No provider found with that email'
    })).setMimeType(ContentService.MimeType.JSON);
  }
  
  // Verify phone
  const providerPhone = (provider.phone || '').replace(/\D/g, '');
  const providerLast4 = providerPhone.slice(-4);
  
  if (!phoneLast4 || phoneLast4 !== providerLast4) {
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error',
      message: 'Phone verification failed'
    })).setMimeType(ContentService.MimeType.JSON);
  }
  
  return ContentService.createTextOutput(JSON.stringify({
    status: 'ok',
    companyName: provider.companyName,
    creditBalance: provider.creditBalance,
    totalLeadsReceived: provider.totalLeads || 0,
    plan: provider.plan || 'Free'
  })).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Get provider by email
 */
function getProviderByEmail(email) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName('Providers');
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  
  const cols = {
    email: headers.indexOf('Email'),
    companyName: headers.indexOf('Company Name'),
    phone: headers.indexOf('Phone'),
    creditBalance: headers.indexOf('Credit Balance'),
    totalLeads: headers.indexOf('Total Leads Received'),
    plan: headers.indexOf('Plan')
  };
  
  for (let i = 1; i < data.length; i++) {
    if (data[i][cols.email]?.toLowerCase().trim() === email) {
      return {
        companyName: data[i][cols.companyName],
        phone: data[i][cols.phone],
        creditBalance: parseInt(data[i][cols.creditBalance]) || 0,
        totalLeads: parseInt(data[i][cols.totalLeads]) || 0,
        plan: data[i][cols.plan]
      };
    }
  }
  
  return null;
}
