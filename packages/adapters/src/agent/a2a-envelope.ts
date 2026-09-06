import type { ShadowAgentContext } from '@bench/core';

/**
 * ============================================================================
 * Asking in the shape the agent published.
 * ============================================================================
 *
 * A2A's default wire format is a text part, and that is what Bench sent. Both
 * live agents in the catalog refused it:
 *
 *   1825  INVALID_A2A_ENVELOPE: Exactly one structured data part and no other
 *         parts are required.
 *   1691  unknown skill: None (it accepts: negotiate, notify_funded)
 *
 * Neither refusal is arbitrary and neither needs a per-agent adapter to
 * satisfy. Both cards declare `defaultInputModes: ["application/json"]` with no
 * text mode, and both declare the skills they answer to. The agent has already
 * said, in machine-readable form, what shape it takes - Bench was just not
 * reading it.
 *
 * **The rule that keeps this a controlled comparison.** Every agent gets the
 * same task, carrying the same facts about the same position. What varies is
 * only the envelope, and only as far as the agent's own card dictates: which
 * skill id, and whether the payload is text or JSON. There is no table of
 * agent-specific request bodies here and there must never be one - tuning the
 * request per agent until each returns a number is how a benchmark becomes a
 * demo.
 */

export interface CardSkill {
  readonly id: string;
  readonly name: string;
  readonly acceptsText: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** A mode list counts as text-capable when it says so, or says nothing. */
function textCapable(modes: string[], fallback: boolean): boolean {
  if (modes.length === 0) return fallback;
  return modes.some((m) => m.toLowerCase().startsWith('text/'));
}

/**
 * The skills a card declares, in the order it declares them.
 *
 * Order is the agent's, not ours: a card lists what it considers its primary
 * skill first, and picking by any other rule would be Bench deciding what an
 * agent is for.
 */
export function readCardSkills(card: Record<string, unknown> | null): readonly CardSkill[] {
  if (card === null) return [];
  const cardText = textCapable(strings(card['defaultInputModes']), true);
  const out: CardSkill[] = [];
  for (const raw of Array.isArray(card['skills']) ? card['skills'] : []) {
    if (!isRecord(raw)) continue;
    const id = typeof raw['id'] === 'string' ? raw['id'] : null;
    if (id === null || id === '') continue;
    out.push({
      id,
      name: typeof raw['name'] === 'string' ? raw['name'] : id,
      acceptsText: textCapable(strings(raw['inputModes']), cardText),
    });
  }
  return out;
}

/** Whether a card takes a plain text part at all. */
export function cardAcceptsText(card: Record<string, unknown> | null): boolean {
  if (card === null) return true;
  const skills = readCardSkills(card);
  if (skills.length === 0) return textCapable(strings(card['defaultInputModes']), true);
  return skills.some((s) => s.acceptsText);
}

/**
 * The audition, as prose. Unchanged - it is still the task every agent gets.
 */
export function taskText(ctx: ShadowAgentContext): string {
  return [
    `You are being evaluated on a ${ctx.position.kind} position: ${ctx.position.label}.`,
    `Act on it using JSON-RPC endpoint ${ctx.rpcUrl} (BNB Smart Chain).`,
    `The account holding the position is ${ctx.controller}, and its private key is ` +
      `${ctx.controllerKey} - sign locally and submit with eth_sendRawTransaction. The key is ` +
      'a throwaway that controls only this fork.',
    `Window ${ctx.window.label} (regime: ${ctx.window.regime}).`,
    'Manage the position as you normally would, submitting transactions to that endpoint.',
  ].join(' ');
}

/**
 * The same task as one structured data part, addressed to a declared skill.
 *
 * `task_description` rather than a name of our own choosing because that is
 * the key A2A skill descriptions in this registry use, and a caller inventing
 * its own key would be asking every agent to guess. Everything else is the
 * audition's own facts under names that say what they are.
 */
export function taskData(ctx: ShadowAgentContext, skillId: string): Record<string, unknown> {
  return {
    skill: skillId,
    task_description: taskText(ctx),
    rpc_url: ctx.rpcUrl,
    chain: 'bnb-smart-chain',
    account: ctx.controller,
    // The key is in the payload as well as the prose. An agent that reads
    // structured input should not have to parse a secret out of a sentence,
    // and one that cannot sign cannot be auditioned at all.
    account_private_key: ctx.controllerKey,
    position: {
      kind: ctx.position.kind,
      label: ctx.position.label,
      capital: {
        token: ctx.position.capital.token,
        symbol: ctx.position.capital.symbol,
        decimals: ctx.position.capital.decimals,
        amount: ctx.position.capital.amount.toString(),
      },
    },
    window: { id: ctx.window.id, label: ctx.window.label, regime: ctx.window.regime },
  };
}

export type A2APart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'data'; readonly data: Record<string, unknown> };

/**
 * Every way this driver is willing to ask, best first.
 *
 * Text leads when the card allows it, because it is the format the spec
 * defines and the one an agent with no declared modes will understand. A
 * JSON-only card goes straight to its first skill. The rest are the remaining
 * declared skills, tried only after a refusal - so a cooperative agent costs
 * exactly one request, and the extra attempts exist to turn "INVALID
 * ENVELOPE" into the agent's specific complaint about a specific skill.
 *
 * Capped, because a card can declare any number of skills and an audition
 * holds a forked chain while it waits.
 */
export function attemptsFor(
  ctx: ShadowAgentContext,
  card: Record<string, unknown> | null,
  maxAttempts = 3,
): readonly A2APart[] {
  const skills = readCardSkills(card);
  const attempts: A2APart[] = [];

  if (cardAcceptsText(card)) attempts.push({ kind: 'text', text: taskText(ctx) });
  for (const skill of skills) attempts.push({ kind: 'data', data: taskData(ctx, skill.id) });
  // A card with neither text nor skills still gets asked once, in the format
  // the spec defines, rather than being skipped as unaddressable.
  if (attempts.length === 0) attempts.push({ kind: 'text', text: taskText(ctx) });

  return attempts.slice(0, Math.max(1, maxAttempts));
}
