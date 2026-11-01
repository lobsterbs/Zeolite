/* Fingerprinting resistance (Phase 8, 1.8 Telluride).

   One internally-consistent config object - a FingerprintProfile -
   drives every spoofed surface: userAgent, platform, language(s),
   hardwareConcurrency, deviceMemory, screen, timezone, canvas and
   WebGL. The profile is DATA, configurable by the host app through the
   zl:fingerprint control message; the engine never invents values.

   Design rules (docs/fingerprint.md):
   - No per-session randomization. The default profile is fixed and
     every derived value (including the canvas perturbation) is a
     pure function of the profile, so two sessions with the same
     profile are indistinguishable from each other on purpose.
   - No contradictory values. resolveProfile derives what the host
     left out (platform from the UA) and refuses profiles whose
     explicit values contradict each other.
   - The compiled surface script is deterministic: no Math.random, no
     Date.now, no per-compile variation.
   - Honesty over coverage: surfaces the engine does not patch are
     listed as limits, not faked.

   How it ships: the service worker compiles fingerprintScript(p) once
   per zl:fingerprint message and prepends it to the window.__ZL init
   script it already emits as the first chunk of every rewritten HTML
   document. Engine-initiated upstream requests carry the same profile
   User-Agent and Accept-Language, so the page surface and the wire
   surface agree. Workers get the worker prelude, not this script:
   fingerprint spoofing applies to documents only (documented). */

import { userAgentDataScript } from "./useragent";

export interface ScreenShape {
  width: number;
  height: number;
  availWidth: number;
  availHeight: number;
  colorDepth: number;
  pixelDepth: number;
}

export interface FingerprintProfile {
  /** True by default: match profile UA/platform/Client Hints on page,
      worker and wire. False leaves these identity surfaces native.
      Neither mode changes the selected transport's TLS handshake. */
  matchUserAgent?: boolean;
  userAgent: string;
  platform: string;
  /** navigator.language / languages; also the upstream Accept-Language. */
  languages: string[];
  /** Minutes ahead of UTC, e.g. Oslo summer = 120; null = native time. */
  utcOffsetMin: number | null;
  /** IANA zone name shown to Intl; null = native. Kept consistent with
      utcOffsetMin by the host - the engine carries no tz database. */
  timezoneName: string | null;
  /** navigator.hardwareConcurrency; null = native. */
  hardwareConcurrency: number | null;
  /** navigator.deviceMemory in GB (Chrome reports powers of two); null = native. */
  deviceMemoryGB: number | null;
  /** window.screen; null = native. */
  screen: ScreenShape | null;
  /** WebGL UNMASKED_VENDOR/UNMASKED_RENDERER; both or neither. */
  webglVendor: string | null;
  webglRenderer: string | null;
  /** #141: deterministic AnalyserNode read noise, seeded from
      canvasSeed so one profile yields one surface; false = native. */
  audioNoise: boolean;

  /** Deterministic seed for canvas perturbation; fixed strings, never
      randomized per session. */
  canvasSeed: string;
  /** #540: set by resolveProfile when an explicit Etc/GMT
      timezoneName contradicts utcOffsetMin under the IANA sign
      mapping. The explicit name still wins for Intl (user input is
      never silently rewritten); the conflict is recorded, not hidden. */
  timezoneInconsistent?: boolean;
  /** Engine binding (#71): the transport engines this profile is
      valid for. The TLS fingerprint (JA3/H2) is a property of the
      transport engine, never of the profile, so a profile bound away
      from the live engine is refused, not silently applied under a
      different TLS stack. */
  engines: Array<"libcurl" | "epoxy">;
}

/** A coherent, modern Chrome-on-Windows desktop profile. Every field
    is internally consistent (Win32 platform, Chrome UA, ANGLE-on-NVIDIA
    renderer strings a real Chrome would report). */
