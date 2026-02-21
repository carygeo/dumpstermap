#!/usr/bin/env python3
"""
DumpsterMap - OutScraper Nationwide Data Pull
Pulls dumpster rental provider data from Google Maps via OutScraper API
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

# Search queries to maximize coverage
QUERIES = [
    "dumpster rental",
    "roll off dumpster rental", 
    "roll off container rental",
    "construction dumpster",
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
        
        # Show progress
        if check_count % 3 == 0:
            print(f"  Status: {status}... ({int(time.time()-start)}s elapsed)")
        
        time.sleep(15)  # Longer wait between checks
    
    print(f"  ⚠️ Timeout after {max_wait}s")
    return {"status": "Timeout", "id": task_id}

def pull_state_data(state: str, output_dir: Path) -> int:
    """Pull all dumpster data for a single state."""
    print(f"\n{'='*50}")
    print(f"Pulling data for: {state}")
    print(f"{'='*50}")
    
    # Build queries for this state
    queries = [f"{q} {state}" for q in QUERIES]
    print(f"Queries: {len(queries)}")
    
    # Submit the search
    result = submit_search(queries, limit=400)
    task_id = result.get("id")
    print(f"Task ID: {task_id}")
    
    if not task_id:
        print(f"Error submitting: {result}")
        return 0
    
    # Wait for results
    data = wait_for_results(task_id)
    
    if data.get("status") != "Success":
        print(f"Failed to get results: {data.get('status')}")
        return 0
    
    # Extract and save results - data is flat list of dicts
    all_results = data.get("data", [])
    
    # Filter to only dict items (skip any nested lists)
    all_results = [r for r in all_results if isinstance(r, dict)]
    
    # Deduplicate by place_id
    seen = set()
    unique_results = []
    for r in all_results:
        place_id = r.get("place_id")
        if place_id and place_id not in seen:
            seen.add(place_id)
            unique_results.append(r)
    
    # Save to file
    state_slug = state.lower().replace(" ", "_")
    output_file = output_dir / f"{state_slug}.json"
    with open(output_file, "w") as f:
        json.dump(unique_results, f, indent=2)
    
    print(f"✅ Saved {len(unique_results)} unique results to {output_file}")
    return len(unique_results)

def pull_nationwide(start_state: str = None):
    """Pull data for all 50 states."""
    output_dir = Path.home() / "dumpstermap" / "data" / "raw"
    output_dir.mkdir(parents=True, exist_ok=True)
    
    # Summary file
    summary_file = output_dir / "pull_summary.json"
    summary = {
        "started": datetime.now().isoformat(),
        "states": {}
    }
    
    # Find starting point
    states_to_process = STATES
    if start_state:
        try:
            idx = [s.lower() for s in STATES].index(start_state.lower())
            states_to_process = STATES[idx:]
            print(f"Starting from: {start_state}")
        except ValueError:
            print(f"State '{start_state}' not found, starting from beginning")
    
    total = 0
    for i, state in enumerate(states_to_process):
        print(f"\n[{i+1}/{len(states_to_process)}] Processing {state}...")
        
        try:
            count = pull_state_data(state, output_dir)
            summary["states"][state] = {
                "count": count,
                "timestamp": datetime.now().isoformat(),
                "status": "success"
            }
            total += count
            
            # Save summary after each state
            with open(summary_file, "w") as f:
                json.dump(summary, f, indent=2)
            
            # Rate limiting - be nice to the API
            if i < len(states_to_process) - 1:
                print("Waiting 5 seconds before next state...")
                time.sleep(5)
                
        except Exception as e:
            print(f"Error processing {state}: {e}")
            summary["states"][state] = {
                "count": 0,
                "timestamp": datetime.now().isoformat(),
                "status": f"error: {str(e)}"
            }
    
    summary["completed"] = datetime.now().isoformat()
    summary["total_records"] = total
    
    with open(summary_file, "w") as f:
        json.dump(summary, f, indent=2)
    
    print(f"\n{'='*50}")
    print(f"COMPLETE: {total} total records across {len(summary['states'])} states")
    print(f"Summary saved to: {summary_file}")
    print(f"{'='*50}")

def quick_test():
    """Test with a single state."""
    output_dir = Path.home() / "dumpstermap" / "data" / "raw"
    output_dir.mkdir(parents=True, exist_ok=True)
    count = pull_state_data("Florida", output_dir)
    print(f"\nTest complete: {count} Florida records")

if __name__ == "__main__":
    import sys
    
    if len(sys.argv) > 1:
        if sys.argv[1] == "test":
            quick_test()
        elif sys.argv[1] == "all":
            start_from = sys.argv[2] if len(sys.argv) > 2 else None
            pull_nationwide(start_from)
        else:
            # Pull specific state
            output_dir = Path.home() / "dumpstermap" / "data" / "raw"
            output_dir.mkdir(parents=True, exist_ok=True)
            pull_state_data(sys.argv[1], output_dir)
    else:
        print("Usage:")
        print("  python outscraper_pull.py test          # Test with Florida")
        print("  python outscraper_pull.py all           # Pull all 50 states")
        print("  python outscraper_pull.py all Texas     # Resume from Texas")
        print("  python outscraper_pull.py California    # Pull single state")
