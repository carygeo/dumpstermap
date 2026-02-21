#!/usr/bin/env python3
"""
DumpsterMap - OutScraper Nationwide Data Pull v2
Enhanced with metro-level queries for better coverage
"""

import requests
import json
import time
import os
from datetime import datetime
from pathlib import Path

API_KEY = "YjdlY2Y4MzU0ZDE4NDRiMzhhMGYyMGZhMjk0NzBlODJ8ZTJiODRkODQxZQ"
BASE_URL = "https://api.outscraper.com/maps/search-v3"
RESULTS_URL = "https://api.outscraper.cloud/requests"

# All 50 US states
STATES = [
    "Alabama", "Alaska", "Arizona", "Arkansas", "California",
    "Colorado", "Connecticut", "Delaware", "Florida", "Georgia",
    "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa",
    "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland",
    "Massachusetts", "Michigan", "Minnesota", "Mississippi", "Missouri",
    "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey",
    "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio",
    "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island", "South Carolina",
    "South Dakota", "Tennessee", "Texas", "Utah", "Vermont",
    "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming"
]

# Major metros for enhanced coverage (top 100+ cities)
MAJOR_METROS = {
    "California": [
        "Los Angeles CA", "San Francisco CA", "San Diego CA", "San Jose CA",
        "Sacramento CA", "Fresno CA", "Oakland CA", "Long Beach CA",
        "Bakersfield CA", "Anaheim CA", "Santa Ana CA", "Riverside CA",
        "Stockton CA", "Irvine CA", "Modesto CA", "San Bernardino CA"
    ],
    "Texas": [
        "Houston TX", "Dallas TX", "San Antonio TX", "Austin TX",
        "Fort Worth TX", "El Paso TX", "Arlington TX", "Corpus Christi TX",
        "Plano TX", "Lubbock TX", "Laredo TX", "Irving TX",
        "Amarillo TX", "McKinney TX", "Frisco TX", "Midland TX"
    ],
    "New York": [
        "New York City NY", "Buffalo NY", "Rochester NY", "Syracuse NY",
        "Albany NY", "Yonkers NY", "New Rochelle NY", "Mount Vernon NY",
        "Schenectady NY", "Utica NY", "Long Island NY", "White Plains NY"
    ],
    "Florida": [
        "Miami FL", "Orlando FL", "Tampa FL", "Jacksonville FL",
        "Fort Lauderdale FL", "St Petersburg FL", "Hialeah FL", "Tallahassee FL",
        "Cape Coral FL", "Fort Myers FL", "Pembroke Pines FL", "Naples FL"
    ],
    "Illinois": [
        "Chicago IL", "Aurora IL", "Naperville IL", "Rockford IL",
        "Joliet IL", "Springfield IL", "Peoria IL", "Elgin IL"
    ],
    "Pennsylvania": [
        "Philadelphia PA", "Pittsburgh PA", "Allentown PA", "Erie PA",
        "Reading PA", "Scranton PA", "Bethlehem PA", "Lancaster PA"
    ],
    "Ohio": [
        "Columbus OH", "Cleveland OH", "Cincinnati OH", "Toledo OH",
        "Akron OH", "Dayton OH", "Parma OH", "Canton OH"
    ],
    "Georgia": [
        "Atlanta GA", "Augusta GA", "Columbus GA", "Savannah GA",
        "Athens GA", "Macon GA", "Sandy Springs GA", "Roswell GA"
    ],
    "North Carolina": [
        "Charlotte NC", "Raleigh NC", "Greensboro NC", "Durham NC",
        "Winston-Salem NC", "Fayetteville NC", "Cary NC", "Wilmington NC"
    ],
    "Michigan": [
        "Detroit MI", "Grand Rapids MI", "Warren MI", "Sterling Heights MI",
        "Ann Arbor MI", "Lansing MI", "Flint MI", "Dearborn MI"
    ],
    "New Jersey": [
        "Newark NJ", "Jersey City NJ", "Paterson NJ", "Elizabeth NJ",
        "Edison NJ", "Woodbridge NJ", "Trenton NJ", "Camden NJ"
    ],
    "Virginia": [
        "Virginia Beach VA", "Norfolk VA", "Chesapeake VA", "Richmond VA",
        "Newport News VA", "Alexandria VA", "Hampton VA", "Roanoke VA"
    ],
    "Washington": [
        "Seattle WA", "Spokane WA", "Tacoma WA", "Vancouver WA",
        "Bellevue WA", "Kent WA", "Everett WA", "Renton WA"
    ],
    "Arizona": [
        "Phoenix AZ", "Tucson AZ", "Mesa AZ", "Chandler AZ",
        "Scottsdale AZ", "Glendale AZ", "Gilbert AZ", "Tempe AZ"
    ],
    "Massachusetts": [
        "Boston MA", "Worcester MA", "Springfield MA", "Cambridge MA",
        "Lowell MA", "Brockton MA", "Quincy MA", "New Bedford MA"
    ],
    "Tennessee": [
        "Nashville TN", "Memphis TN", "Knoxville TN", "Chattanooga TN",
        "Clarksville TN", "Murfreesboro TN", "Franklin TN", "Jackson TN"
    ],
    "Indiana": [
        "Indianapolis IN", "Fort Wayne IN", "Evansville IN", "South Bend IN",
        "Carmel IN", "Fishers IN", "Bloomington IN", "Hammond IN"
    ],
    "Missouri": [
        "Kansas City MO", "St Louis MO", "Springfield MO", "Columbia MO",
        "Independence MO", "Lee's Summit MO", "O'Fallon MO", "St Joseph MO"
    ],
    "Maryland": [
        "Baltimore MD", "Frederick MD", "Rockville MD", "Gaithersburg MD",
        "Bowie MD", "Hagerstown MD", "Annapolis MD", "College Park MD"
    ],
    "Wisconsin": [
        "Milwaukee WI", "Madison WI", "Green Bay WI", "Kenosha WI",
        "Racine WI", "Appleton WI", "Waukesha WI", "Eau Claire WI"
    ],
    "Colorado": [
        "Denver CO", "Colorado Springs CO", "Aurora CO", "Fort Collins CO",
        "Lakewood CO", "Thornton CO", "Arvada CO", "Boulder CO"
    ],
    "Minnesota": [
        "Minneapolis MN", "St Paul MN", "Rochester MN", "Duluth MN",
        "Bloomington MN", "Brooklyn Park MN", "Plymouth MN", "Woodbury MN"
    ],
    "South Carolina": [
        "Charleston SC", "Columbia SC", "North Charleston SC", "Greenville SC",
        "Rock Hill SC", "Mount Pleasant SC", "Spartanburg SC", "Myrtle Beach SC"
    ],
    "Alabama": [
        "Birmingham AL", "Montgomery AL", "Huntsville AL", "Mobile AL",
        "Tuscaloosa AL", "Hoover AL", "Dothan AL", "Auburn AL"
    ],
    "Louisiana": [
        "New Orleans LA", "Baton Rouge LA", "Shreveport LA", "Lafayette LA",
        "Lake Charles LA", "Kenner LA", "Bossier City LA", "Monroe LA"
    ],
    "Kentucky": [
        "Louisville KY", "Lexington KY", "Bowling Green KY", "Owensboro KY",
        "Covington KY", "Richmond KY", "Georgetown KY", "Florence KY"
    ],
    "Oregon": [
        "Portland OR", "Salem OR", "Eugene OR", "Gresham OR",
        "Hillsboro OR", "Beaverton OR", "Bend OR", "Medford OR"
    ],
    "Oklahoma": [
        "Oklahoma City OK", "Tulsa OK", "Norman OK", "Broken Arrow OK",
        "Lawton OK", "Edmond OK", "Moore OK", "Midwest City OK"
    ],
    "Connecticut": [
        "Bridgeport CT", "New Haven CT", "Hartford CT", "Stamford CT",
        "Waterbury CT", "Norwalk CT", "Danbury CT", "New Britain CT"
    ],
    "Nevada": [
        "Las Vegas NV", "Henderson NV", "Reno NV", "North Las Vegas NV",
        "Sparks NV", "Carson City NV", "Elko NV", "Mesquite NV"
    ]
}

