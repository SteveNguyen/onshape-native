// Pure mapping of the popup's own Onshape listings to display data (names are display-only, bounded).
import {bound} from "./grants.js";

// getDocumentContents → [{eid, name, type, folder?}] in tree order; folder is the " / "-joined path.
// Elements the tree does not place are appended; tree references to unavailable elements are skipped.
export function tabsFromContents(contents) {
  const elements = new Map((Array.isArray(contents?.elements) ? contents.elements : [])
    .filter(e => e && typeof e.id === "string").map(e => [e.id.toLowerCase(), e]));
  const out = [], placed = new Set();
  const add = (eid, path) => {
    const e = elements.get(eid);
    if (!e || placed.has(eid)) return;
    placed.add(eid);
    out.push({eid, name: bound(e.name), type: typeof e.elementType === "string" ? e.elementType : "", ...(path.length && {folder: path.join(" / ")})});
  };
  // Folders add their name to the path; the root (depth 0) does not.
  const walk = (node, path, depth) => {
    if (!node || typeof node !== "object" || depth > 100) return;
    if (typeof node.elementId === "string") return add(node.elementId.toLowerCase(), path);
    if (!Array.isArray(node.groups)) return;
    const next = depth === 0 ? path : [...path, bound(node.groupName) || "(folder)"];
    for (const child of node.groups) walk(child, next, depth + 1);
  };
  walk(contents?.folders, [], 0);
  for (const eid of elements.keys()) add(eid, []);
  return out;
}

// getWorkspaces → {wid: name}.
export const branchNames = workspaces => Object.fromEntries((Array.isArray(workspaces) ? workspaces : [])
  .filter(w => w && typeof w.id === "string").map(w => [w.id.toLowerCase(), bound(w.name)]));
