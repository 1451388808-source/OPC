const DEVELOPMENT_PHASE = "phase-development-server";

export function nextDistDir(phase: string): string {
  return phase === DEVELOPMENT_PHASE ? ".next" : ".next-build";
}

