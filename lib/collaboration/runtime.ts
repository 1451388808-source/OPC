const NEXT_PRODUCTION_BUILD_PHASE = "phase-production-build";

export function shouldStartCollaborationRuntime(phase = process.env.NEXT_PHASE): boolean {
  return phase !== NEXT_PRODUCTION_BUILD_PHASE;
}

