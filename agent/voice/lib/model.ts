/**
 * The pinned AI Gateway model id (vision §10: pin eve versions and model ids;
 * changing this is a one-line PR). Shared between `agent.ts` and the usage hook
 * so a model bump can never desync the cost record.
 */
export const MODEL = "anthropic/claude-sonnet-5"
