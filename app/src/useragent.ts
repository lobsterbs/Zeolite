/* Shared UA identity for wire/window/worker. No physical-device reads or TLS claims. */
export interface UaBrand { brand: string; version: string }
export interface UaIdentity {
  brands: UaBrand[]; mobile: boolean; platform: string;
  uaFullVersion?: string; fullVersionList?: UaBrand[];
  architecture?: string; bitness?: string;
}

function chPlatform(ua: string): string {
  if (/Windows NT/.test(ua)) return "Windows";
  if (/Android/.test(ua)) return "Android";
  if (/CrOS/.test(ua)) return "Chrome OS";
  // iOS Chromium UAs carry "like Mac OS X": the iOS check must precede
  // the Mac branch or iPhone/iPad UAs report themselves as macOS.
  if (/iPhone|iPad/.test(ua)) return "iOS";
  if (/Macintosh|Mac OS X/.test(ua)) return "macOS";
  if (/Linux|X11/.test(ua)) return "Linux";
  return "";
}

/* Chromium's GREASE brand and the brand-list order are deterministic
   functions of the major version (verified against
   components/embedder_support/user_agent_utils.cc:
   GetGreasedUserAgentBrandVersion, GetRandomOrder, ShuffleBrandList).
   A fixed "Not_A Brand";v="8" in a fixed order is a list no real
   Chromium of that major ever sends, a #160-class fingerprint tell. */
const GREASE_CHARS = [" ", "(", ":", "-", ".", "/", ")", ";", "=", "?", "_"];
const GREASE_VERSIONS = ["8", "99", "24"];

function greasedBrand(major: number): string {
  return (
    "Not" +
    GREASE_CHARS[major % GREASE_CHARS.length] +
    "A" +
    GREASE_CHARS[(major + 1) % GREASE_CHARS.length] +
    "Brand"
  );
}

/* Chromium builds [grease, Chromium, own brand] and permutes it with a
   fixed table indexed by major % 6 (size 3; size 2 uses
   [seed % 2, (seed + 1) % 2]). Placement direction:
   out[order[i]] = list[i]. */
function shuffledBrands<T>(list: T[], major: number): T[] {
  const orders3 = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ];
  const order =
    list.length === 3 ? orders3[major % orders3.length] : [major % 2, (major + 1) % 2];
  const out: T[] = new Array(list.length);
  for (let i = 0; i < order.length; i++) out[order[i]] = list[i];
  return out;
}

export function clientHintsForUa(userAgent: string): UaIdentity | null {
  const m = /(?:Chrome|Chromium)\/(\d+(?:\.\d+){0,3})(?=[^\d.]|$)/.exec(userAgent);
  if (!m) return null;
  const major = Number(m[1].split(".")[0]);
  if (!Number.isSafeInteger(major)) return null;
  const entries: UaBrand[] = [
    { brand: greasedBrand(major), version: GREASE_VERSIONS[major % GREASE_VERSIONS.length] },
    { brand: "Chromium", version: String(major) },
  ];
  if (/Chrome\/\d+/.test(userAgent)) entries.push({ brand: "Google Chrome", version: String(major) });
  const brands = shuffledBrands(entries, major);
  const data: UaIdentity = { brands, mobile: /Android.+Mobile|iPhone/.test(userAgent), platform: chPlatform(userAgent) };
  if (/^\d+\.\d+\.\d+\.\d+$/.test(m[1])) {
    data.uaFullVersion = m[1];
    data.fullVersionList = brands.map((b) => ({ brand: b.brand, version: b.brand === "Chromium" || b.brand === "Google Chrome" ? m[1] : b.version + ".0.0.0" }));
  }
  // Only explicit CPU markers are useful; OS/model values are frequently frozen.
  if (/aarch64|arm64/i.test(userAgent)) { data.architecture = "arm"; data.bitness = "64"; }
  else if (/x64|x86_64|amd64/i.test(userAgent)) { data.architecture = "x86"; data.bitness = "64"; }
  else if (/i[3-6]86/.test(userAgent)) { data.architecture = "x86"; data.bitness = "32"; }
  return data;
}
export function formatUaBrands(brands: UaBrand[]): string {
  return brands.map((b) => JSON.stringify(b.brand) + ";v=" + JSON.stringify(b.version)).join(", ");
}

/** Patch only an existing NavigatorUAData object, preserving its native
    prototype. Unknown high-entropy values stay absent, never physical. */
export function userAgentDataScript(userAgent: string, navigatorPrototype: string): string {
  const data = clientHintsForUa(userAgent);
  if (!data) return `if ("userAgentData" in globalThis.navigator) prop(${navigatorPrototype}, "userAgentData", function () { return undefined; });`;
  return `try {
  var zlUaData = globalThis.navigator.userAgentData;
  if (zlUaData) {
    var zlUaIdentity = ${JSON.stringify(data)};
    var zlUaCopy = function (v) { return Array.isArray(v) ? v.map(function (b) { return { brand: b.brand, version: b.version }; }) : v; };
    var zlUaLow = function () { return { brands: zlUaCopy(zlUaIdentity.brands), mobile: zlUaIdentity.mobile, platform: zlUaIdentity.platform }; };
    for (var zlUaKey of ["brands", "mobile", "platform"]) {
      (function (key) { prop(zlUaData, key, function () { return zlUaCopy(zlUaIdentity[key]); }); })(zlUaKey);
    }
    Object.defineProperty(zlUaData, "toJSON", { configurable: true, value: function () { return zlUaLow(); } });
    Object.defineProperty(zlUaData, "getHighEntropyValues", { configurable: true, value: function (hints) {
      return Promise.resolve().then(function () {
        if (hints === null || (typeof hints !== "object" && typeof hints !== "function")) throw new TypeError("hints must be a sequence");
        var result = zlUaLow();
        for (var key of hints) {
          if (Object.prototype.hasOwnProperty.call(zlUaIdentity, key)) result[key] = zlUaCopy(zlUaIdentity[key]);
        }
        return result;
      });
    } });
  }
} catch (e) {}`;
}
