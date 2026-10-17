import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { repoRoot } from "../infrastructure/files";

export type OpcMcpConnection = {
  client: Client;
  transport: StdioClientTransport;
  close(): Promise<void>;
};

export async function createOpcMcpConnection(): Promise<OpcMcpConnection> {
  const env = getDefaultEnvironment();
  if (process.env.DATABASE_URL) env.DATABASE_URL = process.env.DATABASE_URL;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", path.join(repoRoot, "mcp", "server.ts")],
    cwd: repoRoot,
    env,
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => console.error(String(chunk).trimEnd()));
  const client = new Client({ name: "opc-app", version: "0.4.0" });
  await client.connect(transport);
  return {
    client,
    transport,
    async close() {
      await client.close();
    },
  };
}

