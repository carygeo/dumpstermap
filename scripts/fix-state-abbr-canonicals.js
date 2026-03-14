#!/usr/bin/env node
/**
 * Fix state abbreviation pages to use canonical pointing to full state name pages
 * This consolidates duplicate content and improves SEO
 */

const fs = require('fs');
const path = require('path');

const stateMap = {
  'ak': 'alaska',
  'al': 'alabama',
  'ar': 'arkansas',
  'az': 'arizona',
  'ca': 'california',
  'co': 'colorado',
  'ct': 'connecticut',
  'dc': 'district-of-columbia',
  'de': 'delaware',
  'fl': 'florida',
  'ga': 'georgia',
  'hi': 'hawaii',
  'ia': 'iowa',
  'id': 'idaho',
  'il': 'illinois',
  'in': 'indiana',
  'ks': 'kansas',
  'ky': 'kentucky',
  'la': 'louisiana',
  'ma': 'massachusetts',
  'md': 'maryland',
  'me': 'maine',
  'mi': 'michigan',
  'mn': 'minnesota',
  'mo': 'missouri',
  'ms': 'mississippi',
  'mt': 'montana',
  'nc': 'north-carolina',
  'nd': 'north-dakota',
  'ne': 'nebraska',
  'nh': 'new-hampshire',
  'nj': 'new-jersey',
  'nm': 'new-mexico',
  'nv': 'nevada',
  'ny': 'new-york',
  'oh': 'ohio',
  'ok': 'oklahoma',
  'or': 'oregon',
  'pa': 'pennsylvania',
  'ri': 'rhode-island',
  'sc': 'south-carolina',
  'sd': 'south-dakota',
  'tn': 'tennessee',
  'tx': 'texas',
  'ut': 'utah',
  'va': 'virginia',
  'vt': 'vermont',
  'wa': 'washington',
  'wi': 'wisconsin',
  'wv': 'west-virginia',
  'wy': 'wyoming'
};

const dumpsterDir = path.join(__dirname, '..', 'dumpster-rental');
let fixed = 0;
let errors = 0;

for (const [abbr, fullName] of Object.entries(stateMap)) {
  const abbrFile = path.join(dumpsterDir, `${abbr}.html`);
  const canonicalUrl = `https://dumpstermap.io/dumpster-rental/${fullName}.html`;
  
  if (!fs.existsSync(abbrFile)) {
    console.log(`⚠️  Missing: ${abbr}.html`);
    continue;
  }
  
  try {
    let content = fs.readFileSync(abbrFile, 'utf8');
    
    // Replace the canonical URL
    const oldCanonical = `href="https://dumpstermap.io/dumpster-rental/${abbr}.html"`;
    const newCanonical = `href="${canonicalUrl}"`;
    
    if (content.includes(oldCanonical)) {
      content = content.replace(
        new RegExp(`<link rel="canonical" href="https://dumpstermap\\.io/dumpster-rental/${abbr}\\.html">`, 'g'),
        `<link rel="canonical" href="${canonicalUrl}">`
      );
      
      fs.writeFileSync(abbrFile, content);
      console.log(`✅ Fixed: ${abbr}.html → ${fullName}.html`);
      fixed++;
    } else if (content.includes(canonicalUrl)) {
      console.log(`✓  Already correct: ${abbr}.html`);
    } else {
      console.log(`⚠️  Unexpected canonical in ${abbr}.html`);
      errors++;
    }
  } catch (err) {
    console.error(`❌ Error processing ${abbr}.html:`, err.message);
    errors++;
  }
}

console.log(`\n📊 Summary: ${fixed} fixed, ${errors} errors`);
