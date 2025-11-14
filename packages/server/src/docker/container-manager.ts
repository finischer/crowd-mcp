import type Dockerode from "dockerode";
import type { Agent } from "@crowd-mcp/shared";
import { EnvLoader } from "../config/index.js";
import { AgentDefinitionLoader } from "../agent-config/agent-definition-loader.js";
import { ConfigGenerator } from "../agent-config/config-generator.js";
import type { AgentMcpServer } from "../mcp/agent-mcp-server.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface SpawnAgentConfig {
  agentId: string;
  task: string;
  workspace?: string; // Optional for backward compatibility
  repository?: string; // Optional Git repository URL for isolated workspaces
  agentType?: string;
}

export class ContainerManager {
  private envLoader: EnvLoader;
  private agentMcpPort: number;
  private configGenerator: ConfigGenerator;

  constructor(
    private docker: Dockerode,
    private agentMcpServer?: AgentMcpServer,
    agentMcpPort: number = 3100,
  ) {
    this.envLoader = new EnvLoader();
    this.agentMcpPort = agentMcpPort;

    // Initialize agent configuration components
    const loader = new AgentDefinitionLoader();
    this.configGenerator = new ConfigGenerator(loader);
  }

  /**
   * Build Git-related volume binds for mounting host Git credentials and config
   * @param userHome - Path to user home directory
   * @returns Array of Docker volume bind strings
   */
  private buildGitBinds(userHome: string): string[] {
    const gitBinds: string[] = [];
    
    // Mount .gitconfig if it exists (for user name, email, etc.)
    const gitConfigPath = path.join(userHome, '.gitconfig');
    if (fs.existsSync(gitConfigPath)) {
      gitBinds.push(`${gitConfigPath}:/root/.gitconfig:ro`);
    }
    
    // Mount .git-credentials if it exists (for HTTPS credentials)
    const gitCredentialsPath = path.join(userHome, '.git-credentials');
    if (fs.existsSync(gitCredentialsPath)) {
      gitBinds.push(`${gitCredentialsPath}:/root/.git-credentials:ro`);
    }
    
    return gitBinds;
  }

