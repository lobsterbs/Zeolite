/* Zeolite Doctor (#495): host-only, read-only diagnostic facts.
   No worker globals, transport initialization, credential access or
   arbitrary network probes live in this module. The caller supplies
   evidence from observed runtime state. Unknown != healthy. */

export type DoctorStatus = "pass" | "warn" | "fail" | "unknown" | "skipped";
export type DoctorBoot = "ready" | "failed" | "timeout";
export type DoctorConfigState = "not-loaded" | "loaded" | "missing" | "invalid" | "unavailable";
export interface DoctorCheck {
  code: string;
  status: DoctorStatus;
  summary: string;
  remedy?: string;
}
export interface DoctorReport {
  /** Request completed; not proof that the environment is healthy. */
  ok: boolean;
  /** null means unverified/partial; false means confirmed failed checks. */
  healthy: boolean | null;
  schemaVersion: 1;
  engineVersion: string;
  capturedAt: number;
  checks: DoctorCheck[];
}
export interface DoctorEvidence {
  engineVersion: string;
  boot: DoctorBoot;
  scriptUrl?: string;
  registrationScope?: string;
  expectedScope?: string;
  expectedVersion?: string;
  degraded: boolean;
  transport: "idle" | "connecting" | "connected" | "dead";
  selectedEngine: "epoxy" | "libcurl";
  relay: boolean;
  alternateWisp: boolean;
  primaryWisp: string;
  policy: DoctorConfigState;
  rules: DoctorConfigState;
  siteconfig: DoctorConfigState;
  /** Explicit selected-client verification supplied by the host-only
      control plane. Undefined means the host did not request a client check. */
  clientControl?: "pass" | "fail" | "unknown";
}
type Asset = {
  name: string;
  path: string;
  mime: "script" | "wasm";
  resolve: "script" | "sibling" | "root";
};
const ASSETS: readonly Asset[] = [
  { name: "service-worker", path: "", mime: "script", resolve: "script" },
  { name: "bootstrap", path: "bootstrap.js", mime: "script", resolve: "sibling" },
  { name: "codec", path: "codec.js", mime: "script", resolve: "sibling" },
  { name: "worker-prelude", path: "worker-prelude.js", mime: "script", resolve: "sibling" },
  { name: "rewriter-wasm", path: "rewriter_wasm_bg.wasm", mime: "wasm", resolve: "sibling" },
  /* Integration-guide contract: transport bundles live at the origin
     root even when the Service Worker itself is mounted below /zlsw/. */
  { name: "libcurl", path: "libcurl/index.mjs", mime: "script", resolve: "root" },
  { name: "epoxy-js", path: "epoxy/epoxy.js", mime: "script", resolve: "root" },
  { name: "epoxy-wasm", path: "epoxy/epoxy.wasm", mime: "wasm", resolve: "root" },
];

/** Outcome uses fixed human-readable labels; no raw secret-bearing URLs,
    error messages, request bodies, or credentials are copied into output. */
