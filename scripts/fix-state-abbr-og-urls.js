#!/usr/bin/env node
/**
 * Fix state abbreviation pages: og:url should match canonical URL
 * 
 * Issue: Pages like tx.html have:
 *   canonical -> texas.html (correct)
 *   og:url -> tx.html (wrong - should match canonical)
 */

const fs = require('fs');
const path = require('path');

const dumpsterRentalDir = path.join(__dirname, '../dumpster-rental');

// State abbreviations to full names
const stateNames = {
    'al': 'alabama', 'ak': 'alaska', 'az': 'arizona', 'ar': 'arkansas',
    'ca': 'california', 'co': 'colorado', 'ct': 'connecticut', 'de': 'delaware',
    'dc': 'district-of-columbia', 'fl': 'florida', 'ga': 'georgia', 'hi': 'hawaii',
    'id': 'idaho', 'il': 'illinois', 'in': 'indiana', 'ia': 'iowa',
    'ks': 'kansas', 'ky': 'kentucky', 'la': 'louisiana', 'me': 'maine',
    'md': 'maryland', 'ma': 'massachusetts', 'mi': 'michigan', 'mn': 'minnesota',
    'ms': 'mississippi', 'mo': 'missouri', 'mt': 'montana', 'ne': 'nebraska',
    'nv': 'nevada', 'nh': 'new-hampshire', 'nj': 'new-jersey', 'nm': 'new-mexico',
    'ny': 'new-york', 'nc': 'north-carolina', 'nd': 'north-dakota', 'oh': 'ohio',
    'ok': 'oklahoma', 'or': 'oregon', 'pa': 'pennsylvania', 'ri': 'rhode-island',
    'sc': 'south-carolina', 'sd': 'south-dakota', 'tn': 'tennessee', 'tx': 'texas',
    'ut': 'utah', 'vt': 'vermont', 'va': 'virginia', 'wa': 'washington',
    'wv': 'west-virginia', 'wi': 'wisconsin', 'wy': 'wyoming'
};

let fixedCount = 0;
let skippedCount = 0;

for (const [abbr, fullName] of Object.entries(stateNames)) {
    const abbrFile = path.join(dumpsterRentalDir, `${abbr}.html`);
    
    if (!fs.existsSync(abbrFile)) {
        continue;
    }
    
    let content = fs.readFileSync(abbrFile, 'utf8');
    const originalContent = content;
    
    // Fix og:url to match canonical
    const wrongOgUrl = `<meta property="og:url" content="https://dumpstermap.io/dumpster-rental/${abbr}.html">`;
    const correctOgUrl = `<meta property="og:url" content="https://dumpstermap.io/dumpster-rental/${fullName}.html">`;
    
    if (content.includes(wrongOgUrl)) {
        content = content.replace(wrongOgUrl, correctOgUrl);
    }
    
    // Also fix schema.org URL references if they point to abbreviation
    const schemaAbbrUrl = `"url": "https://dumpstermap.io/dumpster-rental/${abbr}.html"`;
    const schemaFullUrl = `"url": "https://dumpstermap.io/dumpster-rental/${fullName}.html"`;
    content = content.replace(new RegExp(schemaAbbrUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), schemaFullUrl);
    
    if (content !== originalContent) {
        fs.writeFileSync(abbrFile, content);
        console.log(`✅ Fixed: ${abbr}.html → og:url now points to ${fullName}.html`);
        fixedCount++;
    } else {
        skippedCount++;
    }
}

console.log(`\nSummary: ${fixedCount} files fixed, ${skippedCount} already correct/skipped`);
