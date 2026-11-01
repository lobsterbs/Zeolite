/* Zeolite extension subsystem: the extension-page bridge (#40).

   Served at /zl-ext/<id>/__page.js with a config embedded ahead of
   this source by serve.ts. The bridge turns browser.* calls on an
   extension-origin page (options, popup) into zl:extPage RPCs over a
   MessageChannel to the service worker. The SW verifies the sender is
   a client registered as that extension's page, then walks the
   extension's real API object, so the API surface here is exactly
   what the SW whitelist allows.

   getURL stays client-side: an extension page's package resources
   live on this origin under /zl-ext/<id>/.

   Events stay undelivered to the page, but runtime.connect opens a
   real duplex port to the background (#560); the SW refuses event
   and RPC port paths (documented in ./compat). */

export const PAGE_BRIDGE_SOURCE = `(function () {
  "use strict";
  var cfg = ZL_PAGE_CFG;
  function ctl() {
    return navigator.serviceWorker && navigator.serviceWorker.controller;
  }
  function call(path, args) {
    return new Promise(function (resolve, reject) {
      var c = ctl();
      if (!c) {
        reject(new Error("zeolite: page not controlled by the engine service worker"));
        return;
      }
      var mc = new MessageChannel();
      var done = false;
      var t = setTimeout(function () {
        finish(new Error("zeolite: extension page call timed out"));
      }, 30000);
      function finish(err, data) {
        if (done) return;
        done = true;
        clearTimeout(t);
        mc.port1.onmessage = null;
        try { mc.port1.close(); } catch (ignored) {}
        if (err) reject(err);
        else if (data && data.ok) resolve(data.response);
        else reject(new Error((data && data.error) || "zeolite: extension page call failed"));
      }
      mc.port1.onmessage = function (ev) {
        finish(null, ev.data || {});
      };
      try {
        c.postMessage({ type: "zl:extPage", extId: cfg.ext, msg: { path: path, args: args } }, [mc.port2]);
      } catch (err) {
        finish(err);
        try { mc.port2.close(); } catch (ignored) {}
      }
    });
  }
  var browser = {};
  for (var i = 0; i < cfg.calls.length; i++) {
    (function (dotted) {
      var segs = dotted.split(".");
      var node = browser;
      for (var j = 0; j < segs.length - 1; j++) {
        if (!node[segs[j]]) node[segs[j]] = {};
        node = node[segs[j]];
      }
      node[segs[segs.length - 1]] = function () {
        var args = Array.prototype.slice.call(arguments);
        /* #560: Chrome callback shape. A trailing function argument
           is the callback: it is resolved with the call outcome
           (undefined on failure) while the promise return is kept
           for promise-style callers. */
        var cb = null;
        if (args.length > 0 && typeof args[args.length - 1] === "function") {
          cb = args.pop();
        }
        var p = call(segs, args);
        if (cb) {
          p.then(
            function (r) { cb(r); },
            function () { cb(undefined); }
          );
        }
        return p;
      };
    })(cfg.calls[i]);
  }
  browser.runtime = browser.runtime || {};
  browser.runtime.id = cfg.ext;
  /* #560: synchronous getManifest (Chrome parity): the manifest is
     embedded in ZL_PAGE_CFG by the SW; pages read its fields during
     boot, so the promise-shaped materialized call must be
     overridden. */
  browser.runtime.getManifest = function () {
    return cfg.manifest;
  };
  /* #560: HTML pages are served ROOTED at the origin root so the
     page's location.pathname matches real extension origins (page
     boot dispatch chains key on it). Navigating there is granted via
     the page's registered client id or a host-minted page token.
     Every other resource keeps the /zl-ext/ package base, which is
     also the <base href> injected into rooted pages, so both forms
     resolve to the same asset route. */
  browser.runtime.getURL = function (p) {
    var norm = p.charAt(0) === "/" ? p : "/" + p;
    var dot = norm.lastIndexOf(".");
    if (dot !== -1) {
      var ext = norm.slice(dot + 1).toLowerCase();
      if (ext === "html" || ext === "htm") {
        return norm + (norm.indexOf("?") === -1 ? "?" : "&") + "zlExt=" + cfg.ext;
      }
    }
    return cfg.base + norm;
  };
  for (var n = 0; cfg.ns && n < cfg.ns.length; n++) {
    if (!browser[cfg.ns[n]]) browser[cfg.ns[n]] = {};
  }
  if (browser.extension && browser.extension.inIncognitoContext === undefined) {
    browser.extension.inIncognitoContext = false;
  }
  /* #560: chrome.i18n in the page world. The SW embeds the package
     resolved _locales in ZL_PAGE_CFG; getMessage expands $NAME$
     placeholders first (their content may itself carry $n), then
     maps $1..$9 onto the substitutions; a missing name answers ""
     like Chrome. getAcceptLanguages keeps its callback/promise dual
     shape through chromeApi. */
  if (cfg.i18n) {
    var msgs = cfg.i18n.messages || {};
    browser.i18n = browser.i18n || {};
    browser.i18n.getMessage = function (name, subs) {
      if (typeof name !== "string") return "";
      var e = msgs[name.toLowerCase()];
      if (!e || typeof e.message !== "string") return "";
      var arr = Array.isArray(subs)
        ? subs.map(String)
        : subs === undefined || subs === null
          ? []
          : [String(subs)];
      var out = "";
      var m = e.message;
      for (var i = 0; i < m.length; i++) {
        if (m.charAt(i) !== "$") { out += m.charAt(i); continue; }
        var j = m.indexOf("$", i + 1);
        if (j === -1) { out += "$"; continue; }
        var inner = m.slice(i + 1, j);
        var ph = e.placeholders && e.placeholders[inner.toLowerCase()];
        if (/^[A-Za-z0-9_@]+$/.test(inner) && ph !== undefined) {
          out += ph;
          i = j;
        } else {
          out += "$";
        }
      }
      var fin = "";
      for (var k = 0; k < out.length; k++) {
        if (out.charAt(k) !== "$") { fin += out.charAt(k); continue; }
        var inner2 = out.slice(k + 1, k + 2);
        if (/^[1-9]$/.test(inner2)) {
          var idx = Number(inner2) - 1;
          if (idx < arr.length) { fin += arr[idx]; k += 1; continue; }
        }
        fin += "$";
      }
      return fin;
    };
    browser.i18n.getUILanguage = function () { return cfg.i18n.locale; };
    browser.i18n.getAcceptLanguages = function () {
      return Promise.resolve(
        navigator.languages && navigator.languages.length
          ? Array.prototype.slice.call(navigator.languages)
          : [cfg.i18n.locale],
      );
    };
  }
  /* #560: runtime.connect from the page world. The stub transfers
     one end of a MessageChannel to the SW, which pairs it with the
     extension's real port: background onConnect listeners receive
     the far end, so TM-class options pages that drive their
     background over a port boot instead of dying. */
  browser.runtime.connect = function (a, b) {
    var info = typeof a === "string" ? { name: a } : a && typeof a === "object" ? a : {};
    if (typeof b === "string") info.name = b;
    var nm = typeof info.name === "string" ? info.name : "";
    var c = ctl();
    if (!c) throw new Error("zeolite: page not controlled by the engine service worker");
    var mc = new MessageChannel();
    var ml = [];
    var dl = [];
    function evt(ls) {
      return {
        addListener: function (l) { ls.push(l); },
        removeListener: function (l) { var i = ls.indexOf(l); if (i >= 0) ls.splice(i, 1); },
        hasListener: function (l) { return ls.indexOf(l) >= 0; },
      };
    }
    c.postMessage({ type: "zl:extPage", extId: cfg.ext, msg: { port: "connect", name: nm } }, [mc.port2]);
    mc.port1.onmessage = function (ev2) {
      var d = ev2.data || {};
      var i;
      if (d.t === "m") {
        for (i = 0; i < ml.length; i++) {
          try { ml[i](d.msg); } catch (e2) {}
        }
      } else if (d.t === "d" || d.t === "err") {
        for (i = 0; i < dl.length; i++) {
          try { dl[i](); } catch (e3) {}
        }
        mc.port1.close();
      }
    };
    return {
      name: nm,
      postMessage: function (m) { mc.port1.postMessage({ t: "p", msg: m }); },
      disconnect: function () { mc.port1.postMessage({ t: "d" }); mc.port1.close(); },
      onMessage: evt(ml),
      onDisconnect: evt(dl),
    };
  };
  window.browser = browser;
  window.chrome = browser;
})();
`;
