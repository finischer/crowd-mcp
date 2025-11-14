import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { ContainerManager } from "./container-manager.js";
import type { AgentMcpServer } from "../mcp/agent-mcp-server.js";

// Mock Docker
const mockContainer = {
  id: "container-123",
  start: vi.fn().mockResolvedValue(undefined),
  remove: vi.fn().mockResolvedValue(undefined),
};

const mockDocker = {
  createContainer: vi.fn().mockResolvedValue(mockContainer),
};

// Mock AgentMcpServer
const mockAgentMcpServer = {
  createACPClient: vi.fn().mockResolvedValue(undefined),
} as unknown as AgentMcpServer;

describe("ContainerManager - ACP Integration", () => {
  let tempDir: string;
  let containerManager: ContainerManager;

  beforeEach(async () => {
    // Create temporary directory for test
    tempDir = join(tmpdir(), `crowd-mcp-container-acp-test-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });

    // Create .crowd/agents directory
    const agentsDir = join(tempDir, ".crowd", "agents");
    await mkdir(agentsDir, { recursive: true });

    // Reset mocks
    vi.clearAllMocks();

    // Initialize ContainerManager
    containerManager = new ContainerManager(
      mockDocker as any,
      mockAgentMcpServer,
      3100,
    );
  });

  afterEach(async () => {
    // Clean up temporary directory
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("spawnAgent with ACP MCP servers", () => {
    it("should pass ACP MCP servers to AgentMcpServer.createACPClient", async () => {
      // Create agent definition with MCP servers
      const agentPath = join(tempDir, ".crowd", "agents", "test-agent.yaml");
      await writeFile(
        agentPath,
        `name: test-agent
systemPrompt: Test agent
mcpServers:
  filesystem:
    type: stdio
    command: npx
    args:
      - "@modelcontextprotocol/server-filesystem"
`,
      );

      await containerManager.spawnAgent({
        agentId: "test-agent-1",
        task: "Test task",
        workspace: tempDir,
        agentType: "test-agent",
      });

      // Verify container was created
      expect(mockDocker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "agent-test-agent-1",
          Image: "crowd-mcp-agent:latest",
          Env: expect.arrayContaining([
            "AGENT_ID=test-agent-1",
            "TASK=Test task",
            "AGENT_MCP_URL=http://host.docker.internal:3100/mcp",
            "AGENT_TYPE=test-agent",
          ]),
          HostConfig: {
            Binds: [`${tempDir}:/workspace:rw`],
          },
          Tty: true,
          OpenStdin: true,
          AttachStdin: true,
        }),
      );

      // Verify ACP client was created with MCP servers
      expect(mockAgentMcpServer.createACPClient).toHaveBeenCalledWith(
        "test-agent-1",
        "container-123",
        expect.arrayContaining([
          // Messaging server (always included)
          expect.objectContaining({
            name: "messaging",
            type: "http",
            url: "http://host.docker.internal:3100/mcp",
          }),
          // Filesystem server from agent definition
          expect.objectContaining({
            name: "filesystem",
            command: "npx",
            args: ["@modelcontextprotocol/server-filesystem"],
          }),
        ]),
      );
    });

    it("should pass only messaging server when no agent type specified", async () => {
      await containerManager.spawnAgent({
        agentId: "default-agent",
        task: "Default task",
        workspace: tempDir,
        // No agentType specified
      });

      // Verify ACP client was created with only messaging server
      expect(mockAgentMcpServer.createACPClient).toHaveBeenCalledWith(
        "default-agent",
        "container-123",
        expect.arrayContaining([
          expect.objectContaining({
            name: "messaging",
            type: "http",
            url: "http://host.docker.internal:3100/mcp",
          }),
        ]),
      );

      // Should have exactly 1 MCP server (messaging only)
      const mcpServers = (mockAgentMcpServer.createACPClient as any).mock.calls[0][2];
      expect(mcpServers).toHaveLength(1);
    });

    it("should pass only messaging server when agent definition not found", async () => {
      await containerManager.spawnAgent({
        agentId: "nonexistent-agent",
        task: "Test task",
        workspace: tempDir,
        agentType: "nonexistent",
      });

      // Verify ACP client was created with only messaging server
      expect(mockAgentMcpServer.createACPClient).toHaveBeenCalledWith(
        "nonexistent-agent",
        "container-123",
        expect.arrayContaining([
          expect.objectContaining({
            name: "messaging",
            type: "http",
            url: "http://host.docker.internal:3100/mcp",
          }),
        ]),
      );

      // Should have exactly 1 MCP server (messaging only)
      const mcpServers = (mockAgentMcpServer.createACPClient as any).mock.calls[0][2];
      expect(mcpServers).toHaveLength(1);
    });

    it("should fail agent spawn when ACP client creation fails", async () => {
      // Mock ACP client creation to fail
      (mockAgentMcpServer.createACPClient as any).mockRejectedValueOnce(
        new Error("ACP client creation failed"),
      );

      // Mock container.remove for cleanup
      const mockRemove = vi.fn().mockResolvedValue(undefined);
      mockContainer.remove = mockRemove;

      // Should throw error when ACP client creation fails
      await expect(
        containerManager.spawnAgent({
          agentId: "test-agent",
          task: "Test task",
          workspace: tempDir,
        })
      ).rejects.toThrow("Failed to establish ACP session for agent test-agent");

      // Container should be created and started, then cleaned up
      expect(mockDocker.createContainer).toHaveBeenCalled();
      expect(mockContainer.start).toHaveBeenCalled();
      expect(mockRemove).toHaveBeenCalledWith({ force: true });
    });

    it("should use custom agent MCP port in messaging server URL", async () => {
      const customContainerManager = new ContainerManager(
        mockDocker as any,
        mockAgentMcpServer,
        9999, // Custom port
      );

      await customContainerManager.spawnAgent({
        agentId: "test-agent",
        task: "Test task",
        workspace: tempDir,
      });

      expect(mockAgentMcpServer.createACPClient).toHaveBeenCalledWith(
        "test-agent",
        "container-123",
        expect.arrayContaining([
          expect.objectContaining({
            name: "messaging",
            url: "http://host.docker.internal:9999/mcp",
          }),
        ]),
      );
    });

    describe("Git Credentials Mounting", () => {
      it("should mount .gitconfig and .git-credentials if they exist", async () => {
        // Create test Git files in a temporary home directory  
        const testHome = join(tempDir, "test-home");
        await mkdir(testHome, { recursive: true });
        await writeFile(join(testHome, ".gitconfig"), "[user]\n  name = Test User\n  email = test@example.com");
        await writeFile(join(testHome, ".git-credentials"), "https://token@github.com");

        // Spy on os.homedir to return our test directory
        const osHomedirSpy = vi.spyOn(require("os"), "homedir").mockReturnValue(testHome);

        await containerManager.spawnAgent({
          agentId: "git-test-agent",
          task: "Test Git mounting",
          workspace: tempDir,
        });

        // Verify container creation with Git binds
        expect(mockDocker.createContainer).toHaveBeenCalledWith(
          expect.objectContaining({
            HostConfig: expect.objectContaining({
              Binds: expect.arrayContaining([
                `${tempDir}:/workspace:rw`,
                `${testHome}/.gitconfig:/root/.gitconfig:ro`,
                `${testHome}/.git-credentials:/root/.git-credentials:ro`,
              ]),
            }),
          }),
        );

        osHomedirSpy.mockRestore();
      });

      it("should work without Git files present", async () => {
        // Use a directory without Git files
        const testHome = join(tempDir, "empty-home");
        await mkdir(testHome, { recursive: true });

        // Spy on os.homedir to return our test directory
        const osHomedirSpy = vi.spyOn(require("os"), "homedir").mockReturnValue(testHome);

        await containerManager.spawnAgent({
          agentId: "no-git-test-agent", 
          task: "Test without Git files",
          workspace: tempDir,
        });

        // Verify container creation with only workspace bind
        expect(mockDocker.createContainer).toHaveBeenCalledWith(
          expect.objectContaining({
            HostConfig: expect.objectContaining({
              Binds: [`${tempDir}:/workspace:rw`],
            }),
          }),
        );

        osHomedirSpy.mockRestore();
      });
    });

    describe("Isolated Workspaces", () => {
      let mockVolume: any;

      beforeEach(() => {
        mockVolume = {
          remove: vi.fn().mockResolvedValue(undefined),
        };

        // Mock Docker volume operations
        (mockDocker as any).listVolumes = vi.fn().mockResolvedValue({
          Volumes: []
        });
        (mockDocker as any).createVolume = vi.fn().mockResolvedValue(undefined);
        (mockDocker as any).getVolume = vi.fn().mockReturnValue(mockVolume);

        // Mock Git setup container
        const mockSetupContainer = {
          start: vi.fn().mockResolvedValue(undefined),
          logs: vi.fn().mockResolvedValue({
            on: vi.fn((event, callback) => {
              if (event === 'end') {
                setTimeout(callback, 10);
              }
            })
          }),
          remove: vi.fn().mockResolvedValue(undefined)
        };
        
        (mockDocker as any).createContainer = vi.fn()
          .mockResolvedValueOnce(mockSetupContainer) // First call for git setup
          .mockResolvedValue(mockContainer); // Second call for agent container
      });

      it("should create isolated workspace with repository", async () => {
        const config = {
          agentId: "test-agent-isolated",
          task: "Test isolated workspace",
          repository: "https://github.com/test/repo.git",
          agentType: "coder",
        };

        const result = await containerManager.spawnAgent(config);

        expect(result).toEqual({
          id: "test-agent-isolated",
          task: "Test isolated workspace",
          containerId: "container-123",
        });

        // Verify volume creation
        expect(mockDocker.createVolume).toHaveBeenCalledWith({
          Name: "agent-test-agent-isolated-workspace"
        });

        // Verify git setup container creation
        expect(mockDocker.createContainer).toHaveBeenCalledTimes(2);
        
        // Verify final agent container uses volume mount instead of workspace
        const finalContainerCall = (mockDocker.createContainer as any).mock.calls[1][0];
        expect(finalContainerCall.HostConfig.Binds).toEqual(
          expect.arrayContaining([
            "agent-test-agent-isolated-workspace:/workspace:rw"
          ])
        );

        // Verify REPOSITORY env variable is passed
        expect(finalContainerCall.Env).toEqual(
          expect.arrayContaining([
            "REPOSITORY=https://github.com/test/repo.git"
          ])
        );
      });

      it("should support backward compatibility with workspace parameter", async () => {
        const config = {
          agentId: "test-agent-legacy",
          task: "Test legacy workspace",
          workspace: tempDir,
          agentType: "coder",
        };

        const result = await containerManager.spawnAgent(config);

        expect(result).toEqual({
          id: "test-agent-legacy",
          task: "Test legacy workspace",
          containerId: "container-123",
        });

        // Should not create volume for legacy mode
        expect(mockDocker.createVolume).not.toHaveBeenCalled();

        // Should use traditional workspace mount
        expect(mockDocker.createContainer).toHaveBeenCalledWith(
          expect.objectContaining({
            HostConfig: expect.objectContaining({
              Binds: expect.arrayContaining([`${tempDir}:/workspace:rw`]),
            }),
          }),
        );
      });

      it("should cleanup agent volumes", async () => {
        await containerManager.cleanupAgent("test-agent-cleanup");

        expect(mockDocker.getVolume).toHaveBeenCalledWith("agent-test-agent-cleanup-workspace");
        expect(mockVolume.remove).toHaveBeenCalled();
      });

      it("should validate configuration", async () => {
        const invalidConfig = {
          agentId: "test-agent-invalid",
          task: "Test invalid config",
          // Missing both workspace and repository
          agentType: "coder",
        };

        await expect(containerManager.spawnAgent(invalidConfig)).rejects.toThrow(
          "Either workspace or repository must be specified"
        );
      });
    });
  });
});