export const DEFAULT_PROFILE: FingerprintProfile = {
  matchUserAgent: true,
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
  platform: "Win32",
  languages: ["en-US", "en"],
  utcOffsetMin: 0,
  timezoneName: "UTC",
  hardwareConcurrency: 8,
  deviceMemoryGB: 8,
  screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelDepth: 24 },
  webglVendor: "Google Inc. (NVIDIA)",
  webglRenderer:
    "ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 (0x00001f83) Direct3D11 vs_5_0 ps_5_0, D3D11)",
  audioNoise: false,
  canvasSeed: "zeolite-telluride",
  engines: ["libcurl", "epoxy"],
};

/** Platform a real browser would pair with the given UA string. */
function platformForUa(ua: string): string {
  if (/Windows NT/.test(ua)) return "Win32";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "MacIntel";
  if (/Android/.test(ua)) return "Linux armv8l";
  if (/Mac OS X|Macintosh/.test(ua)) return "MacIntel";
  if (/Linux|X11/.test(ua)) return "Linux x86_64";
  return "";
}

const ALLOWED_PLATFORMS = new Set(["Win32", "MacIntel", "iPhone", "Linux x86_64", "Linux armv8l"]);

/* #540: the engine will NOT carry a timezone database. The profile's
   timezone contract is narrowed to a self-consistent fixed offset
   expressed through the real IANA Etc/GMT zones, which are fixed
   offsets with NO DST. IANA's Etc/GMT-N convention inverts the sign
   on purpose: Etc/GMT-5 is UTC+5. Non-whole-hour offsets (and west
   offsets beyond Etc/GMT+12, which IANA does not define) use an
   Intl offset string like "+05:30" instead - Intl accepts those, so
   Date and Intl still agree everywhere. */

/** The Intl timeZone string for a profile offset: a real IANA zone
    when one exists, else an offset string. */
export function canonicalZoneForOffset(min: number): { zone: string; kind: "iana" | "offset" } {
  if (min === 0) return { zone: "Etc/GMT", kind: "iana" };
  if (min % 60 === 0) {
    const h = min / 60;
    if (h > 0 && h <= 14) return { zone: "Etc/GMT-" + h, kind: "iana" };
    if (h < 0 && h >= -12) return { zone: "Etc/GMT+" + -h, kind: "iana" };
  }
  return { zone: offsetZoneString(min), kind: "offset" };
}

/** "+05:30" / "-13:00" form, always with sign and both digits. */
export function offsetZoneString(min: number): string {
  const sign = min < 0 ? "-" : "+";
  const a = Math.abs(min);
  return sign + String(Math.floor(a / 60)).padStart(2, "0") + ":" + String(a % 60).padStart(2, "0");
}

/** The UTC offset an Etc/GMT zone NAME denotes (sign-mapped), or null
    when the name is not an Etc/GMT zone. Only Etc names can be
    verified without a tz database; anything else is not checked. */
export function etcNameOffsetMin(name: string): number | null {
  if (/^Etc\/GMT$/i.test(name)) return 0;
  const m = /^Etc\/GMT([+-])([0-9]{1,2})$/i.exec(name);
  if (!m || Number(m[2]) > 14) return null;
  return m[1] === "-" ? Number(m[2]) * 60 : -Number(m[2]) * 60;
}

export interface TimezoneIdentity {
  /** The Intl timeZone: an explicit profile name wins over the
      offset-derived canonical zone. */
  zone: string;
  /** True when the zone was derived from utcOffsetMin (no explicit
      profile name). */
  derived: boolean;
}

/** The timezone identity a profile presents to Intl, or null when the
    profile sets neither field (both surfaces stay native, #223). */
export function timezoneIdentityFor(p: Pick<FingerprintProfile, "utcOffsetMin" | "timezoneName">): TimezoneIdentity | null {
  if (p.timezoneName) return { zone: p.timezoneName, derived: false };
  if (p.utcOffsetMin !== null) return { zone: canonicalZoneForOffset(p.utcOffsetMin).zone, derived: true };
  return null;
}

function isPosInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/** Validate + normalize a host-supplied profile object. Derives what is
    missing and refuses contradictions. Throws Error with a plain
    message on anything it cannot make consistent. */
export function resolveProfile(input: unknown): FingerprintProfile {
  if (typeof input !== "object" || input === null) throw new Error("profile must be an object");
  const p = input as Partial<FingerprintProfile>;
  if (p.matchUserAgent !== undefined && typeof p.matchUserAgent !== "boolean") throw new Error("matchUserAgent must be a boolean");
  if (typeof p.userAgent !== "string" || !p.userAgent.startsWith("Mozilla/5.0 (")) {
    throw new Error("userAgent must be a full browser UA string");
  }
  const derived = platformForUa(p.userAgent);
  let platform: string;
  if (p.platform === undefined) {
    platform = derived;
    if (!platform) throw new Error("cannot derive platform from userAgent");
  } else if (typeof p.platform !== "string" || !ALLOWED_PLATFORMS.has(p.platform)) {
    throw new Error("unknown platform");
  } else {
    if (derived && p.platform !== derived) {
      throw new Error("contradictory platform for userAgent");
    }
    platform = p.platform;
  }

  let languages: string[];
  if (p.languages === undefined) languages = ["en-US", "en"];
  else if (
    !Array.isArray(p.languages) ||
    p.languages.length === 0 ||
    p.languages.some((l) => typeof l !== "string" || !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/i.test(l))
  ) {
    throw new Error("languages must be a non-empty array of BCP-47-ish strings");
  } else languages = p.languages.slice();

  let utcOffsetMin: number | null;
  if (p.utcOffsetMin === undefined || p.utcOffsetMin === null) utcOffsetMin = null;
  else if (typeof p.utcOffsetMin !== "number" || !Number.isInteger(p.utcOffsetMin) || Math.abs(p.utcOffsetMin) > 14 * 60) {
    throw new Error("utcOffsetMin must be an integer within +/-14h of UTC");
  } else utcOffsetMin = p.utcOffsetMin;

  let timezoneName: string | null;
  if (p.timezoneName === undefined || p.timezoneName === null) timezoneName = null;
  else if (typeof p.timezoneName !== "string" || !/^[A-Za-z0-9_+\-/]+$/.test(p.timezoneName)) {
    throw new Error("timezoneName must be an IANA-style zone name");
  } else timezoneName = p.timezoneName;

  /* #540: an explicit Etc/GMT name can be checked against utcOffsetMin
     with the IANA sign mapping alone. On contradiction the explicit
     name still wins (never silently rewritten); the conflict is
     recorded. Non-Etc names cannot be verified without a tz database
     and are deliberately not checked. */
  let timezoneInconsistent = false;
  if (utcOffsetMin !== null && timezoneName !== null) {
    const etc = etcNameOffsetMin(timezoneName);
    if (etc !== null && etc !== utcOffsetMin) timezoneInconsistent = true;
  }

  let hardwareConcurrency: number | null;
  if (p.hardwareConcurrency === undefined || p.hardwareConcurrency === null) hardwareConcurrency = null;
  else if (!isPosInt(p.hardwareConcurrency) || p.hardwareConcurrency > 256) {
    throw new Error("hardwareConcurrency must be an integer in 1..256");
  } else hardwareConcurrency = p.hardwareConcurrency;

  let deviceMemoryGB: number | null;
  if (p.deviceMemoryGB === undefined || p.deviceMemoryGB === null) deviceMemoryGB = null;
  else if (typeof p.deviceMemoryGB !== "number" || p.deviceMemoryGB < 0.25 || p.deviceMemoryGB > 128) {
    throw new Error("deviceMemoryGB must be in 0.25..128");
  } else deviceMemoryGB = p.deviceMemoryGB;

  let screen: ScreenShape | null;
  if (p.screen === undefined || p.screen === null) screen = null;
  else {
    const s = p.screen as Partial<ScreenShape>;
    const fields = [s.width, s.height, s.availWidth, s.availHeight, s.colorDepth, s.pixelDepth];
    if (fields.some((f) => !isPosInt(f))) throw new Error("screen fields must be positive integers");
    if (s.availWidth! > s.width! || s.availHeight! > s.height!) {
      throw new Error("screen avail* cannot exceed the full screen");
    }
    screen = { width: s.width!, height: s.height!, availWidth: s.availWidth!, availHeight: s.availHeight!, colorDepth: s.colorDepth!, pixelDepth: s.pixelDepth! };
  }

  const vendor = p.webglVendor;
  const renderer = p.webglRenderer;
  if ((vendor === undefined || vendor === null) !== (renderer === undefined || renderer === null)) {
    throw new Error("webglVendor and webglRenderer come as a pair");
  }
  if (vendor !== undefined && vendor !== null && (typeof vendor !== "string" || typeof renderer !== "string" || !vendor || !renderer)) {
    throw new Error("webglVendor/webglRenderer must be non-empty strings");
  }

  let canvasSeed: string;
  if (p.canvasSeed === undefined || p.canvasSeed === null) canvasSeed = DEFAULT_PROFILE.canvasSeed;
  else if (typeof p.canvasSeed !== "string" || p.canvasSeed.length > 128 || !p.canvasSeed) {
    throw new Error("canvasSeed must be a non-empty string (<= 128 chars)");
  } else canvasSeed = p.canvasSeed;

  /* #141: AnalyserNode noise is a profile-driven option; absent
     means off, never invented. */
  let audioNoise: boolean;
  if (p.audioNoise === undefined || p.audioNoise === null) audioNoise = false;
  else if (typeof p.audioNoise !== "boolean") {
    throw new Error("audioNoise must be a boolean");
  } else audioNoise = p.audioNoise;

  /* #71: optional engine binding. Absent = valid for both engines;
     anything else must be a non-empty list of known engine names.
     Duplicates collapse; order is preserved for the refusal message. */
  let engines: Array<"libcurl" | "epoxy">;
  if (p.engines === undefined || p.engines === null) {
    engines = ["libcurl", "epoxy"];
  } else if (
    !Array.isArray(p.engines) ||
    p.engines.length === 0 ||
    !p.engines.every((e) => e === "libcurl" || e === "epoxy")
  ) {
    throw new Error("engines must be a non-empty array of libcurl|epoxy");
  } else {
    engines = [...new Set(p.engines)];
  }

  return {
    matchUserAgent: p.matchUserAgent ?? true,
    userAgent: p.userAgent,
    platform,
    languages,
    utcOffsetMin,
    timezoneName,
    ...(timezoneInconsistent ? { timezoneInconsistent: true } : {}),
    hardwareConcurrency,
    deviceMemoryGB,
    screen,
    webglVendor: (vendor as string | null) ?? null,
    webglRenderer: (renderer as string | null) ?? null,
    audioNoise,
    canvasSeed,
    engines,
  };
}