export function buildDoctor(e: DoctorEvidence, assetChecks: DoctorCheck[] = []): DoctorReport {
  const checks: DoctorCheck[] = [
    { code: "worker.running", status: "pass", summary: "Zeolite worker answered the doctor request" },
    { code: "worker.boot", status: e.boot === "ready" ? "pass" : e.boot === "failed" ? "fail" : "unknown",
      summary: e.boot === "ready" ? "Boot prerequisites resolved" : e.boot === "failed" ? "Boot prerequisites rejected" : "Boot prerequisites did not resolve within the check deadline",
      remedy: e.boot === "ready" ? undefined : "Inspect engine startup diagnostics and retry after the worker is ready" },
    { code: "worker.client-control",
      status: e.clientControl ?? "unknown",
      summary: e.clientControl === "pass" ? "Selected proxied client is live and controlled by this Zeolite worker" :
        e.clientControl === "fail" ? "Selected client is missing, stale, or no longer an engine-owned proxied route" :
        "No selected proxied client was supplied for verification",
      remedy: e.clientControl === "pass" ? undefined :
        e.clientControl === "fail" ? "Refresh/rebind the selected tab, then rerun Doctor with its current Service Worker client ID" :
        "Supply the selected proxied client's current Service Worker client ID" },
    { code: "worker.scope", status: "unknown", summary: "Expected scope was not supplied by the host",
      remedy: "Send the host's expected service worker scope to compare" },
    { code: "bundle.version", status: "unknown", summary: "No served bundle version was supplied by the host",
      remedy: "Compare the served asset version with zl:ping / Doctor engineVersion" },
    { code: "engine.initialization", status: e.degraded ? "fail" : "unknown",
      summary: e.degraded ? "Engine recorded a degraded initialization state" : "No degraded initialization flag; this alone does not prove all resources loaded",
      remedy: e.degraded ? "Inspect redacted startup diagnostics and asset availability" : "Run explicit asset probes and a real transport fixture" },
    { code: "transport.engine", status: "pass", summary: "Selected engine: " + e.selectedEngine },
    { code: "transport.lifecycle", status: e.transport === "connected" ? "pass" : e.transport === "dead" ? "fail" : e.transport === "connecting" ? "warn" : "unknown",
      summary: "Last observed transport state: " + e.transport,
      remedy: e.transport === "connected" ? undefined : "Check the configured WISP endpoint and transport diagnostics; no new connection was attempted" },
    { code: "transport.relay", status: e.relay ? "pass" : "warn",
      summary: e.relay ? "Host relay channel registered" : "No host relay channel registered (optional for WISP-only deployments)" },
    { code: "transport.alternate-wisp", status: e.alternateWisp ? "pass" : "skipped",
      summary: e.alternateWisp ? "An alternate WISP endpoint is configured" : "No optional alternate WISP endpoint configured" },
    { code: "transport.wisp-endpoint", status: "unknown", summary: "Endpoint was not inspected" },
    { code: "transport.wisp-auth", status: "unknown", summary: "Authentication handshake result cannot be inferred from endpoint configuration",
      remedy: "Use an explicitly authorized WISP handshake fixture to verify authentication" },
  ];
  try {
    const u = new URL(e.primaryWisp);
    const schemeOK = u.protocol === "wss:" || u.protocol === "ws:";
    const invalidSecret = !!(u.username || u.password);
    const invalidFragment = !!u.hash;
    const riskyQuery = !!u.search;
    checks[10] = {
      code: "transport.wisp-endpoint",
      status: !schemeOK || invalidSecret || invalidFragment ? "fail" :
        u.protocol === "ws:" || riskyQuery ? "warn" : "pass",
      summary: invalidSecret ? "Credentials embedded in the WISP URL are not a supported authentication path" :
        invalidFragment ? "A WISP WebSocket endpoint URL must not contain a fragment" :
        !schemeOK ? "Configured endpoint does not use the WISP WebSocket URL scheme" :
        u.protocol === "ws:" ? "An unencrypted WS endpoint is configured; reachability is unverified" :
        riskyQuery ? "WSS endpoint has query parameters; check that none contain credentials" :
        "A WSS endpoint is configured; reachability is unverified",
      remedy: invalidSecret || invalidFragment ? "Remove URL credentials/fragments; configure WISP authentication through a supported host-only protocol" :
        u.protocol === "ws:" ? "Configure WSS before transmitting credentials" :
        riskyQuery ? "Avoid credentials, access tokens, or secrets in the WISP endpoint URL" :
        schemeOK ? undefined : "Set a valid ws:// or wss:// WISP endpoint",
    };
  } catch {
    checks[10] = { code: "transport.wisp-endpoint", status: "fail",
      summary: "The configured WISP endpoint URL is invalid", remedy: "Set a valid ws:// or wss:// WISP endpoint" };
  }
  const actual = safeUrl(e.registrationScope);
  const expected = safeUrl(e.expectedScope);
  if (actual && expected) {
    checks[3] = { code: "worker.scope", status: actual === expected ? "pass" : "fail",
      summary: actual === expected ? "Worker registration scope matches the host's expected scope" : "Worker registration scope differs from the host's expected scope",
      remedy: actual === expected ? undefined : "Check the service-worker registration scope and Service-Worker-Allowed header" };
  } else if (e.expectedScope) {
    checks[3] = { code: "worker.scope", status: "unknown", summary: "The actual worker registration scope was not observable",
      remedy: "Verify the registration scope in the host browser" };
  }
  if (e.expectedVersion) checks[4] = {
    code: "bundle.version", status: e.expectedVersion === e.engineVersion ? "pass" : "fail",
    summary: e.expectedVersion === e.engineVersion ? "Worker version matches the host-provided served version" : "Worker version differs from the host-provided served version",
    remedy: e.expectedVersion === e.engineVersion ? undefined : "Re-publish the matching bundle and update the service worker",
  };
  for (const [name, state] of [["policy", e.policy], ["rules", e.rules], ["siteconfig", e.siteconfig]] as const) {
    checks.push({ code: "config." + name, status: state === "loaded" ? "pass" : state === "invalid" ? "fail" :
      state === "missing" ? "warn" : "unknown",
      summary: state === "loaded" ? name + ".kdl was loaded and parsed" :
        state === "missing" ? name + ".kdl returned 404; defaults may apply" :
        state === "invalid" ? name + ".kdl failed to parse or validate" :
        state === "unavailable" ? name + ".kdl load did not complete successfully" :
        name + ".kdl has not been loaded in this worker instance",
      remedy: state === "loaded" ? undefined : "Verify the host's " + name + ".kdl deployment and KDL syntax" });
  }
  const swAllowed = assetChecks.find(c => c.code === "worker.service-worker-allowed");
  const swCache = assetChecks.find(c => c.code === "worker.cache-policy");
  checks.push(swAllowed ?? {
    code: "worker.service-worker-allowed", status: "unknown",
    summary: "Service-Worker-Allowed response header was not actively inspected",
    remedy: "Run Doctor with probeAssets=true to inspect the served worker response",
  });
  checks.push(swCache ?? {
    code: "worker.cache-policy", status: "unknown",
    summary: "Service Worker response caching policy was not actively inspected",
    remedy: "Run Doctor with probeAssets=true to verify Cache-Control on the worker script",
  });
  checks.push({ code: "build.bootstrap-budget", status: "unknown",
    summary: "Minified bootstrap byte budget is a CI build fact, not a runtime measurement" });
  const probedAssets = assetChecks.filter(c => c.code.startsWith("assets."));
  checks.push(...(probedAssets.length ? probedAssets.slice(0, ASSETS.length) :
    ASSETS.map(a => ({ code: "assets." + a.name, status: "skipped" as const,
      summary: "Passive check: no HTTP asset probe attempted" }))));
  return {
    ok: true,
    healthy: checks.some(x => x.status === "fail") ? false :
      checks.every(x => x.status === "pass" || x.status === "skipped") ? true : null,
    schemaVersion: 1,
    engineVersion: e.engineVersion,
    capturedAt: Date.now(),
    checks,
  };
}
function safeUrl(v: string | undefined): string | null {
  if (!v) return null;
  try {
    const u = new URL(v);
    if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.search || u.hash) return null;
    return u.href;
  } catch {
    return null;
  }
}

