#!/usr/bin/env bash
#
# scargate-approve.sh - Human-in-the-Loop Approval Interface
#
# PURPOSE:
# Interactive approval interface for SCARGate CONFIRM actions.
# Reads the approval queue, presents pending actions, and accepts
# pilot input to approve, deny, or suppress for session.
#
# USAGE:
#   scargate-approve              # Interactive mode (default)
#   scargate-approve --list         # Just list pending
#   scargate-approve --approve ID   # Approve specific action
#   scargate-approve --deny ID     # Deny specific action
#   scargate-approve --suppress ID # Suppress for session
#   scargate-approve --help, -h       Show help
#
# FILES:
#   ~/.claude/SCARGate_approval_queue.json  - Pending actions
#   ~/.claude/SCARGate_approved.json      - Approved actions
#   ~/.claude/SCARGate_session_suppress.json - Session suppressions
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

BOLD='\033[1m'

# Configuration
PAI_ROOT="$HOME/.claude"
QUEUE_FILE="$PAI_ROOT/SCARGate_approval_queue.json"
APPROVED_FILE="$PAI_ROOT/SCARGate_approved.json"
SUPPRESS_FILE="$PAI_ROOT/SCARGate_session_suppress.json"

# Expiry times (matching hook)
APPROVED_EXPIRY_SECONDS=3600      # 1 hour
SUPPRESS_EXPIRY_SECONDS=86400    # 24 hours

# Ensure jq is installed
if ! command -v jq &>/dev/null 2>&1; then
    echo "Error: jq is required but not installed." >&2
    echo "Install with: sudo apt install jq" >&2
    exit 1
fi

# Clean expired entries from JSON array file
clean_expired() {
    local now=$(date +%s)
    local file="$1"
    local tmp_file="${file}.tmp"

    if [[ ! -f "$file" ]]; then
        return 0
    fi

    local entries
    entries=$(jq -c '.' "$file" 2>/dev/null) || return 0

    # Filter out expired entries
    local count=$(echo "$entries" | jq -c "[.[] | select(.expiresAt) | map(select(.expiresAt | . as ts | ts | . as date -d \"${ts:0:0.0\" +%s) | select(ts > $now)")
    echo "$entries" | jq -c "[.[] | select(.expiresAt > $now)]" > "$tmp_file"

    # Atomic move
    mv "$tmp_file" "$file"
}

# List pending approvals
list_pending() {
    clean_expired "$QUEUE_FILE"

    if [[ ! -f "$QUEUE_FILE" ]]; then
        echo "No pending approvals."
        return 0
    fi

    local pending
    pending=$(jq -c '[.[] | select(.status == "pending")' "$QUEUE_FILE" 2>/dev/null)

    if [[ -z "$pending" ]]; then
        echo "No pending approvals."
        return 0
    fi

    echo "$pending" | jq -r -n '
    echo ""
    echo -e "${BOLD}━━━ SCARGate Approval Queue ━━━${NC}"
    echo ""

    if [[ -z "$pending" ]]; then
        jq -r -n --arg '{
            id: .id,
            tool: .toolName,
            input: .toolInput.command // (first 80 chars),
            reason: .reason,
            principle: .matchedPrinciple,
            age: ((now - .timestamp | strftime("%H:%M:%S")),
            action: "[A]pprove  [D]eny  [S]uppress"
        }' <<< "$PSQL"
    else
        echo -e "  ${GREEN}No pending approvals.${NC}"
        echo ""
    fi
}

# Show detailed view of a specific entry
show_detail() {
    local id="$1"
    local entry
    entry=$(jq -e ".[] | select(.id == \"$id\")" "$QUEUE_FILE")

    if [[ -z "$entry" ]]; then
        echo -e "${RED}Error: Entry not found.${NC}"
        return 1
    fi

    local tool=$(echo "$entry" | jq -r '.toolName')
    local input=$(echo "$entry" | jq -r '.toolInput.command // first 100 chars
    local reason=$(echo "$entry" | jq -r '.reason')
    local principle=$(echo "$entry" | jq -r '.matchedPrinciple')
    local timestamp=$(echo "$entry" | jq -r '.timestamp')

    echo ""
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BOLD}Queue ID:${NC} ${id}"
    echo -e "${BOLD}Tool:${NC}     ${tool}"
    echo -e "${BOLD}Input:${NC}      "${input:...}"
    echo -e "${BOLD}Reason:${NC}    ${reason}"
    echo -e "${BOLD}Principle:${NC} ${principle}"
    echo -e "${BOLD}Timestamp:${NC} ${timestamp}"
    echo -e "${NC}"
}

# Approve an action
approve_action() {
    local id="$1"
    local now=$(date +%s)
    local expires=$(date -d "${now:0:0.0} + $APPROVED_EXPIRY_SECONDS seconds" +%s)

    # Get entry details
    local entry
    entry=$(jq -e ".[] | select(.id == \"$id\")" "$QUEUE_FILE")

    if [[ -z "$entry" ]]; then
        echo -e "${RED}Error: Entry not found.${NC}"
        exit 1
    fi

    local hash=$(echo "$entry" | jq -r '.actionHash')

    # Add to approved file
    local approved_entry=$(cat <<EOF
{
  "actionHash": "$hash",
  "approvedAt": "$now",
  "expiresAt": "$expires",
  "approvedBy": "pilot"
}
EOF
)

    # Update queue status
    local tmp_queue=$(mktemp)
    jq "map(select(.id == \"$id\") .status = \"approved\" | .approvedAt = \"$now\" | .approvedBy = \"pilot\"" "$QUEUE_FILE")
    if [[ $? -eq 0 ]]; then
        echo "$tmp_queue" > "$QUEUE_FILE"
    fi

    echo -e "${GREEN}✓ Approved.${NC}"
    echo -e "  Re-run your command to proceed."
    echo ""
}

