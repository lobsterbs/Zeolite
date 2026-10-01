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

   No events, no ports: the page cannot receive pushes, and the SW
   refuses those paths (documented in ./compat). */

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
      var t = setTimeout(function () {
        reject(new Error("zeolite: extension page call timed out"));
      }, 30000);
      mc.port1.onmessage = function (ev) {
        clearTimeout(t);
        var d = ev.data || {};
        if (d.ok) resolve(d.response);
        else reject(new Error(d.error || "zeolite: extension page call failed"));
      };
      c.postMessage({ type: "zl:extPage", extId: cfg.ext, msg: { path: path, args: args } }, [mc.port2]);
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
        return call(segs, Array.prototype.slice.call(arguments));
      };
    })(cfg.calls[i]);
  }
  browser.runtime = browser.runtime || {};
  browser.runtime.id = cfg.ext;
  browser.runtime.getURL = function (p) {
    return cfg.base + (p.charAt(0) === "/" ? p : "/" + p);
  };
  window.browser = browser;
  window.chrome = browser;
})();
`;