/** #71: the refusal reason when a profile is bound away from the
    given engine, or null when it applies. Refusal, never silent
    application: the TLS handshake fingerprint changes with the
    engine, so a bound profile under the wrong engine would lie about
    the fingerprint context the session is actually in. */
export function engineBindingError(p: FingerprintProfile, engine: string): string | null {
  if (p.engines.includes(engine as "libcurl" | "epoxy")) return null;
  return (
    "profile is bound to " + p.engines.join("|") + "; current engine is " + engine
  );
}

/* Deterministic canvas seed: FNV-1a over the profile seed. Two sessions
   with the same profile perturb identically; there is no per-session
   component. */
export function canvasSeedHash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/* #540: shared Date/Intl patch sources so the document and worker
   scripts stay identical for the same profile. The Date surface stays
   a fixed offset (getTimezoneOffset = -zlOff; local getters are an
   offset shift) and the zone ANNOTATION is formatted from the offset
   so toString/toTimeString agree with the patched local getters.
   Chromium prints Etc/GMT zones as "GMT+0200 (GMT+02:00)"; the text is
   derived from the offset directly, without a tz database. toJSON
   stays the UTC ISO form (toISOString): real Chromium prints it
   identically in every zone, so "Z" IS the consistent annotation. */
function dateOffsetScript(off: number): string {
  return `
try {
  var zlOff = ${off};
  Date.prototype.getTimezoneOffset = function () { return -zlOff; };
  var pairs = [["getFullYear", "getUTCFullYear"], ["getMonth", "getUTCMonth"], ["getDate", "getUTCDate"], ["getDay", "getUTCDay"], ["getHours", "getUTCHours"], ["getMinutes", "getUTCMinutes"], ["getSeconds", "getUTCSeconds"], ["getMilliseconds", "getUTCMilliseconds"]];
  for (var i = 0; i < pairs.length; i++) {
    (function (local, utc) {
      var orig = Date.prototype[utc];
      Date.prototype[local] = function () { return orig.call(new Date(this.getTime() + zlOff * 60000)); };
    })(pairs[i][0], pairs[i][1]);
  }
  var origYear = Date.prototype.getUTCFullYear;
  Date.prototype.getYear = function () { return origYear.call(new Date(this.getTime() + zlOff * 60000)) - 1900; };
  var zlDays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var zlMonths = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function zlPad2(n) { return (n < 10 ? "0" : "") + n; }
  function zlZoneText() {
    var sign = zlOff < 0 ? "-" : "+";
    var a = zlOff < 0 ? -zlOff : zlOff;
    return "GMT" + sign + zlPad2(Math.floor(a / 60)) + zlPad2(a % 60) + " (GMT" + sign + zlPad2(Math.floor(a / 60)) + ":" + zlPad2(a % 60) + ")";
  }
  Date.prototype.toString = function () {
    if (isNaN(this.getTime())) return "Invalid Date";
    var d = new Date(this.getTime() + zlOff * 60000);
    return zlDays[d.getUTCDay()] + " " + zlMonths[d.getUTCMonth()] + " " + zlPad2(d.getUTCDate()) + " " + d.getUTCFullYear() + " " + zlPad2(d.getUTCHours()) + ":" + zlPad2(d.getUTCMinutes()) + ":" + zlPad2(d.getUTCSeconds()) + " " + zlZoneText();
  };
  Date.prototype.toTimeString = function () {
    if (isNaN(this.getTime())) return "Invalid Date";
    var d = new Date(this.getTime() + zlOff * 60000);
    return zlPad2(d.getUTCHours()) + ":" + zlPad2(d.getUTCMinutes()) + ":" + zlPad2(d.getUTCSeconds()) + " " + zlZoneText();
  };
} catch (e) {}`;
}

