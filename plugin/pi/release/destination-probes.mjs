import { planPublicationAttempt } from './publication-attempt.mjs';

const destinations = ['npm', 'core'];

/** Invoke caller-owned remote queries anew; never execute publication actions.
 * Invocation freshness does not authenticate IO or externally supplied identity.
 */
export async function probeAndPlanPublicationAttempt(input) {
  const absent = Object.fromEntries(destinations.map(destination => [destination, {
    state: 'absent', attemptId: input?.attemptId, version: input?.version,
  }]));
  const preflight = planPublicationAttempt({ ...input, destinations: absent });
  if (preflight.plan.status === 'blocked') return preflight;

  const observations = await Promise.all(destinations.map(async destination => {
    const request = Object.freeze({ attemptId: input.attemptId, version: input.version, destination });
    try {
      const query = input.queries?.[destination];
      if (typeof query !== 'function') return undefined;
      const observation = await query(request);
      if (!observation || typeof observation !== 'object' || Array.isArray(observation)) return undefined;
      for (const field of ['attemptId', 'version', 'destination']) {
        if (Object.hasOwn(observation, field) && observation[field] !== request[field]) return undefined;
      }
      return { ...observation, attemptId: request.attemptId, version: request.version };
    } catch {
      // Remote errors may contain credentials; only the destination reaches the binder's reason.
      return undefined;
    }
  }));
  return planPublicationAttempt({ ...input,
    destinations: Object.fromEntries(destinations.map((destination, index) => [destination, observations[index]])) });
}