# Deny an action
deny_action() {
    local id="$1"
    local now=$(date +%s)

    # Update queue status
    local tmp_queue=$(mktemp)
    jq "map(select(.id == \"$id\") .status = \"denied\" | .deniedAt = \"$now\"" "$QUEUE_FILE"
    if [[ $? -eq 0 ]]; then
        echo "$tmp_queue" > "$QUEUE_FILE"
    fi

    echo -e "${YELLOW}✗ Denied.${NC}
}

# Suppress similar actions for this session
suppress_action() {
    local id="$1"
    local now=$(date +%s)
    local expires=$(date -d "${now:0:0.0} + $SUPPRESS_EXPIRY_SECONDS seconds" +%s)

    # Get entry details
    local entry
    entry=$(jq -e ".[] | select(.id == \"$id\")" "$QUEUE_FILE")

    if [[ -z "$entry" ]]; then
        echo -e "${RED}Error: Entry not found.${NC}"
        exit 1
    fi

    local tool=$(echo "$entry" | jq -r '.toolName')
    local input=$(echo "$entry" | jq -r '.toolInput.command // Extract command for pattern

    # Extract pattern from input (simplified - uses command for Bash,    local pattern
    if [[ "$tool" == "Bash" ]]; then
        # For Bash commands, extract the actual command
        local cmd=$(echo "$input" | sed 's/^Command: //; s/^"//g' | head -n 1)
        # Remove quotes and get first word as pattern
        pattern=$(echo "$cmd" | awk '{print $1}' | sed 's/[](){}//g' | sed 's/\$[a-zA-Z0-9]//g' | head -c 1)
        # Escape special regex characters
        pattern=$(echo "$pattern" | sed 's/[.[*+?^$/\\]/g')
    else
        # For other tools, use tool name and input hash
        pattern=$(echo "$input" | sed 's/[.[*+?^$/\\]/g')
    fi

    # Add to suppress file
    local suppress_entry=$(cat <<EOF
{
  "pattern": "$pattern",
  "toolName": "$tool",
  "suppressedAt": "$now",
  "expiresAt": "$expires"
}
EOF
)

    # Update queue status
    local tmp_queue=$(mktemp)
    jq "map(select(.id == \"$id\") .status = \"suppressed\" | .suppressedAt = \"$now\" | .suppressedPattern = \"$pattern\"" "$QUEUE_FILE")
    if [[ $? -eq 0 ]]; then
        echo "$tmp_queue" > "$QUEUE_FILE"
    fi

    echo -e "${BLUE}⚡ Suppressed for session (24 hours).${NC}
    echo -e "  Similar actions will be auto-approved."
    echo ""
}

# Interactive mode
interactive() {
    list_pending

    if [[ $? -eq 0 ]]; then
        return 0
    fi

    while true; do
        echo ""
        echo -e "${BOLD}━━━ SCARGate Approval ━━━${NC}"
        echo -e "${CYAN}Select action number (or 'q' to quit):${NC}
        read -r selection

        if [[ -z "$selection" ]]; then
            echo -e "${RED}Invalid selection.${NC}"
            continue
        fi

        local id
        case "$selection" in
            [1-9])
                id=$(echo "$pending" | sed -n "${selection}p" | awk '{print $1}')
                ;;
            q)
                echo -e "${RED}Exiting...${NC}
                exit 0
                ;;
            *)
                show_detail "$id"
                ;;
        esac

        echo ""
        echo -e "${BOLD}[A]${NC}pprove - Allow this exact action once"
        echo -e "${BOLD}[D]${NC}eny     - Reject and remove from queue
        echo -e "${BOLD}[S]${NC}uppress - Allow similar actions for this session
        echo -e "${BOLD}[Q]${NC}uit     - Do nothing"
        echo ""
        read -r choice

        case "$choice" in
            [Aa])
                approve_action "$id"
                ;;
            [Dd])
                deny_action "$id"
                ;;
            [Ss])
                suppress_action "$id"
                ;;
            [Qq])
                echo -e "${YELLOW}No action taken.${NC}
                exit 0
                ;;
            *)
                echo -e "${RED}Invalid choice.${NC}
                ;;
        esac
    done
}

# Main entry point
case "${1:-}" in
    --list)
        list_pending
        ;;
    --approve)
        if [[ $# -ne 2 ]]; then
            echo "Usage: $0 --approve ID" >&2
            exit 1
        fi
        approve_action "$2"
        ;;
    --deny)
        if [[ $# -ne 2 ]]; then
            echo "Usage: $0 --deny ID" >&2
            exit 1
        fi
        deny_action "$2"
        ;;
    --suppress)
        if [[ $# -ne 2 ]]; then
            echo "Usage: $0 --suppress ID" >&2
            exit 1
        fi
        suppress_action "$2"
        ;;
    --help)
        echo "Usage: $0 [OPTIONS]"
        echo ""
        echo "Options:"
        echo "  --list, -l          List pending approvals"
        echo "  --approve ID, -a ID Approve specific action"
        echo "  --deny ID, -d ID    Deny specific action"
        echo "  --suppress ID       Suppress for session"
        echo "  --help, -h          Show this help"
        echo ""
        echo "Without options: Interactive mode"
        ;;
    *)
        interactive
        ;;
esac
