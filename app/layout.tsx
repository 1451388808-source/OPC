import type { Metadata } from "next";
import "./board.css";
import { Rail } from "./components/rail";

export const metadata: Metadata = { title: "OPC" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
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
