#!/usr/bin/env python3
"""
DumpsterMap - Data Cleaning Pipeline
Based on: 8 - Abel Brain/research/online-directories/dumpster/dumpstermap-data-acquisition-plan.md

Phase 2: Data Cleaning
- Step 2.1: Remove obvious junk
- Step 2.2: Verify with Crawl4AI (separate script)
- Step 2.3: Deduplicate
"""

import json
import re
from pathlib import Path
from datetime import datetime
from collections import defaultdict

RAW_DIR = Path.home() / "dumpstermap" / "data" / "raw"
CLEAN_DIR = Path.home() / "dumpstermap" / "data" / "cleaned"

# Removal criteria from the plan
BIG_BOX_RETAILERS = [
    "home depot", "lowe's", "lowes", "menards", "ace hardware",
    "true value", "harbor freight", "northern tool"
]

NATIONAL_WASTE_COMPANIES = [
    "waste management", "republic services", "waste connections",
    "advanced disposal", "casella", "gfl environmental",
    "waste industries", "rumpke", "waste pro"
]

JUNK_REMOVAL_ONLY_KEYWORDS = [
    "junk removal", "junk hauling", "1-800-got-junk",
    "college hunks", "junkluggers", "junk king"
]

NON_DUMPSTER_KEYWORDS = [
    "portable toilet", "porta potty", "porta-potty", "portaloo",
    "storage unit", "self storage", "mini storage",
    "moving company", "movers", "u-haul", "penske",
    "septic", "grease trap", "portable restroom"
]


def should_remove(record: dict) -> tuple[bool, str]:
    """
    Check if record should be removed.
    Returns (should_remove: bool, reason: str)
    """
    name = (record.get("name") or "").lower()
    category = (record.get("category") or "").lower()
    subtypes = (record.get("subtypes") or "").lower()
    status = record.get("business_status", "")
    
    # Missing critical fields
    if not record.get("name"):
        return True, "missing_name"
    if not record.get("phone") and not record.get("website"):
        return True, "missing_contact"
    if not record.get("address"):
        return True, "missing_address"
    
    # Permanently closed
    if status == "CLOSED_PERMANENTLY":
        return True, "closed_permanently"
    
    # Big box retailers
    for bb in BIG_BOX_RETAILERS:
        if bb in name:
            return True, f"big_box_retailer:{bb}"
    
    # National waste companies (we'll add these separately with accurate data)
    for nwc in NATIONAL_WASTE_COMPANIES:
        if nwc in name:
            return True, f"national_chain:{nwc}"
    
    # Junk removal only (not dumpster rental)
    if "junk removal" in category and "dumpster" not in category:
        for kw in JUNK_REMOVAL_ONLY_KEYWORDS:
            if kw in name:
                return True, f"junk_removal_only:{kw}"
    
    # Non-dumpster businesses
    for kw in NON_DUMPSTER_KEYWORDS:
        if kw in name or kw in category:
            return True, f"non_dumpster:{kw}"
    
    return False, "keep"


def normalize_phone(phone: str) -> str:
    """Normalize phone number for dedup matching."""
    if not phone:
        return ""
    digits = re.sub(r'\D', '', phone)
    if len(digits) == 11 and digits.startswith('1'):
        digits = digits[1:]
    return digits


def normalize_address(address: str) -> str:
    """Normalize address for dedup matching."""
    if not address:
        return ""
    addr = address.lower().strip()
    # Remove common variations
    addr = re.sub(r'\bst\b', 'street', addr)
    addr = re.sub(r'\brd\b', 'road', addr)
    addr = re.sub(r'\bave\b', 'avenue', addr)
    addr = re.sub(r'\bblvd\b', 'boulevard', addr)
    addr = re.sub(r'\bdr\b', 'drive', addr)
    addr = re.sub(r'\s+', ' ', addr)
    return addr


def deduplicate(records: list) -> list:
    """
    Deduplicate records by:
    1. Exact phone match
    2. Same normalized address
    3. Same website domain
    """
    seen_phones = {}
    seen_addresses = {}
    seen_websites = {}
    unique = []
    dupes = 0
    
    for r in records:
        is_dupe = False
        
        # Check phone
        phone = normalize_phone(r.get("phone", ""))
        if phone and len(phone) == 10:
            if phone in seen_phones:
                is_dupe = True
            else:
                seen_phones[phone] = r.get("place_id")
        
        # Check address
        if not is_dupe:
            addr = normalize_address(r.get("address", ""))
            if addr and len(addr) > 15:  # Meaningful address
                if addr in seen_addresses:
                    is_dupe = True
                else:
                    seen_addresses[addr] = r.get("place_id")
        
        # Check website domain
        if not is_dupe:
            website = r.get("website", "")
            if website:
                # Extract domain
                domain = re.sub(r'^https?://(www\.)?', '', website.lower())
                domain = domain.split('/')[0]
                if domain and domain not in ['facebook.com', 'yelp.com', 'google.com']:
                    if domain in seen_websites:
                        is_dupe = True
                    else:
                        seen_websites[domain] = r.get("place_id")
        
        if not is_dupe:
            unique.append(r)
        else:
            dupes += 1
    
    return unique, dupes


