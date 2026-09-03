/**
 * Strip credentials out of text that is about to be stored or displayed.
 *
 * Error messages are the leak nobody audits. viem puts the full RPC URL in
 * `message` - `HTTP request failed.\n\nURL: https://x.bsc.quiknode.pro/<key>/`
 * - and that message travelled from a failed tick into the worker's heartbeat,
 * out of an unauthenticated /health, and onto the public status page. A paid
 * archive-node key was one RPC hiccup away from being published, and the same
 * path carries Postgres and Redis URLs with passwords in them.
 *
 * So nothing writes a raw error string into a stored or rendered field. This
 * runs at the boundary, and it is deliberately aggressive: a redaction that
 * loses a little diagnostic detail is recoverable, a published key is not.
 *
 * Pure and dependency-free, in core, because the worker, the web app and the
 * audition path all need the same definition. Three copies of "what counts as
 * a secret" is how one of them ends up not counting something.
 */

/** Query/path parameter names whose values are secrets whatever they contain. */
const SECRET_PARAM = /^(api[-_]?key|apikey|key|token|access[-_]?token|auth|password|secret|sig)$/i;

/**
 * A path segment that looks like a credential rather than a route.
 *
 * Provider keys are long opaque strings in the path - QuickNode, Alchemy and
 * Infura all shape their URLs this way - and there is no name attached to say
 * so. Length plus alphabet is the only signal available, so the rule is
 * "20+ chars of key-ish alphabet with no vowel-and-separator structure that a
 * route would have".
 */
const KEYISH_SEGMENT = /^[A-Za-z0-9_-]{20,}$/;

const REDACTED = '[redacted]';

/** Redact userinfo, secret query params, and key-shaped path segments in a URL. */
function redactUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }

  // A password is always secret. A lone username is an identifier, and
  // `postgres://bench@host` is worth keeping legible.
  if (url.password !== '') url.password = REDACTED;

  for (const name of [...url.searchParams.keys()]) {
    if (SECRET_PARAM.test(name)) url.searchParams.set(name, REDACTED);
  }

  url.pathname = url.pathname
    .split('/')
    .map((seg) => (KEYISH_SEGMENT.test(seg) ? REDACTED : seg))
    .join('/');

  // Fragments are never load-bearing for us and can carry anything.
  url.hash = '';
  return url.toString();
}

/**
 * Any credential-bearing URL, however it is embedded in surrounding prose.
 *
 * Not just http(s). The first version matched only those and so walked past
 * `redis://default:<password>@host` untouched - which is exactly the string an
 * ioredis connection failure puts in its message, and one of the two reasons
 * this module exists.
 */
const URL_IN_TEXT =
  /\b(?:https?|wss?|redis|rediss|postgres|postgresql|mongodb(?:\+srv)?|amqps?):\/\/[^\s"'<>)\]},]+/gi;

/**
 * Bare secrets that appear without a URL around them.
 *
 * Long hex is the dangerous one: a private key, a signed cookie value, or a
 * bearer token pasted into an error. 0x-prefixed 40-char addresses are public
 * identifiers and stay, which is why the floor is well above them.
 */
const BARE_SECRET: readonly RegExp[] = [
  /\b0x[a-fA-F0-9]{64,}\b/g,
  /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
  /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
];

/**
 * Redact a message, then bound it.
 *
 * The bound is part of the safety property rather than tidiness: an unbounded
 * string from an endpoint a stranger controls goes into a database column and
 * onto a page, and truncating after redaction means a secret cannot survive by
 * sitting past the cut.
 */
export function redactSecrets(text: string, maxLength = 300): string {
  let out = text.replace(URL_IN_TEXT, (m) => redactUrl(m));
  for (const pattern of BARE_SECRET) out = out.replace(pattern, REDACTED);

  // Names configured in the environment, redacted by value. Catches anything
  // the shape rules above miss - an operator's key that happens to be short,
  // or one embedded somewhere no pattern anticipated.
  for (const name of SECRET_ENV) {
    const value = process.env[name];
    if (value !== undefined && value.length >= 8) out = out.split(value).join(REDACTED);
  }

  return out.length > maxLength ? `${out.slice(0, maxLength)}…` : out;
}

/**
 * Environment variables whose values must never appear in stored text.
 *
 * Listed rather than inferred: a heuristic over every variable would redact
 * substrings of ordinary messages once some unrelated variable held a common
 * word. These are the ones that are actually secret in this deployment.
 */
const SECRET_ENV: readonly string[] = [
  'BSC_ARCHIVE_RPC_URL',
  'BSC_MAINNET_RPC_URL',
  'BSC_TESTNET_RPC_URL',
  'DATABASE_URL',
  'DATABASE_URL_UNPOOLED',
  'REDIS_URL',
  'ALTLAYER_8004SCAN_API_KEY',
  'ALTANA_API_KEY',
  'BENCH_SIGNER_PRIVATE_KEY',
  'BENCH_COOKIE_SECRET',
  'BENCH_WORKER_HEALTH_TOKEN',
];

/** `redactSecrets` applied to whatever an unknown throw turns out to be. */
export function redactError(err: unknown, maxLength = 300): string {
  return redactSecrets(err instanceof Error ? err.message : String(err), maxLength);
}
