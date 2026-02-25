#!/usr/bin/env python3
"""
Pre-render city pages with SEO content.

This script reads each city HTML file, extracts the CITY_CONFIG,
and pre-populates the title, meta description, H1, Open Graph tags,
and schema markup so Google can index them without JavaScript.
"""

import os
import re
import json
from pathlib import Path

CITY_DIR = Path(__file__).parent.parent / "dumpster-rental"

def extract_city_config(html: str) -> dict | None:
    """Extract CITY_CONFIG from the HTML."""
    match = re.search(r'window\.CITY_CONFIG\s*=\s*(\{[^}]+\})', html)
    if match:
        try:
            return json.loads(match.group(1))
        except json.JSONDecodeError:
            return None
    return None

def prerender_page(filepath: Path) -> bool:
    """Pre-render SEO elements in a city page."""
    html = filepath.read_text()
    
    config = extract_city_config(html)
    if not config:
        print(f"  ⚠️  No CITY_CONFIG found: {filepath.name}")
        return False
    
    city = config.get("city", "")
    state = config.get("stateName", config.get("state", ""))
    provider_count = config.get("providerCount", 0)
    avg_rating = config.get("avgRating", "4.5")
    total_reviews = config.get("totalReviews", 0)
    
    if not city or not state:
        print(f"  ⚠️  Missing city/state: {filepath.name}")
        return False
    
    full_location = f"{city}, {state}"
    slug = filepath.stem  # e.g., "naples-florida"
    canonical_url = f"https://dumpstermap.io/dumpster-rental/{slug}.html"
    
    # Build SEO content
    title = f"Dumpster Rentals in {full_location} | Compare Prices | DumpsterMap"
    meta_desc = f"Compare dumpster rental prices from {provider_count}+ providers in {full_location}. Average rating {avg_rating}★ from {total_reviews} reviews. Get instant quotes - no phone calls needed."
    h1_text = f"Dumpster Rentals in {full_location}"
    
    # Schema markup
    schema = {
        "@context": "https://schema.org",
        "@type": "LocalBusiness",
        "name": f"DumpsterMap - {full_location}",
        "description": f"Compare dumpster rental prices from local providers in {full_location}",
        "areaServed": {
            "@type": "City",
            "name": city,
            "containedInPlace": {
                "@type": "State",
                "name": state
            }
        },
        "aggregateRating": {
            "@type": "AggregateRating",
            "ratingValue": avg_rating,
            "reviewCount": total_reviews
        }
    }
    
    # Replace title
    html = re.sub(
        r'<title[^>]*>.*?</title>',
        f'<title id="page-title">{title}</title>',
        html
    )
    
    # Replace meta description
    html = re.sub(
        r'<meta\s+name="description"[^>]*>',
        f'<meta name="description" id="meta-desc" content="{meta_desc}">',
        html
    )
    
    # Replace canonical URL
    html = re.sub(
        r'<link\s+rel="canonical"[^>]*>',
        f'<link rel="canonical" id="canonical-url" href="{canonical_url}">',
        html
    )
    
    # Replace Open Graph tags
    html = re.sub(
        r'<meta\s+property="og:url"[^>]*>',
        f'<meta property="og:url" id="og-url" content="{canonical_url}">',
        html
    )
    html = re.sub(
        r'<meta\s+property="og:title"[^>]*>',
        f'<meta property="og:title" id="og-title" content="{title}">',
        html
    )
    html = re.sub(
        r'<meta\s+property="og:description"[^>]*>',
        f'<meta property="og:description" id="og-desc" content="{meta_desc}">',
        html
    )
    
    # Replace H1
    html = re.sub(
        r'<h1[^>]*id="city-title"[^>]*>.*?</h1>',
        f'<h1 id="city-title">{h1_text}</h1>',
        html
    )
    
    # Replace schema JSON
    schema_json = json.dumps(schema, indent=6)
    html = re.sub(
        r'<script\s+type="application/ld\+json"\s+id="schema-json">[\s\S]*?</script>',
        f'<script type="application/ld+json" id="schema-json">\n    {schema_json}\n    </script>',
        html
    )
    
    # Write back
    filepath.write_text(html)
    return True

def main():
    print("🔧 Pre-rendering city pages for SEO...\n")
    
    if not CITY_DIR.exists():
        print(f"❌ City directory not found: {CITY_DIR}")
        return
    
    html_files = list(CITY_DIR.glob("*.html"))
    print(f"📁 Found {len(html_files)} city pages\n")
    
    success = 0
    failed = 0
    
    for filepath in sorted(html_files):
        if prerender_page(filepath):
            success += 1
            print(f"  ✅ {filepath.name}")
        else:
            failed += 1
    
    print(f"\n{'='*50}")
    print(f"✅ Pre-rendered: {success} pages")
    if failed:
        print(f"⚠️  Skipped: {failed} pages")
    print(f"\n🎉 Done! City pages now have pre-populated SEO content.")
    print("   Google will see proper titles, descriptions, and H1s.")

if __name__ == "__main__":
    main()
