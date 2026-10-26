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
}
type Asset = { name: string; path: string; mime: "script" | "wasm" };
const ASSETS: readonly Asset[] = [
  { name: "bootstrap", path: "bootstrap.js", mime: "script" },
  { name: "codec", path: "codec.js", mime: "script" },
  { name: "worker-prelude", path: "worker-prelude.js", mime: "script" },
  { name: "rewriter-wasm", path: "rewriter_wasm_bg.wasm", mime: "wasm" },
];

/** Outcome uses fixed human-readable labels; no raw secret-bearing URLs,
    error messages, request bodies, or credentials are copied into output. */
export function buildDoctor(e: DoctorEvidence, assetChecks: DoctorCheck[] = []): DoctorReport {
  const checks: DoctorCheck[] = [
    { code: "worker.running", status: "pass", summary: "Zeolite worker answered the doctor request" },
    { code: "worker.boot", status: e.boot === "ready" ? "pass" : e.boot === "failed" ? "fail" : "unknown",
      summary: e.boot === "ready" ? "Boot prerequisites resolved" : e.boot === "failed" ? "Boot prerequisites rejected" : "Boot prerequisites did not resolve within the check deadline",
      remedy: e.boot === "ready" ? undefined : "Inspect engine startup diagnostics and retry after the worker is ready" },
    { code: "worker.client-control", status: "unknown", summary: "Worker-side host message does not prove the selected tab is controlled",
      remedy: "Confirm navigator.serviceWorker.controller in the selected host document" },
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
    checks[10] = {
      code: "transport.wisp-endpoint",
      status: (u.protocol === "wss:" || u.protocol === "ws:") ? (u.protocol === "wss:" ? "pass" : "warn") : "fail",
      summary: u.protocol === "wss:" ? "A WSS endpoint is configured; reachability is unverified" :
        u.protocol === "ws:" ? "An unencrypted WS endpoint is configured; reachability is unverified" :
        "Configured endpoint does not use the WISP WebSocket URL scheme",
      remedy: u.protocol === "wss:" ? undefined : "Configure a WSS endpoint when serving credentials or mixed-origin clients",
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
  checks.push({ code: "worker.asset-headers", status: "unknown",
    summary: "Service-Worker-Allowed and worker response caching headers are not verified by this worker",
    remedy: "Inspect registration-script response headers from the host" });
  checks.push({ code: "build.bootstrap-budget", status: "unknown",
    summary: "Minified bootstrap byte budget is a CI build fact, not a runtime measurement" });
  checks.push(...(assetChecks.length ? assetChecks.slice(0, ASSETS.length) :
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
): Promise<DoctorCheck[]> {
  if (activeAssetProbe) return activeAssetProbe;
  const run = probeDoctorAssetsOnce(scriptUrl, doFetch, timeoutMs);
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
): Promise<DoctorCheck[]> {
  let base: URL;
  try {
    base = new URL(scriptUrl);
    if (!/^https?:$/.test(base.protocol) || base.username || base.password) throw new TypeError();
  } catch {
    return ASSETS.map(a => ({ code: "assets." + a.name, status: "unknown",
      summary: "Worker script URL unavailable; safe same-origin probing skipped" }));
  }
  return Promise.all(ASSETS.map(async (a): Promise<DoctorCheck> => {
    const code = "assets." + a.name;
    const url = new URL(a.path, base);
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
        mime === "text/javascript" || mime === "application/javascript" || mime === "application/x-javascript";
      return allowed ? { code, status: "pass", summary: "Asset answered HEAD with expected MIME type" } :
        { code, status: mime === "text/html" ? "fail" : "warn",
          summary: mime === "text/html" ? "Asset served HTML instead of the required content type" :
            "Asset response MIME type is missing or unexpected",
          remedy: "Verify build artifacts, Content-Type headers and static route fallbacks" };
    } catch {
      return { code, status: "unknown", summary: "Asset HEAD request timed out or failed; availability unverified" };
    } finally {
      clearTimeout(timer);
    }
  }));
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
    JSON.stringify(value.replace(/[\\u0000-\\u0008\\u000b\\u000e-\\u001f\\u007f]/g, "\\uFFFD"));
  return "zeolite-doctor version=1 engine=" + q(report.engineVersion) +
    " captured-at=" + report.capturedAt + " ok=#" + report.ok +
    " health=" + q(report.healthy === null ? "unknown" : report.healthy ? "pass" : "fail") + " {\n" +
    report.checks.map(c =>
      "  check " + q(c.code) + " status=" + q(c.status) +
      " summary=" + q(c.summary) + (c.remedy ? " remedy=" + q(c.remedy) : "")
    ).join("\n") + "\n}\n";
}
