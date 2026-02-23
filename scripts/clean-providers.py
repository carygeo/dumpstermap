#!/usr/bin/env python3
"""
Clean providers.json - Remove businesses not related to dumpster rental
"""
import json
from datetime import datetime

# Categories to KEEP (relevant to dumpster/waste business)
KEEP_CATEGORIES = {
    "Dumpster rental service",
    "Waste management service",
    "Garbage collection service",
    "Junk removal service",
    "Debris removal service",
    "Recycling center",
    "Demolition contractor",
    "Container supplier",
    "Container service",
    "Containers supplier",
    "Garbage dump",
    "Waste transfer station",
    "Sanitation service",
    "Solid waste engineer",
    "Junk dealer",
    "Junkyard",
    "Salvage yard",
    "Scrap metal dealer",
    # Spanish/Portuguese equivalents
    "Empresa de locação de caçambas",
    "Servicio de recolección de basura",
    "Servicio de recogida de basura",
    "Servicio de gestión de residuos",
    "Alquiler de contenedores de basura",
    "Proveedor de contenedores",
    "Empresa de recogida de escombros",
    "Centro de reciclaje",
}

# Load data
with open('data/providers.json', 'r') as f:
    data = json.load(f)

original_count = len(data['providers'])
print(f"Original count: {original_count}")

# Filter providers
cleaned = []
removed_categories = {}

for p in data['providers']:
    cat = p.get('category')
    
    # Keep if category is in our list
    if cat in KEEP_CATEGORIES:
        cleaned.append(p)
    # Keep null categories for manual review later
    elif cat is None:
        cleaned.append(p)
    else:
        # Track what we're removing
        removed_categories[cat] = removed_categories.get(cat, 0) + 1

# Sort by review count (higher = more established), handle None
cleaned.sort(key=lambda x: x.get('reviewCount') or 0, reverse=True)

print(f"Cleaned count: {len(cleaned)}")
print(f"Removed: {original_count - len(cleaned)}")
print(f"\nTop removed categories:")
for cat, count in sorted(removed_categories.items(), key=lambda x: -x[1])[:20]:
    print(f"  {count:4d} - {cat}")

# Backup original
backup_name = f"data/providers-backup-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
with open(backup_name, 'w') as f:
    json.dump(data, f)
print(f"\nBackup saved: {backup_name}")

# Save cleaned data
data['providers'] = cleaned
data['cleaned_at'] = datetime.now().isoformat()
data['original_count'] = original_count
data['removed_count'] = original_count - len(cleaned)

with open('data/providers.json', 'w') as f:
    json.dump(data, f, indent=2)

print(f"\nCleaned data saved to data/providers.json")
print(f"Ready for outreach: {len(cleaned)} providers")
