// THE MODEL PICKER'S SHAPE — one flat list of models in, the menu a person can read out.
//
// Every client is handed the same flat array by the gateway's /v1/models: fifty-odd entries
// mixing local CLI agents with a dozen providers' cloud models, in whatever order the routing
// table happened to enumerate them. Rendered literally that is a single scrolling column of
// opaque ids — `claude-code`, `gpt-4o-mini`, `qwen2.5-coder:7b` — where the two things a user
// actually distinguishes are invisible:
//
//   • AN AGENT IS NOT A MODEL. A bridge-backed CLI runs on this machine, holds a session, can
//     touch files and costs a process; a cloud model is a stateless HTTP call. Picking between
//     them is a different decision from picking between two models, and a flat list forces
//     both decisions through one control.
//   • A PROVIDER IS THE UNIT PEOPLE THINK IN. "the Anthropic one", "my Ollama". Sorting by id
//     interleaves providers so the same provider's models are scattered down the list.
//
// So this turns the flat list into SECTIONS, and it lives here rather than in a client because
// it is pure input → output with no window in it: the desktop renders it as a menu, the
// extension as its agent menu, a mobile client as a grouped list, and all three group and
// order identically. Writing it in one client is how `displayName` got duplicated.
//
// UNAVAILABLE MODELS ARE KEPT, NOT DROPPED. A CLI the user has not installed is the single
// most common reason a first message fails, and a picker that silently omits it answers
// "where did Claude Code go?" with nothing. It is listed, ordered last within its section,
// flagged, and carries the reason — see `reason` on the entry.

/** A bridge-backed CLI agent, as opposed to an HTTP model endpoint. */
const isAgent = (m) => m?.providerType === 'agent' || m?.viaBridge === true;

/**
 * The provider a model belongs to, in the words the gateway used.
 *
 * `provider` is what gateways from 0.6.64 report; `owned_by`/`owner` is the older field. A
 * name is NEVER parsed for a provider — reading `gpt-` as "OpenAI" breaks the moment someone
 * serves a GPT-named model from their own Ollama, and that user's whole point was that it is
 * local.
 */
const providerOf = (m) => String(m?.provider || m?.owner || '').trim();

/**
 * How a provider is spelled when a person wrote it down.
 *
 * Capitalising the first letter is right for `anthropic` and wrong for every brand with
 * internal capitals — it renders "Openai", "Deepseek", "Xai". A heading is the most-read text
 * in the picker, and misspelling the company in it reads as carelessness about everything
 * else, so the handful that do not follow the rule are simply listed.
 */
const PROVIDER_NAMES = {
  openai: 'OpenAI', openrouter: 'OpenRouter', deepseek: 'DeepSeek', xai: 'xAI',
  vllm: 'vLLM', lmstudio: 'LM Studio', llamacpp: 'llama.cpp', 'llama.cpp': 'llama.cpp',
  huggingface: 'Hugging Face', togetherai: 'Together AI', together: 'Together AI',
  githubcopilot: 'GitHub Copilot', awsbedrock: 'AWS Bedrock', bedrock: 'AWS Bedrock',
  azureopenai: 'Azure OpenAI', googleai: 'Google AI', vertexai: 'Vertex AI',
};

/** Sentence case for a bare provider slug, leaving names that already have shape alone. */
function providerLabel(raw) {
  const p = String(raw || '').trim();
  if (!p) return 'Other';
  const known = PROVIDER_NAMES[p.toLowerCase().replace(/[\s_-]/g, '')];
  if (known) return known;
  if (/[A-Z ]/.test(p)) return p;              // already presentable: "Together AI", "MyCorp LLM"
  return p.charAt(0).toUpperCase() + p.slice(1);
}

const availableFirst = (a, b) => (
  (a.available === false) - (b.available === false)
  || String(a.id).localeCompare(String(b.id))
);