# Search queries
QUERIES = [
    "dumpster rental",
    "roll off dumpster",
    "roll off container rental",
    "construction dumpster rental",
    "waste container rental"
]

def submit_search(queries: list, limit: int = 400) -> dict:
    """Submit a search request to OutScraper."""
    headers = {
        "X-API-KEY": API_KEY,
        "Content-Type": "application/json"
    }
    
    payload = {
        "query": queries,
        "limit": limit,
        "language": "en",
        "region": "US",
        "dropDuplicates": True
    }
    
    response = requests.post(BASE_URL, headers=headers, json=payload)
    return response.json()

def check_results(task_id: str) -> dict:
    """Check results of a submitted task."""
    headers = {"X-API-KEY": API_KEY}
    response = requests.get(f"{RESULTS_URL}/{task_id}", headers=headers)
    return response.json()

def wait_for_results(task_id: str, max_wait: int = 600) -> dict:
    """Wait for task completion and return results."""
    start = time.time()
    check_count = 0
    while time.time() - start < max_wait:
        result = check_results(task_id)
        status = result.get("status")
        check_count += 1
        
        if status == "Success":
            print(f"  ✅ Success after {check_count} checks ({int(time.time()-start)}s)")
            return result
        elif status == "Error":
            print(f"  ❌ Error: {result}")
            return result
        
        if check_count % 3 == 0:
            print(f"  ⏳ Status: {status}... ({int(time.time()-start)}s)")
        
        time.sleep(15)
    
    print(f"  ⚠️ Timeout after {max_wait}s")
    return {"status": "Timeout", "id": task_id}

