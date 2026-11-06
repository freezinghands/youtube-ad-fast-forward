// Copyright 2026 Lee Jaeyun
// SPDX-License-Identifier: Apache-2.0

// Service worker: owns the tab mute.
//
// - Mutes only tabs that are not already muted, and unmutes only a mute this extension made
//   (mutedInfo.extensionId), so a mute by the user or another extension is never undone.
// - Every mute is a lease: if the content script stops renewing it (tab navigated away, renderer
//   crashed, script gone), the tab is unmuted after LEASE_MS.
// - The toolbar button unmutes the current tab at once and tells the page to stop muting for the
//   rest of this ad break; outside an ad break the page ignores it (a tab muted by an extension
//   cannot be unmuted from Chrome's own tab UI).
// Tab mute needs no permission (chrome.tabs.update({muted}) and mutedInfo work without "tabs").

const LEASE_MS = 6000;
const leases = new Map(); // tabId -> timeout id
const queues = new Map(); // tabId -> promise chain, so mute/unmute requests apply in order

function ours(tab) {
  const mi = tab && tab.mutedInfo;
  return Boolean(mi && mi.muted && mi.extensionId === chrome.runtime.id);
}

function serial(tabId, job) {
  const next = (queues.get(tabId) || Promise.resolve()).then(job).catch(() => {});
  queues.set(tabId, next);
  next.then(() => {
    if (queues.get(tabId) === next) queues.delete(tabId);
  });
  return next;
}

function setLease(tabId) {
  clearTimeout(leases.get(tabId));
  leases.set(tabId, setTimeout(() => unmute(tabId), LEASE_MS));
}

function clearLease(tabId) {
  clearTimeout(leases.get(tabId));
  leases.delete(tabId);
}

function mute(tabId) {
  return serial(tabId, async () => {
    const tab = await chrome.tabs.get(tabId);
    if (tab.mutedInfo && tab.mutedInfo.muted && !ours(tab)) return; // the user's or another extension's mute
    if (!ours(tab)) await chrome.tabs.update(tabId, { muted: true });
    setLease(tabId);
  });
}

function unmute(tabId) {
  clearLease(tabId);
  return serial(tabId, async () => {
    const tab = await chrome.tabs.get(tabId);
    if (ours(tab)) await chrome.tabs.update(tabId, { muted: false });
  });
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender.tab && sender.tab.id;
  if (sender.id !== chrome.runtime.id || tabId == null || sender.frameId !== 0) return;
  if (msg && msg.t === 'mute') mute(tabId);
  else if (msg && msg.t === 'unmute') unmute(tabId);
});

chrome.action.onClicked.addListener((tab) => {
  if (tab.id == null) return;
  unmute(tab.id);
  chrome.tabs.sendMessage(tab.id, { t: 'release' }, { frameId: 0 }, () => void chrome.runtime.lastError);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearLease(tabId);
  queues.delete(tabId);
});

// The SW may have been restarted (or crashed) while one of our mutes was active: give every such
// tab a fresh lease. A page still in an ad renews it; otherwise the tab is unmuted in LEASE_MS.
chrome.tabs.query({ muted: true }).then((tabs) => {
  for (const tab of tabs) if (tab.id != null && ours(tab) && !leases.has(tab.id)) setLease(tab.id);
}, () => {});
