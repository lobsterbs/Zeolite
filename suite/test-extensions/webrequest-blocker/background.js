/* Phase 3 probe: webRequest blocking is real now. This fixture
   registers a blocking onBeforeRequest listener that cancels
   doubleclick.net requests; the suite expects delivery gated by the
   manifest's host permissions. */
browser.webRequest.onBeforeRequest.addListener(
  function (details) {
    if (details.url.indexOf("doubleclick.net") !== -1) {
      return { cancel: true };
    }
  },
  { urls: ["<all_urls>"] },
);
