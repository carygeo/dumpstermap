#!/usr/bin/env node
/**
 * DumpsterMap Sitemap Generator
 * Generates sitemap.xml including all static pages and SEO city/state pages
 */

const fs = require('fs');
const path = require('path');

const baseUrl = 'https://dumpstermap.io';
const outputPath = path.join(__dirname, '../sitemap.xml');
const dumpsterRentalDir = path.join(__dirname, '../dumpster-rental');

// Static pages with priorities
const staticPages = [
    { path: '', changefreq: 'daily', priority: '1.0' },
    { path: 'results.html', changefreq: 'daily', priority: '0.9' },
    { path: 'calculator.html', changefreq: 'weekly', priority: '0.8' },
    { path: 'sizes.html', changefreq: 'weekly', priority: '0.8' },
    { path: 'map.html', changefreq: 'daily', priority: '0.8' },
    { path: 'for-providers.html', changefreq: 'weekly', priority: '0.7' },
    { path: 'contact.html', changefreq: 'monthly', priority: '0.5' },
];

// State abbreviations (2-letter pages get higher priority)
const stateAbbrs = new Set([
    'al','ak','az','ar','ca','co','ct','de','dc','fl','ga','hi','id','il','in',
    'ia','ks','ky','la','me','md','ma','mi','mn','ms','mo','mt','ne','nv','nh',
    'nj','nm','ny','nc','nd','oh','ok','or','pa','ri','sc','sd','tn','tx','ut',
    'vt','va','wa','wv','wi','wy'
]);

function generateSitemap() {
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
    
    // Add static pages
    for (const page of staticPages) {
        const loc = page.path ? `${baseUrl}/${page.path}` : baseUrl;
        xml += `  <url>\n`;
        xml += `    <loc>${loc}</loc>\n`;
        xml += `    <changefreq>${page.changefreq}</changefreq>\n`;
        xml += `    <priority>${page.priority}</priority>\n`;
        xml += `  </url>\n`;
    }
    
    // Get all files in dumpster-rental directory
    const files = fs.readdirSync(dumpsterRentalDir)
        .filter(f => f.endsWith('.html'))
        .sort();
    
    // Separate state pages (2-letter) from city pages
    const statePages = [];
    const cityPages = [];
    
    for (const file of files) {
        const name = file.replace('.html', '');
        if (stateAbbrs.has(name)) {
            statePages.push(file);
        } else {
            cityPages.push(file);
        }
    }
    
    // Add state pages (higher priority)
    for (const file of statePages) {
        xml += `  <url>\n`;
        xml += `    <loc>${baseUrl}/dumpster-rental/${file}</loc>\n`;
        xml += `    <changefreq>weekly</changefreq>\n`;
        xml += `    <priority>0.85</priority>\n`;
        xml += `  </url>\n`;
    }
    
    // Add city pages
    for (const file of cityPages) {
        xml += `  <url>\n`;
        xml += `    <loc>${baseUrl}/dumpster-rental/${file}</loc>\n`;
        xml += `    <changefreq>weekly</changefreq>\n`;
        xml += `    <priority>0.8</priority>\n`;
        xml += `  </url>\n`;
    }
    
    xml += '</urlset>';
    
    fs.writeFileSync(outputPath, xml);
    console.log(`Generated sitemap.xml with:`);
    console.log(`  - ${staticPages.length} static pages`);
    console.log(`  - ${statePages.length} state pages`);
    console.log(`  - ${cityPages.length} city pages`);
    console.log(`  - ${staticPages.length + statePages.length + cityPages.length} total URLs`);
}

generateSitemap();
