import { handle, json } from "../lib/http.js";
import { providerStatus, activeProvider, providers } from "../lib/llm.js";
import { LIMITS } from "../lib/limits.js";

/**
 * GET /api/health
 * Tells the UI whether real AI is live, and with which provider/model.
 * Never leaks the key — only whether one exists.
 */
export default handle(async request => {
  const status = providerStatus();
  return json({
    ok: true,
    ai: status.ai,
    provider: status.provider,
    label: status.label,
    model: status.model,
    // Which providers this deployment could use if a key were added.
    available: providers().map(p => ({ id: p.id, label: p.label, configured: !!p.key })),
    limits: {
      maxTextChars: LIMITS.maxTextChars,
      maxQuestions: LIMITS.maxQuestions,
      perIpPerHour: LIMITS.perIpPerHour,
    },
    version: "1.0.0",
  });
});