def pull_location_data(location: str, output_dir: Path, existing_place_ids: set) -> tuple:
    """Pull data for a single location. Returns (new_results, all_place_ids)."""
    queries = [f"{q} {location}" for q in QUERIES]
    
    result = submit_search(queries, limit=400)
    task_id = result.get("id")
    
    if not task_id:
        print(f"    Error submitting: {result}")
        return [], existing_place_ids
    
    data = wait_for_results(task_id)
    
    if data.get("status") != "Success":
        return [], existing_place_ids
    
    all_results = data.get("data", [])
    all_results = [r for r in all_results if isinstance(r, dict)]
    
    # Filter out duplicates
    new_results = []
    for r in all_results:
        place_id = r.get("place_id")
        if place_id and place_id not in existing_place_ids:
            existing_place_ids.add(place_id)
            new_results.append(r)
    
    return new_results, existing_place_ids

def pull_state_enhanced(state: str, output_dir: Path) -> int:
    """Pull state data with metro enhancement."""
    print(f"\n{'='*60}")
    print(f"🗺️  {state}")
    print(f"{'='*60}")
    
    all_results = []
    place_ids = set()
    
    # 1. State-level pull
    print(f"\n📍 State-level: {state}")
    state_results, place_ids = pull_location_data(state, output_dir, place_ids)
    all_results.extend(state_results)
    print(f"   Found {len(state_results)} providers")
    
    # 2. Metro-level pulls if available
    metros = MAJOR_METROS.get(state, [])
    if metros:
        print(f"\n🏙️  Metro queries: {len(metros)} cities")
        for i, metro in enumerate(metros):
            print(f"   [{i+1}/{len(metros)}] {metro}...", end=" ", flush=True)
            metro_results, place_ids = pull_location_data(metro, output_dir, place_ids)
            print(f"+{len(metro_results)} new")
            all_results.extend(metro_results)
            time.sleep(3)  # Rate limit
    
    # Save results
    state_slug = state.lower().replace(" ", "_")
    output_file = output_dir / f"{state_slug}.json"
    with open(output_file, "w") as f:
        json.dump(all_results, f, indent=2)
    
    print(f"\n✅ {state}: {len(all_results)} total unique providers")
    return len(all_results)

def pull_nationwide_enhanced(start_state: str = None):
    """Pull all 50 states with metro enhancement."""
    output_dir = Path.home() / "dumpstermap" / "data" / "raw"
    output_dir.mkdir(parents=True, exist_ok=True)
    
    summary_file = output_dir / "pull_summary.json"
    
    # Load existing summary
    if summary_file.exists():
        with open(summary_file) as f:
            summary = json.load(f)
    else:
        summary = {"started": datetime.now().isoformat(), "states": {}}
    
    # Find starting point
    states_to_process = STATES
    if start_state:
        try:
            idx = [s.lower() for s in STATES].index(start_state.lower())
            states_to_process = STATES[idx:]
            print(f"▶️  Resuming from: {start_state}")
        except ValueError:
            print(f"State '{start_state}' not found")
            return
    
    total = sum(s.get("count", 0) for s in summary.get("states", {}).values())
    
    for i, state in enumerate(states_to_process):
        print(f"\n[{i+1}/{len(states_to_process)}] ", end="")
        
        try:
            count = pull_state_enhanced(state, output_dir)
            summary["states"][state] = {
                "count": count,
                "timestamp": datetime.now().isoformat(),
                "status": "success",
                "enhanced": state in MAJOR_METROS
            }
            total += count
            
            # Save summary
            summary["total_records"] = total
            summary["last_updated"] = datetime.now().isoformat()
            with open(summary_file, "w") as f:
                json.dump(summary, f, indent=2)
            
            # Rate limit between states
            if i < len(states_to_process) - 1:
                print("\n⏸️  Waiting 10s before next state...")
                time.sleep(10)
                
        except Exception as e:
            print(f"❌ Error: {e}")
            summary["states"][state] = {
                "count": 0,
                "timestamp": datetime.now().isoformat(),
                "status": f"error: {str(e)}"
            }
            with open(summary_file, "w") as f:
                json.dump(summary, f, indent=2)
    
    summary["completed"] = datetime.now().isoformat()
    with open(summary_file, "w") as f:
        json.dump(summary, f, indent=2)
    
    print(f"\n{'='*60}")
    print(f"🎉 COMPLETE: {total} total providers across {len(summary['states'])} states")
    print(f"{'='*60}")

def repull_state(state: str):
    """Re-pull a single state with metro enhancement."""
    output_dir = Path.home() / "dumpstermap" / "data" / "raw"
    output_dir.mkdir(parents=True, exist_ok=True)
    count = pull_state_enhanced(state, output_dir)
    print(f"\n✅ {state}: {count} providers saved")

if __name__ == "__main__":
    import sys
    
    if len(sys.argv) < 2:
        print("Usage:")
        print("  python outscraper_pull_v2.py all                  # All 50 states")
        print("  python outscraper_pull_v2.py resume Delaware      # Resume from state")
        print("  python outscraper_pull_v2.py repull California    # Re-pull single state")
        sys.exit(1)
    
    cmd = sys.argv[1]
    
    if cmd == "all":
        pull_nationwide_enhanced()
    elif cmd == "resume" and len(sys.argv) > 2:
        pull_nationwide_enhanced(sys.argv[2])
    elif cmd == "repull" and len(sys.argv) > 2:
        repull_state(sys.argv[2])
    else:
        print(f"Unknown command: {cmd}")
