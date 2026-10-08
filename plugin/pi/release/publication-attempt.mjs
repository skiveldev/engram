import { buildArtifactIdentity, bindDestinationObservation } from './artifact-evidence.mjs';
import { planPublication } from './publication-plan.mjs';

const blocked = (candidate, reason) => ({ candidate,
  plan: { status: 'blocked', reason, correctiveVersionRequired: false, actions: [] } });

/** Compose injected evidence only: no queries, writes, execution or permission. */
export function planPublicationAttempt(input) {
  let candidate;
  try {
    candidate = { version: input?.version, ...buildArtifactIdentity(input?.artifacts) };
  } catch {
    return blocked(null, 'invalid-artifact-evidence');
  }
  const destinations = {};
  for (const destination of ['npm', 'core']) {
    try {
      destinations[destination] = bindDestinationObservation({ attemptId: input.attemptId,
        destination, candidate, observation: input.destinations?.[destination] });
    } catch {
      return blocked(candidate, `invalid-destination-observation:${destination}`);
    }
  }
  return { candidate, plan: planPublication({ candidate, destinations, gates: input.gates }) };
}
