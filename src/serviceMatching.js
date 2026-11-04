// Deterministic deployment-event service matching.
//
// A deployment event must first match an exact `projectKey` for the agent.
// Only if no exact match exists do we fall back to `templateKey`, and only
// when that template key maps to exactly one service. An ambiguous template
// match is rejected rather than assigning a deployment to an arbitrary
// service.

export function matchServiceForEvent(services, projectKey) {
  const candidates = Array.isArray(services) ? services : [];
  if (!projectKey || candidates.length === 0) {
    return { match: null };
  }

  const exact = candidates.find((service) => service.projectKey === projectKey);
  if (exact) return { match: exact };

  const templateMatches = candidates.filter((service) => service.templateKey === projectKey);
  if (templateMatches.length === 0) return { match: null };
  if (templateMatches.length > 1) {
    return { conflict: true, candidates: templateMatches.map((service) => service.id) };
  }
  return { match: templateMatches[0] };
}