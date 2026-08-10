// Hash-route parsing.
//
// Three shapes:
//   #/t/<token>                     an invite link
//   #/scenario/<id>                 the existing deep link (unchanged)
//   #/t/<token>/scenario/<id>       both
//
// The token rides in the FRAGMENT, never a query string. A fragment is not
// sent to the server, so the token never reaches Azure access logs, App
// Insights request telemetry, or a Referer header on any outbound link. It is
// scrubbed from the address bar as soon as it is read, before a reviewer can
// copy the URL or screenshot it into a support thread.

export type ParsedRoute = {
  token: string | null;
  scenarioId: string | null;
};

const TOKEN_AND_SCENARIO = /^#\/t\/([^/]+)\/scenario\/(.+)$/;
const TOKEN_ONLY = /^#\/t\/([^/]+)\/?$/;
const SCENARIO_ONLY = /^#\/scenario\/(.+)$/;

export function parseHash(hash: string): ParsedRoute {
  const both = TOKEN_AND_SCENARIO.exec(hash);
  if (both) {
    return { token: decode(both[1]!), scenarioId: decode(both[2]!) };
  }

  const token = TOKEN_ONLY.exec(hash);
  if (token) return { token: decode(token[1]!), scenarioId: null };

  const scenario = SCENARIO_ONLY.exec(hash);
  if (scenario) return { token: null, scenarioId: decode(scenario[1]!) };

  return { token: null, scenarioId: null };
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A stray % makes decodeURIComponent throw; the raw value is more useful
    // than crashing the first paint.
    return value;
  }
}

/**
 * The hash to leave in the address bar once the token has been consumed.
 * Keeps a deep link if there was one, so a shared "#/t/…/scenario/x" still
 * lands on scenario x.
 */
export function scrubbedHash(route: ParsedRoute): string {
  return route.scenarioId ? `#/scenario/${encodeURIComponent(route.scenarioId)}` : '#/';
}
