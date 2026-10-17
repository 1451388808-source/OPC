import type { Metadata } from "next";
import "./board.css";
import { Rail } from "./components/rail";
import { ensureCollaborationRuntime } from "@/lib/collaboration/agent-runner";
import { shouldStartCollaborationRuntime } from "@/lib/collaboration/runtime";

export const metadata: Metadata = { title: "OPC" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  if (shouldStartCollaborationRuntime()) await ensureCollaborationRuntime();
  return (
    <html lang="zh-CN">
      <body>
        <div className="shell">
          <Rail />
          <div className="shell-main">
            <div className="route-motion">{children}</div>
          </div>
        </div>
      </body>
    </html>
  );
}