/** Only static same-origin worker-sibling assets. Caller must be the
    verified host and explicitly set probeAssets=true. No user-supplied
    URLs, remote WISP probe, header credentials or KDL fetch. */
let activeAssetProbe: Promise<DoctorCheck[]> | null = null;
export async function probeDoctorAssets(
  scriptUrl: string,
  doFetch: typeof fetch,
  timeoutMs = 1500,
  registrationScope?: string,
): Promise<DoctorCheck[]> {
  if (activeAssetProbe) return activeAssetProbe;
  const run = probeDoctorAssetsOnce(scriptUrl, doFetch, timeoutMs, registrationScope);
  activeAssetProbe = run;
  try {
    return await run;
  } finally {
    if (activeAssetProbe === run) activeAssetProbe = null;
  }
}

async function probeDoctorAssetsOnce(
  scriptUrl: string,
  doFetch: typeof fetch,
  timeoutMs: number,
  registrationScope?: string,
): Promise<DoctorCheck[]> {
  let base: URL;
  try {
    base = new URL(scriptUrl);
    if (!/^https?:$/.test(base.protocol) || base.username || base.password) throw new TypeError();
  } catch {
    return ASSETS.map(a => ({ code: "assets." + a.name, status: "unknown",
      summary: "Worker script URL unavailable; safe same-origin probing skipped" }));
  }
  const assetChecks = await Promise.all(ASSETS.map(async (a): Promise<DoctorCheck> => {
    const code = "assets." + a.name;
    const url = a.resolve === "script" ? new URL(base.href) :
      a.resolve === "root" ? new URL("/" + a.path.replace(/^\/+/, ""), base.origin) :
      new URL(a.path, base);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), Math.max(100, Math.min(3000, timeoutMs)));
    try {
      const r = await doFetch(url.href, { method: "HEAD", cache: "no-store",
        redirect: "manual", credentials: "omit", signal: abort.signal });
      if (r.status === 404 || r.type === "opaqueredirect" || (r.status >= 300 && r.status < 400))
        return { code, status: "fail", summary: "Asset missing or redirected away from its expected path",
          remedy: "Check the bundle's static asset routes and subpath aliases" };
      if (r.status === 405 || r.status === 501)
        return { code, status: "unknown", summary: "Server does not support HEAD; asset body was not fetched" };
      if (!r.ok)
        return { code, status: "unknown", summary: "Asset HEAD request was unsuccessful (not enough evidence to classify missing)" };
      const mime = (r.headers.get("content-type") ?? "").toLowerCase().split(";")[0].trim();
      const allowed = a.mime === "wasm" ? mime === "application/wasm" :
        mime === "text/javascript" || mime === "application/javascript" ||
        mime === "application/x-javascript";
      const nosniff = (r.headers.get("x-content-type-options") ?? "").toLowerCase() === "nosniff";
      if (!allowed) return {
        code, status: mime === "text/html" ? "fail" : "warn",
        summary: mime === "text/html" ? "Asset served HTML instead of the required content type" :
          "Asset response MIME type is missing or unexpected",
        remedy: "Verify build artifacts, Content-Type headers and static route fallbacks",
      };
      return nosniff ? { code, status: "pass",
        summary: "Asset answered HEAD with expected MIME type and nosniff" } :
        { code, status: "warn",
          summary: "Asset MIME type is correct but X-Content-Type-Options: nosniff was not observed",
          remedy: "Serve executable/WASM assets with X-Content-Type-Options: nosniff" };
    } catch {
      return { code, status: "unknown", summary: "Asset HEAD request timed out or failed; availability unverified" };
    } finally {
      clearTimeout(timer);
    }
  }));

  /* The worker script's own response has two integration-specific
     requirements from docs/integration-guide.md. Inspect them only
     when the explicit active probe was requested. */
  const swUrl = new URL(base.href);
  const swResultIndex = ASSETS.findIndex(a => a.name === "service-worker");
  const swAsset = swResultIndex >= 0 ? assetChecks[swResultIndex] : undefined;
  let allowedCheck: DoctorCheck = {
    code: "worker.service-worker-allowed", status: "unknown",
    summary: "Worker scope header could not be verified",
  };
  let cacheCheck: DoctorCheck = {
    code: "worker.cache-policy", status: "unknown",
    summary: "Worker cache policy could not be verified",
  };

  if (swAsset?.status === "pass" || swAsset?.status === "warn") {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), Math.max(100, Math.min(3000, timeoutMs)));
    try {
      const r = await doFetch(swUrl.href, { method: "HEAD", cache: "no-store",
        redirect: "manual", credentials: "omit", signal: abort.signal });
      const scope = safeUrl(registrationScope);
      if (scope) {
        const scopeUrl = new URL(scope);
        const scriptDir = new URL(".", swUrl);
        const needsHeader = scopeUrl.origin === swUrl.origin &&
          !scopeUrl.pathname.startsWith(scriptDir.pathname);
        const raw = (r.headers.get("service-worker-allowed") ?? "").trim();
        if (!needsHeader) {
          allowedCheck = { code: "worker.service-worker-allowed", status: "pass",
            summary: raw ? "Service-Worker-Allowed is present; current scope is within the script directory" :
              "Current registration scope is within the worker script directory; no broader-scope header is required" };
        } else if (!raw) {
          allowedCheck = { code: "worker.service-worker-allowed", status: "fail",
            summary: "Worker is registered outside its script directory but Service-Worker-Allowed is missing",
            remedy: "Serve the worker with Service-Worker-Allowed covering the configured registration scope" };
        } else {
          let allowed: URL | null = null;
          try { allowed = new URL(raw, swUrl); } catch { /* invalid below */ }
          const covers = !!allowed && allowed.origin === swUrl.origin &&
            scopeUrl.pathname.startsWith(allowed.pathname);
          allowedCheck = covers ? {
            code: "worker.service-worker-allowed", status: "pass",
            summary: "Service-Worker-Allowed covers the active registration scope",
          } : {
            code: "worker.service-worker-allowed", status: "fail",
            summary: "Service-Worker-Allowed does not cover the active registration scope",
            remedy: "Set Service-Worker-Allowed to a same-origin path that contains the worker scope",
          };
        }
      }

      const cc = (r.headers.get("cache-control") ?? "").toLowerCase();
      const fresh = /(?:^|,)\s*(?:no-cache|no-store)(?:\s*(?:,|$)|\s*=)/.test(cc);
      cacheCheck = fresh ? {
        code: "worker.cache-policy", status: "pass",
        summary: "Worker script cache policy requires revalidation or disables storage",
      } : {
        code: "worker.cache-policy", status: "warn",
        summary: "Worker script response did not advertise no-cache or no-store",
        remedy: "Serve the worker with Cache-Control: no-cache to avoid stale pinned worker bytes",
      };
    } catch {
      /* The asset result already records reachability; preserve these
         header-specific checks as unknown rather than duplicating it. */
    } finally {
      clearTimeout(timer);
    }
  }
  return [...assetChecks, allowedCheck, cacheCheck];
}

