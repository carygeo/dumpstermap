#!/bin/bash
# DumpsterMap Admin CLI
# Usage: ./admin-cli.sh <command> [args]
#
# Commands:
#   status          - Quick health check & stats
#   leads           - Recent leads summary
#   providers       - Provider summary (active, with credits, needing zips)
#   add-credits     - Add credits to provider: add-credits <provider_id> <credits> [reason]
#   search          - Search providers: search <query>
#   zip-coverage    - Show ZIP coverage gaps
#   maintenance     - Run all maintenance tasks
#   errors          - Show recent errors
#   webhooks        - Show recent webhook events
#   test-lead       - Send test lead: test-lead <provider_id> [zip]
#   help            - Show this help

set -e

BASE_URL="${DUMPSTERMAP_URL:-http://localhost:8080}"
ADMIN_KEY="${DUMPSTERMAP_KEY:-dumpstermap2026}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# For remote, use production URL
if [ "$1" = "--remote" ] || [ "$1" = "-r" ]; then
    BASE_URL="https://dumpstermap.fly.dev"
    shift
fi

cmd="${1:-help}"
shift 2>/dev/null || true

case "$cmd" in
    status|s)
        echo -e "${BLUE}=== DumpsterMap Status ===${NC}"
        echo ""
        
        # Health
        HEALTH=$(curl -s "$BASE_URL/api/health")
        STATUS=$(echo "$HEALTH" | jq -r '.status')
        if [ "$STATUS" = "ok" ]; then
            echo -e "Health: ${GREEN}✓ OK${NC}"
        else
            echo -e "Health: ${RED}✗ PROBLEM${NC}"
        fi
        EMAIL=$(echo "$HEALTH" | jq -r '.emailProvider')
        echo "Email: $EMAIL"
        
        # Stats
        echo ""
        STATS=$(curl -s "$BASE_URL/api/admin/stats?key=$ADMIN_KEY")
        echo -e "${BLUE}Leads:${NC} $(echo "$STATS" | jq -r '.leads.total') total, $(echo "$STATS" | jq -r '.leads.today') today"
        echo -e "${BLUE}Providers:${NC} $(echo "$STATS" | jq -r '.providers.active') active, $(echo "$STATS" | jq -r '.providers.withCredits') with credits"
        echo -e "${BLUE}Revenue:${NC} \$$(echo "$STATS" | jq -r '.revenue.total | floor') total, \$$(echo "$STATS" | jq -r '.revenue.today | floor') today"
        echo -e "${BLUE}Credits:${NC} $(echo "$STATS" | jq -r '.credits.outstanding') outstanding"
        ERRORS=$(echo "$STATS" | jq -r '.errors.last24h')
        if [ "$ERRORS" -gt 0 ]; then
            echo -e "${YELLOW}Errors (24h):${NC} $ERRORS"
        fi
        ;;
    
    leads|l)
        echo -e "${BLUE}=== Recent Leads ===${NC}"
        SUMMARY=$(curl -s "$BASE_URL/api/admin/daily-summary?key=$ADMIN_KEY")
        echo ""
        echo "Today: $(echo "$SUMMARY" | jq -r '.leads.total') leads"
        echo "By status:"
        echo "$SUMMARY" | jq -r '.leads.byStatus | to_entries | .[] | "  \(.key): \(.value)"'
        echo ""
        echo "ZIPs requested today:"
        echo "$SUMMARY" | jq -r '.leads.zips | if length > 0 then .[] else "  (none)" end'
        ;;
    
    providers|p)
        echo -e "${BLUE}=== Provider Summary ===${NC}"
        
        # Get activity data
        ACTIVITY=$(curl -s "$BASE_URL/api/admin/provider-activity?key=$ADMIN_KEY&days=7")
        
        echo ""
        echo "Summary:"
        echo "  Active: $(echo "$ACTIVITY" | jq -r '.summary.activeProviders')"
        echo "  With credits: $(echo "$ACTIVITY" | jq -r '.summary.providersWithCredits')"
        echo "  Avg credits: $(echo "$ACTIVITY" | jq -r '.summary.averageCredits')"
        
        echo ""
        echo "Top performers (last 7 days):"
        echo "$ACTIVITY" | jq -r '.topByLeads[:5] | .[] | "  \(.name): \(.recentLeads) leads (\(.credits) credits)"'
        
        # Check for providers needing attention
        NEEDING_ZIPS=$(echo "$ACTIVITY" | jq -r '.highBalanceInactive | length')
        if [ "$NEEDING_ZIPS" -gt 0 ]; then
            echo ""
            echo -e "${YELLOW}⚠️  High balance but inactive:${NC}"
            echo "$ACTIVITY" | jq -r '.highBalanceInactive[:5] | .[] | "  \(.name): \(.credits) credits, \(.leads30d) leads (30d)"'
        fi
        ;;
    
    add-credits|ac)
        PROVIDER_ID="$1"
        CREDITS="$2"
        REASON="${3:-CLI credit add}"
        
        if [ -z "$PROVIDER_ID" ] || [ -z "$CREDITS" ]; then
            echo "Usage: admin-cli.sh add-credits <provider_id> <credits> [reason]"
            exit 1
        fi
        
        echo "Adding $CREDITS credits to provider #$PROVIDER_ID..."
        RESULT=$(curl -s -X POST "$BASE_URL/api/admin/provider/$PROVIDER_ID/credits?key=$ADMIN_KEY" \
            -H "Content-Type: application/json" \
            -d "{\"credits\": $CREDITS, \"reason\": \"$REASON\"}")
        
        if echo "$RESULT" | jq -e '.status == "ok"' >/dev/null 2>&1; then
            echo -e "${GREEN}✓ Success${NC}"
            echo "  Provider: $(echo "$RESULT" | jq -r '.companyName')"
            echo "  New balance: $(echo "$RESULT" | jq -r '.newBalance') credits"
        else
            echo -e "${RED}✗ Failed${NC}"
            echo "$RESULT" | jq -r '.error // .message // .'
        fi
        ;;
    
    search|find)
        QUERY="$1"
        if [ -z "$QUERY" ]; then
            echo "Usage: admin-cli.sh search <query>"
            exit 1
        fi
        
        echo -e "${BLUE}Searching for: $QUERY${NC}"
        RESULTS=$(curl -s "$BASE_URL/api/admin/search-providers?key=$ADMIN_KEY&q=$QUERY")
        COUNT=$(echo "$RESULTS" | jq -r '.count')
        
        if [ "$COUNT" = "0" ]; then
            echo "No providers found"
        else
            echo "Found $COUNT provider(s):"
            echo ""
            echo "$RESULTS" | jq -r '.providers[] | "  #\(.id) \(.company_name)\n      \(.email) | \(.credit_balance) credits | \(.status)"'
        fi
        ;;
    
    zip-coverage|zips)
        echo -e "${BLUE}=== ZIP Coverage Analysis ===${NC}"
        COVERAGE=$(curl -s "$BASE_URL/api/admin/zip-coverage?key=$ADMIN_KEY")
        
        echo ""
        echo "Total ZIPs covered: $(echo "$COVERAGE" | jq -r '.totalZipsCovered')"
        echo "Active providers: $(echo "$COVERAGE" | jq -r '.totalActiveProviders')"
        echo "Providers with credits: $(echo "$COVERAGE" | jq -r '.providersWithCredits')"
        
        GAPS=$(echo "$COVERAGE" | jq -r '.gaps | length')
        if [ "$GAPS" -gt 0 ]; then
            echo ""
            echo -e "${YELLOW}Coverage gaps (ZIPs with leads but no providers):${NC}"
            echo "$COVERAGE" | jq -r '.gaps[:10] | .[] | "  \(.zip): \(.leadCount) lead(s)"'
            if [ "$GAPS" -gt 10 ]; then
                echo "  ... and $((GAPS-10)) more"
            fi
        else
            echo -e "\n${GREEN}✓ No coverage gaps${NC}"
        fi
        ;;
    
    maintenance|maint)
        echo -e "${BLUE}Running maintenance tasks...${NC}"
        RESULT=$(curl -s -X POST "$BASE_URL/api/admin/maintenance?key=$ADMIN_KEY")
        
        echo ""
        echo "$RESULT" | jq -r '.tasks | to_entries | .[] | (if .value.success then "✓" else "✗" end) + " " + .key + ": " + (if .value.success then (.value | del(.success) | to_entries | map("\(.key)=\(.value)") | join(", ") // "done") else .value.error end)'
        ;;
    
    errors|e)
        HOURS="${1:-24}"
        echo -e "${BLUE}=== Errors (last ${HOURS}h) ===${NC}"
        ERRORS=$(curl -s "$BASE_URL/api/admin/errors?key=$ADMIN_KEY&hours=$HOURS")
        COUNT=$(echo "$ERRORS" | jq -r '.count')
        
        if [ "$COUNT" = "0" ]; then
            echo -e "${GREEN}No errors!${NC}"
        else
            echo "Found $COUNT error(s):"
            echo ""
            echo "$ERRORS" | jq -r '.errors[:10] | .[] | "[\(.timestamp | split("T")[1] | split(".")[0])] \(.type): \(.message)"'
        fi
        ;;
    
    webhooks|wh)
        echo -e "${BLUE}=== Recent Webhooks ===${NC}"
        WH=$(curl -s "$BASE_URL/api/admin/webhook-log?key=$ADMIN_KEY&limit=10")
        COUNT=$(echo "$WH" | jq -r '.count')
        
        if [ "$COUNT" = "0" ]; then
            echo "No webhook events recorded"
        else
            echo "Last $COUNT events:"
            echo ""
            echo "$WH" | jq -r '.events[:10] | .[] | "[\(.processedAt | split("T")[1] | split(".")[0])] \(.eventType) - \(if .result.processed then "✓" else "⊘" end)"'
        fi
        ;;
    
    test-lead|tl)
        PROVIDER_ID="$1"
        ZIP="${2:-34102}"
        
        if [ -z "$PROVIDER_ID" ]; then
            echo "Usage: admin-cli.sh test-lead <provider_id> [zip]"
            exit 1
        fi
        
        echo "Sending test lead to provider #$PROVIDER_ID (ZIP: $ZIP)..."
        RESULT=$(curl -s -X POST "$BASE_URL/api/admin/send-test-lead?key=$ADMIN_KEY" \
            -H "Content-Type: application/json" \
            -d "{\"provider_id\": $PROVIDER_ID, \"zip\": \"$ZIP\"}")
        
        if echo "$RESULT" | jq -e '.success' >/dev/null 2>&1; then
            echo -e "${GREEN}✓ Test lead sent${NC}"
            echo "  Provider: $(echo "$RESULT" | jq -r '.provider')"
            echo "  Email type: $(echo "$RESULT" | jq -r '.emailType')"
            echo "  Note: $(echo "$RESULT" | jq -r '.note')"
        else
            echo -e "${RED}✗ Failed${NC}"
            echo "$RESULT" | jq -r '.error // .'
        fi
        ;;
    
    help|h|*)
        echo "DumpsterMap Admin CLI"
        echo ""
        echo "Usage: ./admin-cli.sh [--remote|-r] <command> [args]"
        echo ""
        echo "Commands:"
        echo "  status, s          Quick health check & stats"
        echo "  leads, l           Recent leads summary"
        echo "  providers, p       Provider summary & activity"
        echo "  add-credits, ac    Add credits: add-credits <id> <credits> [reason]"
        echo "  search, find       Search providers: search <query>"
        echo "  zip-coverage, zips ZIP coverage analysis"
        echo "  maintenance, maint Run all maintenance tasks"
        echo "  errors, e          Show recent errors: errors [hours=24]"
        echo "  webhooks, wh       Show recent webhook events"
        echo "  test-lead, tl      Send test lead: test-lead <id> [zip]"
        echo ""
        echo "Options:"
        echo "  --remote, -r       Use production URL (dumpstermap.fly.dev)"
        echo ""
        echo "Environment:"
        echo "  DUMPSTERMAP_URL    Base URL (default: http://localhost:8080)"
        echo "  DUMPSTERMAP_KEY    Admin key (default: dumpstermap2026)"
        ;;
esac
