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

export interface ScreenShape {
  width: number;
  height: number;
  availWidth: number;
  availHeight: number;
  colorDepth: number;
  pixelDepth: number;
}

export interface FingerprintProfile {
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
  /** Deterministic seed for canvas perturbation; fixed strings, never
      randomized per session. */
  canvasSeed: string;
}

/** A coherent, modern Chrome-on-Windows desktop profile. Every field
    is internally consistent (Win32 platform, Chrome UA, ANGLE-on-NVIDIA
    renderer strings a real Chrome would report). */
export const DEFAULT_PROFILE: FingerprintProfile = {
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
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
  canvasSeed: "zeolite-telluride",
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

function isPosInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/** Validate + normalize a host-supplied profile object. Derives what is
    missing and refuses contradictions. Throws Error with a plain
    message on anything it cannot make consistent. */
export function resolveProfile(input: unknown): FingerprintProfile {
  if (typeof input !== "object" || input === null) throw new Error("profile must be an object");
  const p = input as Partial<FingerprintProfile>;
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

  return {
    userAgent: p.userAgent,
    platform,
    languages,
    utcOffsetMin,
    timezoneName,
    hardwareConcurrency,
    deviceMemoryGB,
    screen,
    webglVendor: (vendor as string | null) ?? null,
    webglRenderer: (renderer as string | null) ?? null,
    canvasSeed,
  };
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
prop(Navigator.prototype, "userAgent", function () { return ${JSON.stringify(p.userAgent)}; });
prop(Navigator.prototype, "appVersion", function () { return ${JSON.stringify(p.userAgent.slice("Mozilla/".length))}; });
prop(Navigator.prototype, "platform", function () { return ${JSON.stringify(p.platform)}; });
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

  if (p.utcOffsetMin !== null || p.timezoneName !== null) {
    const off = p.utcOffsetMin ?? 0;
    parts.push(`
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
} catch (e) {}`);
    if (p.timezoneName) {
      parts.push(`
try {
  var zlZone = ${JSON.stringify(p.timezoneName)};
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
} catch (e) {}`);
    }
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
  var origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function () {
    try {
      var ctx = this.getContext("2d");
      if (ctx) {
        var img = ctx.getImageData(0, 0, this.width, this.height);
        zlPerturb(img.data);
        ctx.putImageData(img, 0, 0);
      }
    } catch (e) {}
    return origToDataURL.apply(this, arguments);
  };
  var origToBlob = HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob = function () {
    try {
      var ctx = this.getContext("2d");
      if (ctx) {
        var img = ctx.getImageData(0, 0, this.width, this.height);
        zlPerturb(img.data);
        ctx.putImageData(img, 0, 0);
      }
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
