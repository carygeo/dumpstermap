#!/usr/bin/env node
/**
 * Fix Schema URLs in State Abbreviation Pages
 * 
 * Updates JSON-LD schema URLs in abbreviated state pages (ny.html, ca.html)
 * to match their canonical URLs (new-york.html, california.html)
 */

const fs = require('fs');
const path = require('path');

// State abbreviation to full name mapping
const stateNames = {
    'AL': 'Alabama', 'AK': 'Alaska', 'AZ': 'Arizona', 'AR': 'Arkansas',
    'CA': 'California', 'CO': 'Colorado', 'CT': 'Connecticut', 'DE': 'Delaware',
    'FL': 'Florida', 'GA': 'Georgia', 'HI': 'Hawaii', 'ID': 'Idaho',
    'IL': 'Illinois', 'IN': 'Indiana', 'IA': 'Iowa', 'KS': 'Kansas',
    'KY': 'Kentucky', 'LA': 'Louisiana', 'ME': 'Maine', 'MD': 'Maryland',
    'MA': 'Massachusetts', 'MI': 'Michigan', 'MN': 'Minnesota', 'MS': 'Mississippi',
    'MO': 'Missouri', 'MT': 'Montana', 'NE': 'Nebraska', 'NV': 'Nevada',
    'NH': 'New Hampshire', 'NJ': 'New Jersey', 'NM': 'New Mexico', 'NY': 'New York',
    'NC': 'North Carolina', 'ND': 'North Dakota', 'OH': 'Ohio', 'OK': 'Oklahoma',
    'OR': 'Oregon', 'PA': 'Pennsylvania', 'RI': 'Rhode Island', 'SC': 'South Carolina',
    'SD': 'South Dakota', 'TN': 'Tennessee', 'TX': 'Texas', 'UT': 'Utah',
    'VT': 'Vermont', 'VA': 'Virginia', 'WA': 'Washington', 'WV': 'West Virginia',
    'WI': 'Wisconsin', 'WY': 'Wyoming', 'DC': 'District of Columbia'
};

const outputDir = path.join(__dirname, '../dumpster-rental');
const baseUrl = 'https://dumpstermap.io';

let fixed = 0;
let skipped = 0;
let errors = 0;

for (const [abbr, fullName] of Object.entries(stateNames)) {
    const abbrFile = path.join(outputDir, `${abbr.toLowerCase()}.html`);
    const fullSlug = fullName.toLowerCase().replace(/\s+/g, '-');
    const canonicalUrl = `${baseUrl}/dumpster-rental/${fullSlug}.html`;
    
    if (!fs.existsSync(abbrFile)) {
        continue;
    }
    
    try {
        let html = fs.readFileSync(abbrFile, 'utf8');
        let modified = false;
        
        // Fix JSON-LD schema URL (the main "url" field in CollectionPage)
        const schemaOldUrl = `"url": "${baseUrl}/dumpster-rental/${abbr.toLowerCase()}.html"`;
        const schemaNewUrl = `"url": "${canonicalUrl}"`;
        if (html.includes(schemaOldUrl)) {
            html = html.replace(schemaOldUrl, schemaNewUrl);
            modified = true;
        }
        
        // Fix breadcrumb schema "item" URL
        const breadcrumbOldUrl = `"item": "${baseUrl}/dumpster-rental/${abbr.toLowerCase()}.html"`;
        const breadcrumbNewUrl = `"item": "${canonicalUrl}"`;
        if (html.includes(breadcrumbOldUrl)) {
            html = html.replace(new RegExp(breadcrumbOldUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), breadcrumbNewUrl);
            modified = true;
        }
        
        if (modified) {
            fs.writeFileSync(abbrFile, html);
            console.log(`✅ Fixed schema URLs in ${abbr.toLowerCase()}.html → ${fullSlug}.html`);
            fixed++;
        } else {
            console.log(`✓ ${abbr.toLowerCase()}.html - schema URLs already correct`);
            skipped++;
        }
    } catch (err) {
        console.error(`❌ Error processing ${abbr.toLowerCase()}.html:`, err.message);
        errors++;
    }
}

console.log(`\n📊 Summary: Fixed ${fixed} files, ${skipped} already correct, ${errors} errors`);
