import {didFromUrl, targetFromUrl} from "./policy.js";
import {anyBranchMode, hasAnyGrant, tabMode} from "./grants.js";

// A tab is readable only when its exact element is granted (policy = effective policy).
// Versions and microversions are read-only history: any branch grant of the element counts.
// Document-only pages (no element) need any grant on the document.
function authorizedTab(policy, url) {
  const target = targetFromUrl(url);
  const p = policy ?? {};
  if (!target) { const did = didFromUrl(url); return did !== null && hasAnyGrant(p, did); }
  if (!target.eid) return false;
  const mode = target.wvm === "w" ? tabMode(p, target.did, target.wvmid, target.eid) : anyBranchMode(p, target.did, target.eid);
  return mode !== null && mode !== undefined;
}

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
      const authorized = authorizedTab(policy, t.url);
      if (!authorized) return {id: t.id, active: t.active === true, window_id: t.windowId, authorized, ...(did ? {did} : {})};
      return {id: t.id, title: t.title, url: t.url, active: t.active === true, window_id: t.windowId, authorized};
    }),
  };
}
