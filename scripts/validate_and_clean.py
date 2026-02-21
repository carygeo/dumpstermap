#!/usr/bin/env python3
"""
DumpsterMap - Data Cleaning & Validation Pipeline
Cleans raw OutScraper data and validates websites are active.
"""

import json
import re
import asyncio
import aiohttp
from pathlib import Path
from datetime import datetime
from collections import defaultdict
from urllib.parse import urlparse
import sys

RAW_DIR = Path.home() / "dumpstermap" / "data" / "raw"
CLEAN_DIR = Path.home() / "dumpstermap" / "data" / "cleaned"
VALIDATED_DIR = Path.home() / "dumpstermap" / "data" / "validated"

# Removal criteria
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


def should_remove(record: dict) -> tuple:
    """Check if record should be removed."""
    name = (record.get("name") or "").lower()
    category = (record.get("category") or "").lower()
    status = record.get("business_status", "")
    
    if not record.get("name"):
        return True, "missing_name"
    if not record.get("phone") and not record.get("website"):
        return True, "missing_contact"
    if not record.get("address"):
        return True, "missing_address"
    
    if status == "CLOSED_PERMANENTLY":
        return True, "closed_permanently"
    
    for bb in BIG_BOX_RETAILERS:
        if bb in name:
            return True, f"big_box:{bb}"
    
    for nwc in NATIONAL_WASTE_COMPANIES:
        if nwc in name:
            return True, f"national_chain:{nwc}"
    
    if "junk removal" in category and "dumpster" not in category:
        for kw in JUNK_REMOVAL_ONLY_KEYWORDS:
            if kw in name:
                return True, f"junk_only:{kw}"
    
    for kw in NON_DUMPSTER_KEYWORDS:
        if kw in name or kw in category:
            return True, f"non_dumpster:{kw}"
    
    return False, "keep"


def normalize_phone(phone: str) -> str:
    if not phone:
        return ""
    digits = re.sub(r'\D', '', phone)
    if len(digits) == 11 and digits.startswith('1'):
        digits = digits[1:]
    return digits


def normalize_address(address: str) -> str:
    if not address:
        return ""
    addr = address.lower().strip()
    addr = re.sub(r'\bst\b', 'street', addr)
    addr = re.sub(r'\brd\b', 'road', addr)
    addr = re.sub(r'\bave\b', 'avenue', addr)
    addr = re.sub(r'\s+', ' ', addr)
    return addr


def deduplicate(records: list) -> tuple:
    """Deduplicate by phone, address, or website domain."""
    seen_phones = {}
    seen_addresses = {}
    seen_websites = {}
    unique = []
    dupes = 0
    
    for r in records:
        is_dupe = False
        
        phone = normalize_phone(r.get("phone", ""))
        if phone and len(phone) == 10:
            if phone in seen_phones:
                is_dupe = True
            else:
                seen_phones[phone] = r.get("place_id")
        
        if not is_dupe:
            addr = normalize_address(r.get("address", ""))
            if addr and len(addr) > 15:
                if addr in seen_addresses:
                    is_dupe = True
                else:
                    seen_addresses[addr] = r.get("place_id")
        
        if not is_dupe:
            website = r.get("website", "")
            if website:
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
    """Calculate data quality score 0-1."""
    score = 0.0
    max_score = 0.0
    
    if record.get("name"): score += 1
    if record.get("phone"): score += 1
    if record.get("address"): score += 1
    if record.get("website"): score += 1
    max_score += 4
    
    if record.get("verified"): score += 1
    if record.get("business_status") == "OPERATIONAL": score += 0.5
    max_score += 1.5
    
    reviews = record.get("reviews", 0) or 0
    if reviews >= 50: score += 1
    elif reviews >= 20: score += 0.7
    elif reviews >= 5: score += 0.4
    elif reviews >= 1: score += 0.2
    max_score += 1
    
    rating = record.get("rating", 0) or 0
    if rating >= 4.5: score += 1
    elif rating >= 4.0: score += 0.7
    elif rating >= 3.5: score += 0.4
    max_score += 1
    
    photos = record.get("photos_count", 0) or 0
    if photos >= 10: score += 1
    elif photos >= 5: score += 0.6
    elif photos >= 1: score += 0.3
    max_score += 1
    
    return round(score / max_score, 2)


async def check_website(session: aiohttp.ClientSession, url: str, timeout: int = 10) -> dict:
    """Check if a website is reachable."""
    if not url:
        return {"url": url, "status": "no_url", "reachable": False}
    
    # Clean URL
    if not url.startswith("http"):
        url = "https://" + url
    
    try:
        async with session.head(url, timeout=aiohttp.ClientTimeout(total=timeout), allow_redirects=True) as resp:
            return {
                "url": url,
                "status": resp.status,
                "reachable": resp.status < 400,
                "final_url": str(resp.url)
            }
    except asyncio.TimeoutError:
        return {"url": url, "status": "timeout", "reachable": False}
    except aiohttp.ClientError as e:
        return {"url": url, "status": f"error:{type(e).__name__}", "reachable": False}
    except Exception as e:
        return {"url": url, "status": f"error:{type(e).__name__}", "reachable": False}


