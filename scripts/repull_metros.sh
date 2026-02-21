#!/bin/bash
# Repull states that need metro enhancement

cd ~/dumpstermap
source .venv/bin/activate

STATES=(
    "Texas"
    "Washington"
    "Louisiana"
    "Oregon"
    "Nevada"
    "Arizona"
    "Alabama"
    "Oklahoma"
    "North Carolina"
    "New York"
    "Tennessee"
    "Kentucky"
    "Illinois"
    "Colorado"
)

for state in "${STATES[@]}"; do
    echo ""
    echo "========================================"
    echo "🔄 Repulling: $state"
    echo "========================================"
    python scripts/outscraper_pull_v2.py repull "$state"
    echo "✅ $state complete"
    sleep 5
done

echo ""
echo "========================================"
echo "🎉 All 14 metro repulls complete!"
echo "========================================"