def calculate_quality_score(record: dict) -> float:
    """Calculate a data quality score 0-1."""
    score = 0.0
    max_score = 0.0
    
    # Required fields
    if record.get("name"): score += 1
    if record.get("phone"): score += 1
    if record.get("address"): score += 1
    if record.get("website"): score += 1
    max_score += 4
    
    # Verification signals
    if record.get("verified"): score += 1
    if record.get("business_status") == "OPERATIONAL": score += 0.5
    max_score += 1.5
    
    # Reviews (trust signal)
    reviews = record.get("reviews", 0) or 0
    if reviews >= 50: score += 1
    elif reviews >= 20: score += 0.7
    elif reviews >= 5: score += 0.4
    elif reviews >= 1: score += 0.2
    max_score += 1
    
    # Rating
    rating = record.get("rating", 0) or 0
    if rating >= 4.5: score += 1
    elif rating >= 4.0: score += 0.7
    elif rating >= 3.5: score += 0.4
    max_score += 1
    
    # Photos
    photos = record.get("photos_count", 0) or 0
    if photos >= 10: score += 1
    elif photos >= 5: score += 0.6
    elif photos >= 1: score += 0.3
    max_score += 1
    
    return round(score / max_score, 2)


def clean_all():
    """Run cleaning pipeline on all state files."""
    CLEAN_DIR.mkdir(parents=True, exist_ok=True)
    
    stats = {
        "total_raw": 0,
        "removed": defaultdict(int),
        "total_after_filter": 0,
        "duplicates_removed": 0,
        "total_clean": 0,
        "by_state": {}
    }
    
    all_records = []
    
    # Load and filter each state
    for state_file in sorted(RAW_DIR.glob("*.json")):
        if state_file.name == "pull_summary.json":
            continue
        
        state_name = state_file.stem.replace("_", " ").title()
        
        with open(state_file) as f:
            records = json.load(f)
        
        stats["total_raw"] += len(records)
        
        kept = []
        state_removed = defaultdict(int)
        
        for r in records:
            should_rm, reason = should_remove(r)
            if should_rm:
                stats["removed"][reason] += 1
                state_removed[reason] += 1
            else:
                # Add quality score
                r["_quality_score"] = calculate_quality_score(r)
                r["_source_state"] = state_name
                kept.append(r)
        
        all_records.extend(kept)
        stats["by_state"][state_name] = {
            "raw": len(records),
            "kept": len(kept),
            "removed": dict(state_removed)
        }
        
        print(f"✅ {state_name}: {len(records)} → {len(kept)} ({len(records) - len(kept)} removed)")
    
    stats["total_after_filter"] = len(all_records)
    
    # Deduplicate across all states
    print(f"\n🔄 Deduplicating {len(all_records)} records...")
    unique_records, dupes = deduplicate(all_records)
    stats["duplicates_removed"] = dupes
    stats["total_clean"] = len(unique_records)
    
    print(f"   Removed {dupes} duplicates")
    print(f"   Final count: {len(unique_records)}")
    
    # Sort by quality score
    unique_records.sort(key=lambda x: x.get("_quality_score", 0), reverse=True)
    
    # Save cleaned data
    output_file = CLEAN_DIR / f"all_providers_{datetime.now().strftime('%Y%m%d')}.json"
    with open(output_file, "w") as f:
        json.dump(unique_records, f, indent=2)
    
    # Save stats
    stats_file = CLEAN_DIR / f"cleaning_stats_{datetime.now().strftime('%Y%m%d')}.json"
    stats["removed"] = dict(stats["removed"])
    with open(stats_file, "w") as f:
        json.dump(stats, f, indent=2)
    
    # Save CSV for easy viewing
    csv_file = CLEAN_DIR / f"all_providers_{datetime.now().strftime('%Y%m%d')}.csv"
    with open(csv_file, "w") as f:
        # Header
        f.write("name,phone,website,city,state,rating,reviews,quality_score\n")
        for r in unique_records:
            name = (r.get("name") or "").replace(",", " ")
            phone = r.get("phone", "")
            website = r.get("website", "")
            city = r.get("city", "")
            state = r.get("state", "")
            rating = r.get("rating", "")
            reviews = r.get("reviews", "")
            quality = r.get("_quality_score", "")
            f.write(f'"{name}","{phone}","{website}","{city}","{state}",{rating},{reviews},{quality}\n')
    
    print(f"\n📊 Cleaning Summary:")
    print(f"   Raw records: {stats['total_raw']}")
    print(f"   After filtering: {stats['total_after_filter']}")
    print(f"   After dedup: {stats['total_clean']}")
    print(f"\n📁 Output files:")
    print(f"   {output_file}")
    print(f"   {csv_file}")
    print(f"   {stats_file}")
    
    return stats


if __name__ == "__main__":
    clean_all()
