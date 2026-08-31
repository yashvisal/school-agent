import { defineEvalConfig } from "eve/evals";

// `judge` takes an object with a `model` (evals/judge.mdx: "Project default:
// defineEvalConfig({ judge: { model, modelOptions } })"). A bare string is not the
// documented shape. The string model id routes through the Vercel AI Gateway and
// needs AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN; without credentials judge-backed
// evals skip visibly rather than failing.
export default defineEvalConfig({
  judge: { model: "anthropic/claude-sonnet-5" },
});
