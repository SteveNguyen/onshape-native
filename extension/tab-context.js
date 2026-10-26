import {didFromUrl} from "./policy.js";

// Report only Onshape tabs; no global tabs permission or other-site URL access.
// Titles and URLs (folder, search, document names) of unauthorized tabs are model
// text the agent must not read; only the did is reported so it can ask the user.
export async function tabContext(browser, policy) {
  const tabs = await browser.tabs.query({url: "https://cad.onshape.com/*"});
  let lastWindow = null;
  try { lastWindow = await browser.windows.getLastFocused({windowTypes: ["normal"]}); }
  catch { /* Closing windows can race the query. Let the caller request a URL. */ }
  return {
    context_version: 1,
    last_focused_window_id: lastWindow?.id ?? null,
    browser_window_focused: lastWindow?.focused ?? false,
    tabs: tabs.map(t => {
      const did = didFromUrl(t.url);
      const authorized = did !== null && Object.hasOwn(policy?.docs ?? {}, did);
      if (!authorized) return {id: t.id, active: t.active === true, window_id: t.windowId, authorized, ...(did ? {did} : {})};
      return {id: t.id, title: t.title, url: t.url, active: t.active === true, window_id: t.windowId, authorized};
    }),
  };
}
