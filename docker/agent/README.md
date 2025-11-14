# Agent Container

This directory contains the Dockerfile for the autonomous agent container used by crowd-mcp.

## What's Inside

- **Node.js 20 Alpine** - Lightweight Node.js runtime
- **Git** - Version control system for repository operations
- **OpenCode** - AI-powered autonomous coding agent
- **Isolated Workspaces** - Docker volumes for agent-specific workspaces
- **Git Credentials** - Automatically mounted from host system (read-only)

## Building the Image

```bash
# From the project root
docker build -t crowd-mcp-agent:latest docker/agent/

# Or with a specific tag
docker build -t crowd-mcp-agent:v0.1.0 docker/agent/
```

## Usage

This image is used automatically by the `ContainerManager` when spawning agents via the `spawn_agent` MCP tool. You don't need to run it manually.

The container manager will:

1. Start a container from this image
2. Create isolated Docker volume for agent workspace (if repository specified)
3. Setup Git repository with automatic clone/pull and agent-specific branch
4. Mount Git credentials from host system (if available)
5. Execute the agent's task via OpenCode

## Workspace Modes

### Isolated Workspaces (Recommended)
When a `repository` parameter is provided, agents get:
- **Dedicated Docker Volume** - Complete isolation from other agents
- **Automatic Git Setup** - Clone repository and create agent-specific branch
- **Independent Development** - No file conflicts between agents

### Shared Workspace (Legacy)
When a `workspace` parameter is provided:
- **Shared Directory** - All agents work in the same filesystem
- **Manual Coordination** - Potential for file conflicts
- **Backward Compatibility** - For existing workflows

## Git Integration

The container automatically includes Git support with the following features:

- **Git Installation**: Git is pre-installed in the container
- **Credential Mounting**: Host Git credentials are automatically mounted (read-only)
  - `~/.gitconfig` → `/root/.gitconfig` (user configuration)
  - `~/.git-credentials` → `/root/.git-credentials` (stored credentials)
- **Repository Operations**: Agents can clone repositories using host credentials
- **Security**: Credentials are mounted read-only for security

### Git Setup Requirements

For agents to use Git, ensure your host system has:

```bash
# Git configuration (required)
git config --global user.name "Your Name"
git config --global user.email "your.email@example.com"

# Git credentials store (optional, for private repos)
git config --global credential.helper store
# Then authenticate once to store credentials:
git clone https://github.com/your-private-repo.git
```

## Manual Testing

If you want to test the container manually:

```bash
# Run the container
docker run --rm \
  -e AGENT_ID=test-123 \
  -e TASK="echo hello" \
  -v $(pwd):/workspace \
  crowd-mcp-agent:latest

## Attach to the running container
docker exec -it test-agent sh

## Inside the container, you can run OpenCode
opencode --help

## Container Lifecycle

- **Start**: Container starts with `tail -f /dev/null` to keep it running
- **Task Execution**: OpenCode runs within the container
- **Stop**: Container is stopped and removed by the MCP server when the agent is terminated
```
