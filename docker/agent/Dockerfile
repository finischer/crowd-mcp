FROM node:20-slim

# Install OpenCode globally with npm (more stable than bun)
RUN npm install -g opencode-ai@latest

# Install Git for repository operations
RUN apt-get update && \
    apt-get install -y git && \
    rm -rf /var/lib/apt/lists/*

# Create OpenCode directories to prevent ENOENT errors
RUN mkdir -p /root/.local/share/opencode/bin

WORKDIR /workspace

# Copy entrypoint script
COPY docker/agent/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Start OpenCode via entrypoint
ENTRYPOINT ["/entrypoint.sh"]
