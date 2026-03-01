#!/usr/bin/env node
/**
 * Fix State Page Canonicals
 * 
 * Updates abbreviated state pages (ny.html, ca.html) to have
 * canonical URLs pointing to the full-name versions (new-york.html, california.html)
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
let errors = 0;

for (const [abbr, fullName] of Object.entries(stateNames)) {
    const abbrFile = path.join(outputDir, `${abbr.toLowerCase()}.html`);
    const fullSlug = fullName.toLowerCase().replace(/\s+/g, '-');
    const canonicalUrl = `${baseUrl}/dumpster-rental/${fullSlug}.html`;
    
    if (!fs.existsSync(abbrFile)) {
        continue;  // Skip if abbreviated file doesn't exist
    }
    
    try {
        let html = fs.readFileSync(abbrFile, 'utf8');
        
        // Check if already has correct canonical
        if (html.includes(`href="${canonicalUrl}"`)) {
            console.log(`✓ ${abbr.toLowerCase()}.html - already correct`);
            continue;
        }
        
        // Fix canonical URL
        const oldCanonical = `${baseUrl}/dumpster-rental/${abbr.toLowerCase()}.html`;
        html = html.replace(
            new RegExp(`<link rel="canonical"[^>]*href="[^"]*"[^>]*>`, 'i'),
            `<link rel="canonical" href="${canonicalUrl}">`
        );
        
        // Fix og:url to also point to canonical
        html = html.replace(
            new RegExp(`<meta property="og:url"[^>]*content="[^"]*${abbr.toLowerCase()}\\.html"[^>]*>`, 'i'),
            `<meta property="og:url" content="${canonicalUrl}">`
        );
        
        fs.writeFileSync(abbrFile, html);
        console.log(`✅ Fixed ${abbr.toLowerCase()}.html → ${fullSlug}.html`);
        fixed++;
    } catch (err) {
        console.error(`❌ Error processing ${abbr.toLowerCase()}.html:`, err.message);
        errors++;
    }
}

console.log(`\n📊 Summary: Fixed ${fixed} files, ${errors} errors`);
