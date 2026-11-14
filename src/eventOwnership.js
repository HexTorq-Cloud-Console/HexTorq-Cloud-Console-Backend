// Deployment-event ownership guard.
//
// A registered service's event must not append logs to, or complete, another
// service's deployment — and it must only touch deployments that belong to the
// authenticating agent.

export function isTerminalStatus(status) {
  return status === 'SUCCESS' || status === 'FAILED' || status === 'ERROR';
}

/**
 * @returns {{ ok: true } | { ok: false, code: number, message: string }}
 */
export function validateDeploymentEventOwnership({ deployment, service, agentId }) {
  if (!deployment) return { ok: false, code: 404, message: 'Deployment run not found' };
  if (deployment.serviceId !== service.id) {
    return { ok: false, code: 409, message: 'Deployment does not belong to the matched service' };
  }
  if (deployment.agentId !== agentId) {
    return { ok: false, code: 409, message: 'Deployment does not belong to this agent' };
  }
  return { ok: true };
}

/**
 * Completion is idempotent: once a deployment reached a terminal state, a
 * repeated completion event must not reopen it or rewrite its result.
 *
 * @returns {{ apply: boolean, reason: string }}
 */
export function completionDecision(deploymentStatus) {
  if (isTerminalStatus(deploymentStatus)) {
    return { apply: false, reason: 'already-terminal' };
  }
  return { apply: true, reason: 'accepted' };
}

export const MAX_LOG_MESSAGE_LENGTH = 20_000;

export function validateLogMessage(message) {
  if (typeof message !== 'string') return { ok: true, value: undefined };
  if (message.length > MAX_LOG_MESSAGE_LENGTH) {
    return { ok: false, message: `Deployment log message exceeds ${MAX_LOG_MESSAGE_LENGTH} characters` };
  }
  return { ok: true, value: message };
}
