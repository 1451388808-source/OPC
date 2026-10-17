import type { NextConfig } from "next";
import { nextDistDir } from "./lib/infrastructure/next-dist-dir";

export default function nextConfig(phase: string): NextConfig {
  return {
    output: "standalone",
    devIndicators: false,
    distDir: nextDistDir(phase),
  };
}
