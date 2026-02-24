#!/usr/bin/env python3
"""Merge enriched Yelp providers into main providers.json"""

import json
from pathlib import Path

DATA_DIR = Path(__file__).parent.parent / "data"

def load_json(path):
    with open(path) as f:
        return json.load(f)

def save_json(path, data):
    with open(path, 'w') as f:
        json.dump(data, f, indent=2)

def convert_yelp_to_provider(yelp):
    """Convert enriched Yelp provider to main provider schema"""
    return {
        "id": yelp.get("yelp_id", yelp.get("name", "").lower().replace(" ", "-")),
        "name": yelp["name"],
        "slug": yelp["name"].lower().replace(" ", "-").replace("'", ""),
        "city": yelp.get("city", ""),
        "state": yelp.get("state", "FL"),
        "zip": yelp.get("postal_code"),
        "address": yelp.get("address"),
        "phone": yelp.get("phone"),
        "website": yelp.get("website"),
        "lat": yelp.get("latitude"),
        "lng": yelp.get("longitude"),
        "rating": yelp.get("rating"),
        "reviewCount": yelp.get("reviews", 0),
        "photo": yelp.get("photos", [{}])[0].get("url") if isinstance(yelp.get("photos", []), list) and yelp.get("photos") else None,
        "category": "Dumpster rental service",
        "yelp_url": yelp.get("yelp_url"),
        "source": "yelp_sweep",
        "discovery_date": yelp.get("discovery_date"),
        "notes": yelp.get("notes")
    }

def main():
    # Load existing providers
    providers_path = DATA_DIR / "providers.json"
    providers_data = load_json(providers_path)
    existing_providers = providers_data.get("providers", [])
    
    # Create set of existing provider names (normalized)
    existing_names = {p["name"].lower().strip() for p in existing_providers}
    
    print(f"Existing providers: {len(existing_providers)}")
    
    # Load enriched Yelp providers
    enriched_path = DATA_DIR / "yelp_enriched_providers.json"
    if enriched_path.exists():
        enriched_providers = load_json(enriched_path)
        
        added = 0
        for yelp in enriched_providers:
            name_key = yelp["name"].lower().strip()
            if name_key not in existing_names:
                provider = convert_yelp_to_provider(yelp)
                existing_providers.append(provider)
                existing_names.add(name_key)
                added += 1
        
        print(f"Added {added} Florida Yelp providers")
    
    # Load national discoveries and add them
    national_path = DATA_DIR / "yelp_national_discoveries.json"
    if national_path.exists():
        national_providers = load_json(national_path)
        
        added = 0
        for natl in national_providers:
            name_key = natl["name"].lower().strip()
            if name_key not in existing_names:
                # Convert national format to provider schema
                provider = {
                    "id": natl.get("name", "").lower().replace(" ", "-"),
                    "name": natl["name"],
                    "slug": natl["name"].lower().replace(" ", "-").replace("'", ""),
                    "city": natl.get("city", ""),
                    "state": natl.get("state", ""),
                    "zip": None,
                    "address": None,
                    "phone": None,
                    "website": None,
                    "lat": None,
                    "lng": None,
                    "rating": natl.get("yelp_rating"),
                    "reviewCount": natl.get("yelp_reviews", 0),
                    "photo": None,
                    "category": "Dumpster rental service",
                    "yelp_url": natl.get("yelp_url"),
                    "source": "yelp_national_sweep",
                    "discovery_date": natl.get("discovery_date"),
                    "notes": natl.get("notes"),
                    "region": natl.get("region")
                }
                existing_providers.append(provider)
                existing_names.add(name_key)
                added += 1
        
        print(f"Added {added} national Yelp providers")
    
    # Save updated providers
    providers_data["providers"] = existing_providers
    save_json(providers_path, providers_data)
    
    print(f"\nTotal providers now: {len(existing_providers)}")

if __name__ == "__main__":
    main()