/**
 * Group a flat model list into the sections a picker draws.
 *
 * Sections come back in the order they should be shown: **Agents first**, then each provider
 * alphabetically. Agents lead because a local CLI is the one target a fresh install can be
 * sure of — no key, no account — which is the same reason `target-choice.js` defaults to one.
 *
 * @param models   the gateway's models, each `{ id, provider, providerType, viaBridge,
 *                 available, reason, owner, label? }`
 * @param selectedId  currently chosen id, so a caller can mark it without a second pass
 * @returns `[{ key, label, kind: 'agent'|'provider', items: [...] }]`, where each item is the
 *          model object plus `{ label, selected }`. Empty sections are never emitted.
 */
export function groupModels(models, { selectedId = '' } = {}) {
  const list = Array.isArray(models) ? models.filter(Boolean) : [];

  const agents = [];
  const byProvider = new Map();
  for (const m of list) {
    if (isAgent(m)) { agents.push(m); continue; }
    const key = providerOf(m) || 'other';
    if (!byProvider.has(key)) byProvider.set(key, []);
    byProvider.get(key).push(m);
  }

  const decorate = (m) => ({
    ...m,
    label: m.label || m.id,
    selected: !!selectedId && m.id === selectedId,
  });

  const sections = [];
  if (agents.length) {
    sections.push({
      key: 'agents',
      label: 'Agents',
      kind: 'agent',
      items: agents.slice().sort(availableFirst).map(decorate),
    });
  }
  for (const key of [...byProvider.keys()].sort((a, b) => a.localeCompare(b))) {
    sections.push({
      key: `provider:${key}`,
      label: providerLabel(key),
      kind: 'provider',
      items: byProvider.get(key).slice().sort(availableFirst).map(decorate),
    });
  }
  return sections;
}

/**
 * Filter the grouped sections by a typed query, keeping the grouping.
 *
 * A provider name matches ALL of its models: someone typing "ollama" is asking to see that
 * provider, not to see the models whose ids happen to contain the string — and with local
 * models the id usually does not contain it at all.
 *
 * Sections that end up empty are dropped, so an unmatched provider does not leave a heading
 * floating over nothing.
 */
export function filterSections(sections, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return sections;
  const out = [];
  for (const s of sections) {
    if (s.label.toLowerCase().includes(q)) { out.push(s); continue; }
    const items = s.items.filter((m) => (
      String(m.label).toLowerCase().includes(q) || String(m.id).toLowerCase().includes(q)
    ));
    if (items.length) out.push({ ...s, items });
  }
  return out;
}

/**
 * The id a picker should start on when the record does not name one.
 *
 * Prefers a REACHABLE agent, then any reachable model, and only then something known to be
 * unavailable. The rule is the product's, and it is the same one `target-choice.js` states:
 * never default to a target that cannot answer, because the user is the one who finds out.
 */
export function defaultModelId(models) {
  const list = Array.isArray(models) ? models.filter(Boolean) : [];
  const usable = list.filter((m) => m.available !== false);
  return (usable.find(isAgent) || usable[0] || list[0] || {}).id || '';
}

/**
 * How to describe the chosen model in one line — what the picker's own button says.
 *
 * The three-valued `available` is the honesty rule applied to a button: an id that names
 * nothing is only BROKEN if there was a list for it to be absent from. Before /v1/models has
 * answered there is no such list, so the truthful answer is `null` — "nobody has looked yet"
 * — and a caller must not paint that as a red dot. Marking an unloaded picker unavailable is
 * the same mistake as drawing "0 redactions" when nothing was inspected.
 */
export function modelSummary(models, id) {
  const list = Array.isArray(models) ? models.filter(Boolean) : [];
  const m = list.find((x) => x.id === id);
  if (!m) {
    return {
      label: id || 'No model',
      available: list.length ? false : null,
      reason: list.length && id ? `${id} is not offered by the gateway any more` : '',
      agent: false,
      provider: '',
    };
  }
  return {
    label: m.label || m.id,
    available: m.available !== false,
    reason: m.reason || '',
    agent: isAgent(m),
    provider: providerLabel(providerOf(m)),
  };
}
