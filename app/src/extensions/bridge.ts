/* Zeolite extension subsystem: the content-script bridge.

   Served at /zl-cs/<id>/__bridge.js with a per-request config embedded
   ahead of this source. The bridge:

   - builds the browser.* API object for the content-script context
     (runtime.id/getURL/sendMessage/onMessage, storage.local) backed by
     a MessageChannel to the service worker, which verifies the sender
     page actually matches the extension's declared content_scripts;
   - receives background -> content-script messages (tabs.sendMessage):
     the SW addresses the page by destination, only the controlling
     service worker is trusted, and replies travel back as
     zl:ext __zlTabReply/__zlTabError control messages;
   - loads the declared js files and executes each in a Function scope
     with only (browser, chrome) exposed - the page cannot reach the
     API object, and the scripts cannot reach the engine global scope
     (documented limitation: this is isolation-in-one-world, not a
     real Firefox isolated world, which needs renderer support);
   - appends the declared css files as <link> elements at start.

   run_at is honored: document_start runs immediately (the bridge is
   injected into <head> by the rewriter), document_end waits for
   DOMContentLoaded, document_idle waits for load + idle. */

export const BRIDGE_SOURCE = `(function () {
  "use strict";
  var cfg = ZL_CS_CFG;
  var origin = location.origin;
  var csListeners = [];
  function ctl() {
    return navigator.serviceWorker && navigator.serviceWorker.controller;
  }
  function chan(req) {
    return new Promise(function (resolve, reject) {
      var c = ctl();
      if (!c) {
        reject(new Error("zeolite: page not controlled by the engine service worker"));
        return;
      }
      var mc = new MessageChannel();
      var t = setTimeout(function () {
        reject(new Error("zeolite: extension message timed out"));
      }, 30000);
      mc.port1.onmessage = function (ev) {
        clearTimeout(t);
        var d = ev.data || {};
        if (d.ok) resolve(d.response);
        else reject(new Error(d.error || "zeolite: extension messaging failed"));
      };
      c.postMessage({ type: "zl:ext", extId: cfg.ext, msg: req }, [mc.port2]);
    });
  }
  function storageArea(name) {
    return {
      get: function (keys) { return chan({ __zlStorage: name, op: "get", keys: keys }); },
      set: function (items) { return chan({ __zlStorage: name, op: "set", items: items }); },
      remove: function (keys) { return chan({ __zlStorage: name, op: "remove", keys: keys }); },
      clear: function () { return chan({ __zlStorage: name, op: "clear" }); },
    };
  }
  /* First reply wins: later sendResponse calls are dropped, matching
     the engine-side resolveTabMessage semantics. */
  function replyOnce(nonce) {
    var done = false;
    return function (response) {
      if (done) return;
      done = true;
      var c = ctl();
      if (c) c.postMessage({ type: "zl:ext", extId: cfg.ext, msg: { __zlTabReply: nonce, response: response } });
    };
  }
  function apiObject() {
    return {
      runtime: {
        id: cfg.ext,
        getURL: function (p) {
          return "/zl-ext/" + cfg.ext + (p.charAt(0) === "/" ? p : "/" + p);
        },
        sendMessage: function (m) { return chan(m); },
        onMessage: {
          addListener: function (l) {
            if (csListeners.length >= 32) {
              throw new Error("zeolite: too many content-script message listeners");
            }
            csListeners.push(l);
          },
          removeListener: function (l) {
            var i = csListeners.indexOf(l);
            if (i !== -1) csListeners.splice(i, 1);
          },
          hasListener: function (l) { return csListeners.indexOf(l) !== -1; },
        },
        connect: function () {
          throw new Error("zeolite: runtime.connect from content scripts is not supported yet");
        },
      },
      storage: { local: storageArea("local") },
    };
  }
  /* tabs.sendMessage delivery: verify the message is from the
     controlling service worker, addressed to this extension, and
     addressed to THIS page (destination match), then hand it to the
     content-script listeners. No listener answers honestly with
     __zlTabError instead of a silent drop. */
  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener("message", function (ev) {
      var c = ctl();
      if (!c || ev.source !== c) return;
      var m = ev.data;
      if (!m || m.type !== "zl:tabMessage" || m.extId !== cfg.ext || !m.payload) return;
      var dest = (window.__ZL && window.__ZL.dest) || document.baseURI;
      if (m.dest !== dest) return;
      var nonce = m.payload.nonce;
      if (csListeners.length === 0) {
        c.postMessage({ type: "zl:ext", extId: cfg.ext, msg: { __zlTabError: nonce, error: "zeolite: could not establish connection. Receiving end does not exist" } });
        return;
      }
      var send = replyOnce(nonce);
      for (var i = 0; i < csListeners.length; i++) {
        var keepOpen;
        try {
          keepOpen = csListeners[i](m.payload.msg, { id: cfg.ext, url: dest }, send);
        } catch (e) {
          console.error("[zeolite cs " + cfg.ext + "]", e);
          continue;
        }
        if (keepOpen !== true) send(undefined);
      }
    });
  }
  function loadCss(href) {
    var l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = origin + href;
    (document.head || document.documentElement).appendChild(l);
  }
  function runScripts(urls, i) {
    if (i >= urls.length) return;
    fetch(origin + urls[i], { credentials: "omit" })
      .then(function (r) {
        if (!r.ok) throw new Error("content script fetch failed: " + urls[i]);
        return r.text();
      })
      .then(function (code) {
        try {
          var browser = apiObject();
          new Function("browser", "chrome", '"use strict";\n' + code)(browser, browser);
        } catch (e) {
          console.error("[zeolite cs " + cfg.ext + "]", e);
        }
        runScripts(urls, i + 1);
      })
      .catch(function (e) {
        console.error("[zeolite cs " + cfg.ext + "]", e);
        runScripts(urls, i + 1);
      });
  }
  function start() {
    for (var i = 0; i < (cfg.css || []).length; i++) loadCss(cfg.css[i]);
    var js = cfg.js || [];
    if (cfg.runAt === "document_start") {
      runScripts(js, 0);
      return;
    }
    if (cfg.runAt === "document_end") {
      if (document.readyState !== "loading") runScripts(js, 0);
      else document.addEventListener("DOMContentLoaded", function () { runScripts(js, 0); });
      return;
    }
    var idle = window.requestIdleCallback || function (f) { setTimeout(f, 1); };
    if (document.readyState === "complete") idle(function () { runScripts(js, 0); });
    else window.addEventListener("load", function () { idle(function () { runScripts(js, 0); }); });
  }
  start();
})();
`;
