// Edit Diff — Check 2: fresh module, created after the 0.13.3 upgrade.
const PHASES = ["new", "ready", "paused", "running", "done"];

export function nextPhase(current) {
  const index = PHASES.indexOf(current);
  if (index === -1) return PHASES[0];
  return PHASES[Math.min(index + 1, PHASES.length - 1)];
}

export function phaseIndex(phase) {
  return PHASES.indexOf(phase);
}

export function progress(phase) {
  const index = PHASES.indexOf(phase);
  if (index === -1) return 0;
  return index / (PHASES.length - 1);
}

export function formatPhase(phase) {
  return `[${String(phase).toUpperCase()}]`;
}

export function summarizePhase(phase) {
  const index = phaseIndex(phase);
  return `${formatPhase(phase)} step ${index + 1}/${PHASES.length}`;
}

export function canAdvance(phase) {
  return phaseIndex(phase) !== -1 && phase !== "done" && phase !== "paused";
}
