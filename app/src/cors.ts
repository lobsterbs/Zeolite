/* Engine-route CORS response-header surgery (issue #2).

   The transport preserves the target's CORS response headers verbatim,
   which is never valid for an engine route: the response the page
   actually sees comes from the engine origin. A preserved target
   Access-Control-Allow-Origin (e.g. "https://excalidraw.com") fails
   the CORS check Chromium applies to every module-script and
   crossorigin-script response - module scripts are fetched with
   mode "cors" even same-origin, so the script downloads, never
   executes, and nothing is reported. That kills every ES-module site.

   Policy: engine routes serve their own origin. The target's CORS
   facts are dropped and replaced with values that describe the
   engine: uncredentialed requests get "*", credentialed ones get the
   engine origin itself ("*" is not legal with credentials).
   Cross-origin consumers fail closed: reflecting an arbitrary request
   origin would expose jar-authenticated proxied bodies to any site
   on the open web, so it is never done. */

export const CORS_RESPONSE_HEADERS = [
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-expose-headers",
  "access-control-max-age",
] as const;

/** Engine CORS values for one engine-route response. Pure. */
export function engineCorsValues(
  engineOrigin: string,
  credentials: string,
): Record<string, string> {
  if (credentials === "omit") {
    return { "access-control-allow-origin": "*" };
  }
  return {
    "access-control-allow-origin": engineOrigin,
    "access-control-allow-credentials": "true",
  };
}

/** Surgery: drop the target's CORS response headers, set the engine's.
    Mutates `out`. Applied on the live response path and on the page
    cache before storing, so cache hits cannot replay target CORS
    facts either. */
export function applyEngineCors(
  out: Headers,
  engineOrigin: string,
  credentials: string,
): void {
  for (const k of CORS_RESPONSE_HEADERS) out.delete(k);
  for (const [k, v] of Object.entries(engineCorsValues(engineOrigin, credentials))) {
    out.set(k, v);
  }
}
