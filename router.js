// The model router — which model answers, and what happens to the request on the way.
//
// Two things that look separate and are not. WHERE a request goes decides what may happen
// to it (a local model needs no redaction; a third-party one does), and what happens to it
// decides where it may go (a redacted request is safe somewhere the raw one is not). Wiring
// them separately is how a request reaches a cloud model with the redaction step skipped,
// which is the single worst bug this codebase could have.
//
// So routing and composition are one object, and the ordering guarantee is STRUCTURAL:
// every request passes through the same pipeline, and egress happens at a point the
// pipeline defines rather than wherever a caller remembered to put it.
//
// ROUTING IS CLASS R. A rule picks the model — declared attributes in, a decision plus its
// reasons out. Deterministic, instant, free, and explainable. Asking a language model which
// language model to use would be slower, cost tokens, and produce an answer nobody can
// check.
//
// HARD CONSTRAINTS ARE NOT SCORES. Privacy and capability eliminate candidates; latency,
// cost and load only order the survivors. A privacy requirement that could be outweighed by
// a cheap model is not a requirement — and "cheapest wins" is exactly the pressure that
// would erode it.

export class RouterError extends Error {
  constructor(code, message) { super(message); this.name = 'RouterError'; this.code = code; }
}

/** Where a request may go. Ordered: each level permits everything below it. */
export const REACH = Object.freeze(['device', 'trusted', 'any']);

const reachRank = (r) => Math.max(0, REACH.indexOf(r));

/**
 * Declare a model a request can be routed to.
 *
 * @param reach   the furthest a request may travel to reach it: 'device' (never leaves),
 *                'trusted' (the user's own server or gateway), 'any' (a third party).
 * @param classUsed R/M/L/C/A per the execution classes — what guarantee it offers.
 * @param capabilities what it can do: 'tools', 'vision', 'json', 'long-context'…
 * @param costPer1k  relative cost. Unitless on purpose: the router compares candidates, it
 *                does not bill anyone, and a fake precision here would invite trusting it.
 * @param latencyMs typical time to first token.
 * @param load     0..1, how busy it is right now — supplied by the host, not remembered
 *                here, because a router that cached load would be routing on stale facts.
 */
export function defineModel({
  id, label, reach = 'any', classUsed = 'C', capabilities = [],
  costPer1k = 1, latencyMs = 1000, load = 0, available = true,
}) {
  if (!id) throw new RouterError('BAD_MODEL', 'model.id required');
  if (!REACH.includes(reach)) throw new RouterError('BAD_MODEL', `model '${id}': unknown reach '${reach}'`);
  return Object.freeze({
    id, label: label || id, reach, classUsed,
    capabilities: [...capabilities], costPer1k, latencyMs, load, available,
  });
}

/**
 * A step in the pipeline every request passes through.
 *
 * @param stage 'request'  — before the model is called (redaction, trimming, tool selection)
 *              'response' — after it answers (restoring placeholders, citations)
 * @param priority lower runs first on the request and LAST on the response, so a step that
 *              wraps something unwraps it symmetrically. Getting this backwards is how a
 *              vault gets restored before the text it protects comes back.
 */
export function defineMiddleware({ id, label, stage, priority = 100, run, requiredFor = null }) {
  if (!id) throw new RouterError('BAD_MIDDLEWARE', 'middleware.id required');
  if (!['request', 'response'].includes(stage)) throw new RouterError('BAD_MIDDLEWARE', `middleware '${id}': stage must be request or response`);
  if (typeof run !== 'function') throw new RouterError('BAD_MIDDLEWARE', `middleware '${id}': run required`);
  return Object.freeze({ id, label: label || id, stage, priority, run, requiredFor });
}