  /**
   * Create a Docker volume for an agent's isolated workspace
   * @param agentId - Unique agent identifier
   * @returns Volume name
   */
  private async createAgentVolume(agentId: string): Promise<string> {
    const volumeName = `agent-${agentId}-workspace`;
    
    try {
      // Check if volume already exists
      const volumes = await this.docker.listVolumes();
      const existingVolume = volumes.Volumes?.find(v => v.Name === volumeName);
      
      if (!existingVolume) {
        await this.docker.createVolume({ Name: volumeName });
        console.log(`📦 Created Docker volume: ${volumeName}`);
      } else {
        console.log(`📦 Using existing Docker volume: ${volumeName}`);
      }
      
      return volumeName;
    } catch (error) {
      throw new Error(`Failed to create volume for agent ${agentId}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Setup Git workspace in the agent volume
   * @param agentId - Unique agent identifier  
   * @param repository - Git repository URL
   * @param volumeName - Docker volume name
   */
  private async setupGitWorkspace(agentId: string, repository: string, volumeName: string): Promise<void> {
    try {
      // Create temporary container to setup git workspace
      const setupContainer = await this.docker.createContainer({
        Image: "crowd-mcp-agent:latest",
        Cmd: ["/bin/sh", "-c", `
          set -e
          cd /workspace
          
          # Check if repository already exists
          if [ -d ".git" ]; then
            echo "📥 Pulling latest changes from repository..."
            git pull origin main || git pull origin master || true
          else
            echo "📥 Cloning repository: ${repository}"
            git clone ${repository} .
          fi
          
          # Create agent-specific branch
          git checkout -b agent-${agentId} || git checkout agent-${agentId}
          echo "🌿 Working on branch: agent-${agentId}"
        `],
        HostConfig: {
          Binds: [
            `${volumeName}:/workspace:rw`,
            ...this.buildGitBinds(os.homedir())
          ]
        }
      });

      await setupContainer.start();
      
      // Wait for setup to complete
      const stream = await setupContainer.logs({
        stdout: true,
        stderr: true,
        follow: true
      });
      
      return new Promise((resolve, reject) => {
        let output = '';
        stream.on('data', (chunk) => {
          output += chunk.toString();
        });
        
        stream.on('end', async () => {
          try {
            await setupContainer.remove();
            console.log(`✅ Git workspace setup completed for agent ${agentId}`);
            console.log(output);
            resolve();
          } catch (error) {
            reject(error);
          }
        });
        
        stream.on('error', reject);
      });
      
    } catch (error) {
      throw new Error(`Failed to setup git workspace for agent ${agentId}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Clean up agent's Docker volume
   * @param agentId - Unique agent identifier
   */
  private async cleanupAgentVolume(agentId: string): Promise<void> {
    const volumeName = `agent-${agentId}-workspace`;
    
    try {
      const volume = this.docker.getVolume(volumeName);
      await volume.remove();
      console.log(`🧹 Cleaned up Docker volume: ${volumeName}`);
    } catch (error) {
      // Volume might not exist or be in use - log but don't fail
      console.log(`⚠️ Could not cleanup volume ${volumeName}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async spawnAgent(config: SpawnAgentConfig): Promise<Agent> {
    // Validate configuration - either workspace or repository must be provided
    if (!config.workspace && !config.repository) {
      throw new Error("Either workspace or repository must be specified");
    }

    // Determine workspace strategy
    const useIsolatedWorkspace = !!config.repository;
    let workspaceBinds: string[];
    let workspacePath: string;

    if (useIsolatedWorkspace) {
      // Create isolated workspace with Git integration
      console.log(`🔨 Creating isolated workspace for agent ${config.agentId} with repository: ${config.repository}`);
      
      const volumeName = await this.createAgentVolume(config.agentId);
      
      try {
        await this.setupGitWorkspace(config.agentId, config.repository!, volumeName);
        workspaceBinds = [`${volumeName}:/workspace:rw`];
        workspacePath = '/workspace'; // Inside container
        console.log(`✅ Isolated workspace ready for agent ${config.agentId}`);
      } catch (error) {
        console.error(`❌ Git workspace setup failed for agent ${config.agentId}:`, error);
        console.log(`🔄 Falling back to empty isolated workspace`);
        workspaceBinds = [`${volumeName}:/workspace:rw`];
        workspacePath = '/workspace';
      }
    } else {
      // Legacy shared workspace mode
      console.log(`📁 Using shared workspace for agent ${config.agentId}: ${config.workspace}`);
      workspaceBinds = [`${config.workspace}:/workspace:rw`];
      workspacePath = config.workspace!;
    }

    // Load environment variables (use workspace path or empty string for isolated)
    const envVars = this.envLoader.loadEnvVars(workspacePath === '/workspace' ? '' : workspacePath);

    // Build Agent MCP Server URL for container
    const agentMcpUrl = `http://host.docker.internal:${this.agentMcpPort}/mcp`;

    // Build container environment variables
    const containerEnv = [
      `AGENT_ID=${config.agentId}`,
      `TASK=${config.task}`,
      `AGENT_MCP_URL=${agentMcpUrl}`,
      `AGENT_TYPE=${config.agentType || "default"}`, // Pass agent name for --agent flag
      ...(config.repository ? [`REPOSITORY=${config.repository}`] : []), // Pass repository URL to container
      ...envVars,
    ];

    // Generate ACP MCP servers (messaging server always included) 
    const acpResult = await this.configGenerator.generateAcpMcpServers(
      config.agentType,
      useIsolatedWorkspace ? '' : workspacePath,
      {
        agentId: config.agentId,
        agentMcpPort: this.agentMcpPort,
      },
    );

    console.log(`📋 Generated ${acpResult.mcpServers.length} MCP servers for agent ${config.agentId}`);

    // No longer need AGENT_CONFIG_BASE64 - ACP handles configuration via session creation

    // Build volume binds - workspace + Git credentials if available
    const binds = [
      ...workspaceBinds,
      ...this.buildGitBinds(os.homedir()),
    ];

    const container = await this.docker.createContainer({
      name: `agent-${config.agentId}`,
      Image: "crowd-mcp-agent:latest",
      Env: containerEnv,
      HostConfig: {
        Binds: binds,
      },
      // Essential flags for ACP stdin communication
      Tty: true,        // Allocate pseudo-TTY for interactive tools
      OpenStdin: true,  // Keep stdin open for ACP communication
      AttachStdin: true, // Attach to stdin at creation time
    });

    await container.start();

    // Create ACP client for the container - this is required for agent functionality
    if (this.agentMcpServer) {
      try {
        await this.agentMcpServer.createACPClient(config.agentId, container.id || "", acpResult.mcpServers);
        console.log(`✅ ACP client created successfully for agent ${config.agentId}`);
      } catch (error) {
        // ACP client creation is required - fail the spawn if it doesn't work
        console.error(`❌ Failed to create ACP client for agent ${config.agentId}:`, error);
        
        // Clean up the container since ACP setup failed
        try {
          await container.remove({ force: true });
          console.log(`🧹 Cleaned up container for failed agent ${config.agentId}`);
        } catch (cleanupError) {
          console.error(`Failed to cleanup container for ${config.agentId}:`, cleanupError);
        }
        
        throw new Error(`Failed to establish ACP session for agent ${config.agentId}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    } else {
      throw new Error("AgentMcpServer not available - cannot create ACP client");
    }

    return {
      id: config.agentId,
      task: config.task,
      containerId: container.id || "",
    };
  }

  /**
   * Cleanup agent resources including Docker volume (for isolated workspaces)
   * @param agentId - Unique agent identifier
   */
  async cleanupAgent(agentId: string): Promise<void> {
    try {
      // Try to clean up the agent's volume if it exists
      await this.cleanupAgentVolume(agentId);
    } catch (error) {
      console.error(`Error during agent cleanup for ${agentId}:`, error);
    }
  }
}