/* #540: the Intl default timeZone becomes the profile's timezone
   identity (explicit name, or the canonical Etc/GMT zone / offset
   string derived from utcOffsetMin), so Intl.DateTimeFormat output
   agrees with the Date surface across the same instant. */
function intlZoneScript(zone: string): string {
  return `
try {
  var zlZone = ${JSON.stringify(zone)};
  var ZlDTF = Intl.DateTimeFormat;
  var Patched = class extends ZlDTF {
    constructor(locales, options) {
      if (options && typeof options === "object" && !("timeZone" in options)) options = Object.assign({}, options, { timeZone: zlZone });
      else if (!options) options = { timeZone: zlZone };
      super(locales, options);
    }
  };
  Patched.supportedLocalesOf = ZlDTF.supportedLocalesOf;
  Intl.DateTimeFormat = Patched;
} catch (e) {}`;
}

/** Compile the profile into the document init script. Pure and
    deterministic: same profile in, byte-identical script out. The
    script self-guards every patch so one failure cannot take down the
    rest of the page. */
export function fingerprintScript(p: FingerprintProfile): string {
  const parts: string[] = [];
  parts.push(`(function(){
"use strict";
function prop(obj, name, get) {
  try { Object.defineProperty(obj, name, { get: get, configurable: true }); } catch (e) {}
}
${p.matchUserAgent === false ? "" : `prop(Navigator.prototype, "userAgent", function () { return ${JSON.stringify(p.userAgent)}; });
prop(Navigator.prototype, "appVersion", function () { return ${JSON.stringify(p.userAgent.slice("Mozilla/".length))}; });
prop(Navigator.prototype, "platform", function () { return ${JSON.stringify(p.platform)}; });
${userAgentDataScript(p.userAgent, "Navigator.prototype")}`}
prop(Navigator.prototype, "language", function () { return ${JSON.stringify(p.languages[0])}; });
prop(Navigator.prototype, "languages", function () { return ${JSON.stringify(p.languages)}; });`);

  if (p.hardwareConcurrency !== null) {
    parts.push(`prop(Navigator.prototype, "hardwareConcurrency", function () { return ${p.hardwareConcurrency}; });`);
  }
  if (p.deviceMemoryGB !== null) {
    parts.push(`prop(Navigator.prototype, "deviceMemory", function () { return ${p.deviceMemoryGB}; });`);
  }
  if (p.screen) {
    const s = p.screen;
    for (const k of ["width", "height", "availWidth", "availHeight", "colorDepth", "pixelDepth"] as const) {
      parts.push(`prop(Screen.prototype, "${k}", function () { return ${s[k]}; });`);
    }
  }

  /* #223: the Date patch belongs to utcOffsetMin only. A profile
     that sets timezoneName without an offset patches Intl and leaves
     the Date surface native; the old "?? 0" forced UTC and
     contradicted the zone, violating the no-contradictory-values
     rule. */
  /* #540: Date and Intl must agree. When the profile names no zone,
     the canonical Etc/GMT identity derived from utcOffsetMin becomes
     the Intl default; an explicit timezoneName still wins (even one
     resolveProfile flagged timezoneInconsistent - the conflict is
     recorded, user input is never rewritten). */
  if (p.utcOffsetMin !== null) {
    parts.push(dateOffsetScript(p.utcOffsetMin));
  }
  const tzIdentity = timezoneIdentityFor(p);
  if (tzIdentity) {
    parts.push(intlZoneScript(tzIdentity.zone));
  }

  if (p.webglVendor && p.webglRenderer) {
    parts.push(`
try {
  var zlVendor = ${JSON.stringify(p.webglVendor)}, zlRenderer = ${JSON.stringify(p.webglRenderer)};
  for (var C of [globalThis.WebGLRenderingContext, globalThis.WebGL2RenderingContext]) {
    if (!C) continue;
    var orig = C.prototype.getParameter;
    C.prototype.getParameter = function (p) {
      if (p === 37445) return zlVendor;
      if (p === 37446) return zlRenderer;
      return orig.call(this, p);
    };
  }
} catch (e) {}`);
  }

  if (p.audioNoise) {
    parts.push(`
try {
  /* #141: deterministic AnalyserNode read noise, seeded from the
     same canvas seed so one profile always yields one surface. */
  var zlASeed = ${canvasSeedHash(p.canvasSeed)};
  var zlGFF = AnalyserNode.prototype.getFloatFrequencyData;
  AnalyserNode.prototype.getFloatFrequencyData = function (array) {
    zlGFF.call(this, array);
    for (var i = 0; i < array.length; i++) array[i] += (((zlASeed >>> (i % 29)) & 15) - 8) / 100;
  };
  var zlGBF = AnalyserNode.prototype.getByteFrequencyData;
  AnalyserNode.prototype.getByteFrequencyData = function (array) {
    zlGBF.call(this, array);
    for (var i = 0; i < array.length; i++) array[i] = (array[i] + (((zlASeed >>> (i % 29)) & 7) - 3)) & 255;
  };
} catch (e) {}`);
  }
  parts.push(`
try {
  var zlSeed = ${canvasSeedHash(p.canvasSeed)};
  function zlPerturb(data) {
    var n = data.length;
    for (var k = 0; k < 4 && n; k++) {
      var idx = (zlSeed + k * 9973) % n;
      data[idx] = (data[idx] + (((zlSeed >>> (k * 3)) & 1) ? 1 : 255)) & 255;
    }
  }
  /* #98: read-time perturbation on a throwaway copy. The live canvas
     is never written back (native toDataURL/toBlob are side-effect
     free), and every read starts from the pristine pixels, so two
     consecutive reads are byte-identical - the old write-back made
     repeated reads drift, which is itself a one-line anti-fingerprint
     detector. */
  /* #224: capture the pristine getImageData BEFORE this script
     patches it; the copy path must read untouched pixels, not the
     perturbed prototype result (the old prototype call
     double-perturbed every toDataURL/toBlob read). */
  var zlOrigGID = CanvasRenderingContext2D.prototype.getImageData;
  var zlPerturbedCopy = function (src) {
    var ctx = src.getContext("2d");
    if (!ctx || !src.width || !src.height) return null;
    var img = zlOrigGID.call(ctx, 0, 0, src.width, src.height);
    zlPerturb(img.data);
    var copy = document.createElement("canvas");
    copy.width = src.width;
    copy.height = src.height;
    copy.getContext("2d").putImageData(img, 0, 0);
    return copy;
  };
  var origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function () {
    try {
      var copy = zlPerturbedCopy(this);
      if (copy) return origToDataURL.apply(copy, arguments);
    } catch (e) {}
    return origToDataURL.apply(this, arguments);
  };
  var origToBlob = HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob = function () {
    try {
      var copy = zlPerturbedCopy(this);
      if (copy) return origToBlob.apply(copy, arguments);
    } catch (e) {}
    return origToBlob.apply(this, arguments);
  };
  var origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
  CanvasRenderingContext2D.prototype.getImageData = function () {
    var img = origGetImageData.apply(this, arguments);
    zlPerturb(img.data);
    return img;
  };
} catch (e) {}`);

  parts.push(`})();`);
  return parts.join("\n");
}

