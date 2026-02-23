#!/usr/bin/env python3
"""
Merge Google and Yelp provider data, dedupe, and enrich
"""
import json
from pathlib import Path
from datetime import datetime

def normalize_phone(phone):
    """Normalize phone for matching"""
    if not phone:
        return None
    return ''.join(c for c in phone if c.isdigit())[-10:]

def normalize_name(name):
    """Normalize company name for matching"""
    if not name:
        return None
    return name.lower().strip().replace('llc', '').replace('inc', '').replace(',', '').strip()

def merge_providers():
    google_file = Path('data/providers.json')
    yelp_file = Path('data/yelp-providers.json')
    output_file = Path('data/providers-merged.json')
    
    # Load Google data
    google_providers = []
    if google_file.exists():
        with open(google_file) as f:
            data = json.load(f)
            google_providers = data.get('providers', [])
        print(f"Loaded {len(google_providers)} Google providers")
    
    # Load Yelp data
    yelp_providers = []
    if yelp_file.exists():
        with open(yelp_file) as f:
            data = json.load(f)
            yelp_providers = data.get('providers', [])
        print(f"Loaded {len(yelp_providers)} Yelp providers")
    
    # Build index for deduplication
    phone_index = {}
    name_zip_index = {}
    merged = []
    
    # Add Google providers first (they have better data typically)
    for p in google_providers:
        phone = normalize_phone(p.get('phone'))
        name_zip = f"{normalize_name(p.get('name'))}|{p.get('zip')}"
        
        if phone:
            phone_index[phone] = len(merged)
        if name_zip:
            name_zip_index[name_zip] = len(merged)
        
        # Add source tracking
        p['sources'] = ['google']
        merged.append(p)
    
    # Merge Yelp providers
    new_from_yelp = 0
    enriched = 0
    
    for p in yelp_providers:
        phone = normalize_phone(p.get('phone'))
        name_zip = f"{normalize_name(p.get('name'))}|{p.get('zip')}"
        
        # Check for existing match
        existing_idx = None
        if phone and phone in phone_index:
            existing_idx = phone_index[phone]
        elif name_zip in name_zip_index:
            existing_idx = name_zip_index[name_zip]
        
        if existing_idx is not None:
            # Enrich existing provider with Yelp data
            existing = merged[existing_idx]
            existing['yelp_id'] = p.get('yelp_id')
            existing['yelp_url'] = p.get('yelp_url')
            existing['yelp_rating'] = p.get('yelp_rating')
            existing['yelp_review_count'] = p.get('yelp_review_count')
            existing['price'] = p.get('price')
            existing['transactions'] = p.get('transactions')
            if 'yelp' not in existing.get('sources', []):
                existing['sources'].append('yelp')
            enriched += 1
        else:
            # New provider from Yelp
            p['sources'] = ['yelp']
            merged.append(p)
            
            # Update indexes
            if phone:
                phone_index[phone] = len(merged) - 1
            if name_zip:
                name_zip_index[name_zip] = len(merged) - 1
            
            new_from_yelp += 1
    
    # Save merged data
    output = {
        'merged_at': datetime.now().isoformat(),
        'google_count': len(google_providers),
        'yelp_count': len(yelp_providers),
        'new_from_yelp': new_from_yelp,
        'enriched': enriched,
        'total': len(merged),
        'providers': merged
    }
    
    with open(output_file, 'w') as f:
        json.dump(output, f, indent=2)
    
    print(f"\nMerge complete:")
    print(f"  Google providers: {len(google_providers)}")
    print(f"  Yelp providers: {len(yelp_providers)}")
    print(f"  New from Yelp: {new_from_yelp}")
    print(f"  Enriched with Yelp: {enriched}")
    print(f"  Total merged: {len(merged)}")
    print(f"\nSaved to {output_file}")


if __name__ == '__main__':
    merge_providers()
