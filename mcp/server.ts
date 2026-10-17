import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createOpcMcpServer } from "./server-factory.ts";
import { closePool } from "../lib/infrastructure/db.ts";

const server = createOpcMcpServer();
const transport = new StdioServerTransport();
transport.onerror = (error) => console.error("OPC MCP transport error", error);
await server.connect(transport);

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await closePool().catch(() => {});
}

process.stdin.once("end", () => void shutdown());
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));