/** Compile the profile into the worker-context init script (2.3
    Selenide). Same design rules as fingerprintScript, adapted to what
    exists in workers: WorkerNavigator carries userAgent, platform,
    language(s), hardwareConcurrency and deviceMemory; there is no
    Screen, no HTMLCanvasElement and no document.cookie. Date/Intl
    timezone patches apply unchanged; OffscreenCanvas surfaces
    (convertToBlob, transferToImageBitmap, the 2D context getImageData)
    get the same deterministic perturbation as document canvases, so a
    canvas fingerprint computed in a worker matches the document's.
    WebGL UNMASKED_* patches are included too: the contexts exist in
    workers via OffscreenCanvas ("webgl"/"webgl2"). Pure and
    deterministic: same profile in, byte-identical script out. */
export function workerFingerprintScript(p: FingerprintProfile): string {
  const parts: string[] = [];
  parts.push(`(function(){
"use strict";
function prop(obj, name, get) {
  try { Object.defineProperty(obj, name, { get: get, configurable: true }); } catch (e) {}
}
var zlNav = Object.getPrototypeOf(globalThis.navigator);
${p.matchUserAgent === false ? "" : `prop(zlNav, "userAgent", function () { return ${JSON.stringify(p.userAgent)}; });
prop(zlNav, "appVersion", function () { return ${JSON.stringify(p.userAgent.slice("Mozilla/".length))}; });
prop(zlNav, "platform", function () { return ${JSON.stringify(p.platform)}; });
${userAgentDataScript(p.userAgent, "zlNav")}`}
prop(zlNav, "language", function () { return ${JSON.stringify(p.languages[0])}; });
prop(zlNav, "languages", function () { return ${JSON.stringify(p.languages)}; });`);

  if (p.hardwareConcurrency !== null) {
    parts.push(`prop(zlNav, "hardwareConcurrency", function () { return ${p.hardwareConcurrency}; });`);
  }
  if (p.deviceMemoryGB !== null) {
    parts.push(`prop(zlNav, "deviceMemory", function () { return ${p.deviceMemoryGB}; });`);
  }

  /* #223: utcOffsetMin owns the Date patch; timezoneName alone
     must not force a UTC offset onto the Date surface. #540: the
     document and worker Date/Intl patches are the same sources. */
  if (p.utcOffsetMin !== null) {
    parts.push(dateOffsetScript(p.utcOffsetMin));
  }
  const tzIdentity = timezoneIdentityFor(p);
  if (tzIdentity) {
    parts.push(intlZoneScript(tzIdentity.zone));
  }

  if (p.webglVendor && p.webglRenderer) {
    parts.push(`\ntry {
  var zlVendor = ${JSON.stringify(p.webglVendor)}, zlRenderer = ${JSON.stringify(p.webglRenderer)};
  for (var C of [globalThis.WebGLRenderingContext, globalThis.WebGL2RenderingContext]) {
    if (!C) continue;
    var orig = C.prototype.getParameter;
    C.prototype.getParameter = function (p) {
      if (p === 37445) return zlVendor;
      if (p === 37446) return zlRenderer;
      return orig.call(this, p);
    };
  }
} catch (e) {}`);
  }

  parts.push(`\ntry {
  var zlSeed = ${canvasSeedHash(p.canvasSeed)};
  function zlPerturb(data) {
    var n = data.length;
    for (var k = 0; k < 4 && n; k++) {
      var idx = (zlSeed + k * 9973) % n;
      data[idx] = (data[idx] + (((zlSeed >>> (k * 3)) & 1) ? 1 : 255)) & 255;
    }
  }
  var OOC = globalThis.OffscreenCanvas;
  if (OOC && OOC.prototype) {
    /* #98: same read-time fix as documents - perturb a fresh
       OffscreenCanvas copy, never write back into the source. */
    var zlOC2D = globalThis.OffscreenCanvasRenderingContext2D;
    var zlOrigWGID = zlOC2D ? zlOC2D.prototype.getImageData : null;
    var zlPerturbCanvas = function (c) {
      try {
        var ctx = c.getContext("2d");
        if (!ctx || !c.width || !c.height) return null;
        /* #224: pristine read, captured before the OC2D patch below. */
        var img = zlOrigWGID ? zlOrigWGID.call(ctx, 0, 0, c.width, c.height) : ctx.getImageData(0, 0, c.width, c.height);
        zlPerturb(img.data);
        var copy = new OOC(c.width, c.height);
        copy.getContext("2d").putImageData(img, 0, 0);
        return copy;
      } catch (e) {
        return null;
      }
    };
    var origBlob = OOC.prototype.convertToBlob;
    if (origBlob) OOC.prototype.convertToBlob = function () { var cp = zlPerturbCanvas(this); return origBlob.apply(cp || this, arguments); };
    var origTIB = OOC.prototype.transferToImageBitmap;
    /* #225: native transferToImageBitmap clears the source canvas;
       transferring from the copy must still clear the source (a
       width reassignment resets the bitmap on both context types). */
    if (origTIB) OOC.prototype.transferToImageBitmap = function () { var cp = zlPerturbCanvas(this); var bm = origTIB.apply(cp || this, arguments); try { this.width = this.width; } catch (e) {} return bm; };
    var OC2D = zlOC2D;
    if (OC2D) {
      var origGID = zlOrigWGID;
      OC2D.prototype.getImageData = function () {
        var img = origGID.apply(this, arguments);
        zlPerturb(img.data);
        return img;
      };
    }
  }
} catch (e) {}`);

  parts.push(`\n})();`);
  return parts.join("\n");
}