async def validate_websites(records: list, concurrency: int = 50) -> list:
    """Validate websites in parallel."""
    semaphore = asyncio.Semaphore(concurrency)
    
    async def bounded_check(session, record):
        async with semaphore:
            url = record.get("website", "")
            result = await check_website(session, url)
            record["_website_check"] = result
            return record
    
    connector = aiohttp.TCPConnector(limit=concurrency, force_close=True)
    async with aiohttp.ClientSession(connector=connector) as session:
        tasks = [bounded_check(session, r) for r in records]
        validated = []
        total = len(tasks)
        
        for i, task in enumerate(asyncio.as_completed(tasks)):
            result = await task
            validated.append(result)
            if (i + 1) % 100 == 0 or i + 1 == total:
                print(f"  Validated {i + 1}/{total} websites...")
        
        return validated


def clean_all():
    """Run full cleaning pipeline."""
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
    
    print("=" * 60)
    print("PHASE 1: Loading and filtering raw data")
    print("=" * 60)
    
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
                r["_quality_score"] = calculate_quality_score(r)
                r["_source_state"] = state_name
                kept.append(r)
        
        all_records.extend(kept)
        stats["by_state"][state_name] = {
            "raw": len(records),
            "kept": len(kept),
            "removed": dict(state_removed)
        }
        
        print(f"  ✅ {state_name}: {len(records)} → {len(kept)}")
    
    stats["total_after_filter"] = len(all_records)
    
    print(f"\n📊 After filtering: {stats['total_after_filter']} records")
    
    print("\n" + "=" * 60)
    print("PHASE 2: Deduplicating across states")
    print("=" * 60)
    
    unique_records, dupes = deduplicate(all_records)
    stats["duplicates_removed"] = dupes
    stats["total_clean"] = len(unique_records)
    
    print(f"  Removed {dupes} duplicates")
    print(f"  📊 After dedup: {len(unique_records)} records")
    
    # Sort by quality
    unique_records.sort(key=lambda x: x.get("_quality_score", 0), reverse=True)
    
    # Save cleaned data
    output_file = CLEAN_DIR / f"all_providers_{datetime.now().strftime('%Y%m%d_%H%M')}.json"
    with open(output_file, "w") as f:
        json.dump(unique_records, f, indent=2)
    
    # Save stats
    stats_file = CLEAN_DIR / f"cleaning_stats_{datetime.now().strftime('%Y%m%d_%H%M')}.json"
    stats["removed"] = dict(stats["removed"])
    with open(stats_file, "w") as f:
        json.dump(stats, f, indent=2)
    
    print(f"\n💾 Saved to {output_file}")
    
    return unique_records, stats


async def validate_all(records: list):
    """Validate websites for all records."""
    VALIDATED_DIR.mkdir(parents=True, exist_ok=True)
    
    print("\n" + "=" * 60)
    print("PHASE 3: Validating websites")
    print("=" * 60)
    
    # Only validate records with websites
    with_websites = [r for r in records if r.get("website")]
    print(f"  {len(with_websites)}/{len(records)} have websites to check")
    
    validated = await validate_websites(with_websites)
    
    # Count results
    reachable = sum(1 for r in validated if r.get("_website_check", {}).get("reachable"))
    unreachable = len(validated) - reachable
    
    print(f"\n📊 Website validation results:")
    print(f"  ✅ Reachable: {reachable}")
    print(f"  ❌ Unreachable: {unreachable}")
    
    # Merge back with records without websites
    without_websites = [r for r in records if not r.get("website")]
    all_validated = validated + without_websites
    
    # Sort by quality
    all_validated.sort(key=lambda x: x.get("_quality_score", 0), reverse=True)
    
    # Save validated data
    output_file = VALIDATED_DIR / f"validated_providers_{datetime.now().strftime('%Y%m%d_%H%M')}.json"
    with open(output_file, "w") as f:
        json.dump(all_validated, f, indent=2)
    
    # Save CSV for easy viewing
    csv_file = VALIDATED_DIR / f"validated_providers_{datetime.now().strftime('%Y%m%d_%H%M')}.csv"
    with open(csv_file, "w") as f:
        f.write("name,phone,website,website_status,city,state,rating,reviews,quality_score\n")
        for r in all_validated:
            name = (r.get("name") or "").replace(",", " ").replace('"', "'")
            phone = r.get("phone", "")
            website = r.get("website", "")
            ws = r.get("_website_check", {})
            website_status = "reachable" if ws.get("reachable") else ws.get("status", "no_url")
            city = r.get("city", "")
            state = r.get("state", "")
            rating = r.get("rating", "")
            reviews = r.get("reviews", "")
            quality = r.get("_quality_score", "")
            f.write(f'"{name}","{phone}","{website}","{website_status}","{city}","{state}",{rating},{reviews},{quality}\n')
    
    print(f"\n💾 Saved to:")
    print(f"  {output_file}")
    print(f"  {csv_file}")
    
    return all_validated


async def main():
    print("\n" + "=" * 60)
    print("🗺️  DUMPSTERMAP DATA CLEANING & VALIDATION")
    print("=" * 60 + "\n")
    
    # Phase 1 & 2: Clean
    cleaned, stats = clean_all()
    
    # Phase 3: Validate
    validated = await validate_all(cleaned)
    
    # Final summary
    print("\n" + "=" * 60)
    print("📊 FINAL SUMMARY")
    print("=" * 60)
    print(f"  Raw records:      {stats['total_raw']:,}")
    print(f"  After filtering:  {stats['total_after_filter']:,}")
    print(f"  After dedup:      {stats['total_clean']:,}")
    print(f"  Validated:        {len(validated):,}")
    
    ws_reachable = sum(1 for r in validated if r.get("_website_check", {}).get("reachable"))
    print(f"  Websites OK:      {ws_reachable:,}")
    print("=" * 60 + "\n")


if __name__ == "__main__":
    asyncio.run(main())
