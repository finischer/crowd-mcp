#!/bin/sh
set -e

echo "========================================="
echo "Crowd-MCP Agent Container"
echo "========================================="
echo "Agent ID: ${AGENT_ID}"
echo "Task: ${TASK}"
echo "========================================="

# Check if TASK is provided
if [ -z "$TASK" ]; then
  echo "ERROR: No TASK environment variable provided"
  exec tail -f /dev/null
fi

# Set environment variables to avoid installation issues
export BUN_INSTALL_CACHE_DIR="/tmp/bun-cache"
export NODE_ENV="production"
export NODE_TLS_REJECT_UNAUTHORIZED="0"
export BUN_CONFIG_NO_VERIFY="1"
export OPENCODE_SKIP_PLUGIN_INSTALL="1"  # Skip plugin installation to avoid network issues

# Find OpenCode binary
OPENCODE_BIN=""
if command -v opencode >/dev/null 2>&1; then
  OPENCODE_BIN="opencode"
elif [ -f "$(npm config get prefix)/bin/opencode" ]; then
  OPENCODE_BIN="$(npm config get prefix)/bin/opencode"
else
  echo "ERROR: opencode command not found"
  exit 1
fi

cd /workspace

# Git workspace status check (for isolated workspaces)
if [ -n "$REPOSITORY" ]; then
  echo "========================================="
  echo "Git Workspace Status"
  echo "Repository: $REPOSITORY"
  echo "========================================="
  
  if [ -d ".git" ]; then
    echo "📂 Git repository detected"
    
    # Show current branch
    CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
    echo "🌿 Current branch: $CURRENT_BRANCH"
    
    # Show repository status
    echo "📊 Repository status:"
    git status --porcelain || echo "Unable to get git status"
    
    # Show last commit
    echo "📝 Last commit:"
    git log -1 --oneline 2>/dev/null || echo "Unable to get git log"
  else
    echo "⚠️ No git repository found in workspace"
    echo "This might indicate a git setup issue"
  fi
  echo "========================================="
else
  echo "📁 Using shared workspace (no repository specified)"
fi

echo "Starting OpenCode ACP as PID 1 with preserved stdin..."
echo "Configuration will be provided via ACP session creation"

# Start OpenCode ACP as PID 1 - configuration provided via ACP protocol
exec "$OPENCODE_BIN" acp --print-logs --log-level INFO