export function createModelRouter({ models = [], middleware = [], admit = null } = {}) {
  const registry = [...models];
  const chain = [...middleware];

  /** Order once: request steps ascending, response steps descending — see defineMiddleware. */
  const stepsFor = (stage) => chain
    .filter((m) => m.stage === stage && (!admit || admit(m)))
    .sort((a, b) => (stage === 'request' ? a.priority - b.priority : b.priority - a.priority));

  return {
    addModel(m) { registry.push(m); return () => { const i = registry.indexOf(m); if (i >= 0) registry.splice(i, 1); }; },
    use(m) { chain.push(m); return () => { const i = chain.indexOf(m); if (i >= 0) chain.splice(i, 1); }; },
    models: () => [...registry],
    middleware: () => [...chain],

    /**
     * Choose a model. Returns the decision AND why every rejected candidate lost, because
     * "it used the wrong model" is unanswerable otherwise.
     *
     * @param need { reach, capabilities, prefer } — `prefer` is 'latency' | 'cost' |
     *        'balanced'. Preference orders survivors; it never revives a rejected one.
     */
    route(need = {}) {
      const wantReach = REACH.includes(need.reach) ? need.reach : 'any';
      const wantCaps = need.capabilities || [];
      const rejected = [];
      const eligible = registry.filter((m) => {
        if (!m.available) { rejected.push({ id: m.id, why: 'unavailable' }); return false; }
        if (admit && !admit(m)) { rejected.push({ id: m.id, why: 'disabled' }); return false; }
        // PRIVACY IS A CEILING, NOT A PREFERENCE. A request allowed only on-device can never
        // be routed to a third party, however cheap or fast that party is.
        if (reachRank(m.reach) > reachRank(wantReach)) { rejected.push({ id: m.id, why: `reach '${m.reach}' exceeds '${wantReach}'` }); return false; }
        const missing = wantCaps.filter((c) => !m.capabilities.includes(c));
        if (missing.length) { rejected.push({ id: m.id, why: `missing ${missing.join(', ')}` }); return false; }
        return true;
      });

      if (!eligible.length) {
        return { model: null, reasons: ['no candidate satisfies the constraints'], rejected };
      }

      const prefer = need.prefer || 'balanced';
      const score = (m) => {
        // Load is a multiplier rather than a term: a busy model is worse at everything it
        // offers, not merely a bit more expensive.
        const busy = 1 + Math.max(0, Math.min(1, m.load));
        if (prefer === 'latency') return m.latencyMs * busy;
        if (prefer === 'cost') return m.costPer1k * busy;
        return (m.latencyMs / 1000) * m.costPer1k * busy;
      };
      const ranked = [...eligible].sort((a, b) => score(a) - score(b) || a.id.localeCompare(b.id));
      const chosen = ranked[0];
      return {
        model: chosen,
        reasons: [
          `reach '${chosen.reach}' within '${wantReach}'`,
          wantCaps.length ? `has ${wantCaps.join(', ')}` : 'no special capability needed',
          `best by ${prefer} (${ranked.length} eligible)`,
        ],
        rejected,
        runnersUp: ranked.slice(1).map((m) => m.id),
      };
    },

    /**
     * Run a request through the pipeline and back.
     *
     * `dispatch` is injected — the router composes and decides; it does not know how to talk
     * to a model. A step that declares `requiredFor` and is missing FAILS the request rather
     * than being skipped: that is how "redaction must run before a third party sees this"
     * becomes a property of the system instead of a habit.
     */
    async run(request, { dispatch, need = {} } = {}) {
      if (typeof dispatch !== 'function') throw new RouterError('NO_DISPATCH', 'run needs a dispatch function');
      const decision = this.route(need);
      if (!decision.model) throw new RouterError('NO_ROUTE', decision.reasons[0]);

      const applies = (m) => !m.requiredFor || m.requiredFor(decision.model, need);
      const required = chain.filter((m) => m.requiredFor && m.requiredFor(decision.model, need));
      const active = new Set(stepsFor('request').concat(stepsFor('response')).map((m) => m.id));
      const missing = required.filter((m) => !active.has(m.id));
      if (missing.length) {
        // Fail loud. Silently proceeding without a required step is the exact failure this
        // whole structure exists to prevent, and a disabled-plugin toggle must not be able
        // to cause it.
        throw new RouterError('MISSING_REQUIRED', `route to '${decision.model.id}' requires ${missing.map((m) => m.id).join(', ')}, which is not active`);
      }

      const ctx = { model: decision.model, need, decision };
      let payload = request;
      for (const step of stepsFor('request')) {
        if (!applies(step)) continue;
        payload = (await step.run(payload, ctx)) ?? payload;
      }
      let answer = await dispatch(payload, ctx);
      for (const step of stepsFor('response')) {
        if (!applies(step)) continue;
        answer = (await step.run(answer, ctx)) ?? answer;
      }
      return { answer, decision };
    },
  };
}