/** Small deadline independent of transport startup; failed initialization
    must still yield a doctor report rather than wedge the caller. */
export async function observeDoctorBoot(ready: Promise<unknown>, deadlineMs = 750): Promise<DoctorBoot> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<DoctorBoot>([
      ready.then(() => "ready" as const, () => "failed" as const),
      new Promise<DoctorBoot>(resolve => { timer = setTimeout(() => resolve("timeout"), deadlineMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** V1 KDL report, deliberately no raw addresses or arbitrary diagnostic
    strings. Reuse this typed check collection with the shared #494
    diagnostic exporter when that schema becomes available. */
export function doctorKdl(report: DoctorReport): string {
  const q = (value: string) =>
    JSON.stringify(value.replace(/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/g, "\uFFFD"));
  return "zeolite-doctor version=1 engine=" + q(report.engineVersion) +
    " captured-at=" + report.capturedAt + " ok=#" + report.ok +
    " health=" + q(report.healthy === null ? "unknown" : report.healthy ? "pass" : "fail") + " {\n" +
    report.checks.map(c =>
      "  check " + q(c.code) + " status=" + q(c.status) +
      " summary=" + q(c.summary) + (c.remedy ? " remedy=" + q(c.remedy) : "")
    ).join("\n") + "\n}\n";
}
