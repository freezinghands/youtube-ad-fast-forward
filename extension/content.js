// Copyright 2026 Lee Jaeyun
// SPDX-License-Identifier: Apache-2.0

// Content script (ISOLATED world, top frame of www.youtube.com).
//
// While YouTube marks the player with the `ad-showing` class:
//   - mutes the ad's <video> at once (no round trip, so no ad audio slips through), and also asks
//     the service worker to mute the tab as a backup, renewing that request while the ad shows;
//   - plays the ad at 16x (Chrome's playbackRate ceiling); content.css blacks out the picture;
//   - pauses a long ad once so the user can press Skip; shorter ads end at 16x before anyone could
//     click. YouTube ignores script clicks on Skip and its markup is unreliable, so the rule uses
//     only the ad's duration and pressing Skip stays with the user.
// When the class goes away: puts the rate back, and unmutes after a short grace period so the
// gap between two ads of a pod stays silent. Only mutes this script made are undone.
// A press in the player during an ad (not on the volume controls) may be Skip: the rate goes back
// at once, and if within 1.5 s the class is gone and a new source has started, the unmute skips the
// grace period. A press that was not Skip only slows the ad briefly.
(() => {
  'use strict';

  const AD_RATE = 16;
  const POLL_MS = 250; // backup for the observers; also finds the player after SPA navigation
  const RENEW_MS = 1000; // tab-mute renewal while an ad shows (SW lease is 6 s)
  const END_GRACE_MS = 800; // keep muted this long after the ad class goes away
  const LEAVING_MS = 1500; // after a press in the player, how long to expect the ad to end
  const USER_INPUT_MS = 1000; // an unmute this soon after the user touched a volume control is the user's
  const VOLUME_CONTROLS = '.ytp-mute-button, .ytp-volume-area, .ytp-volume-panel';
  const VOLUME_KEYS = new Set(['m', 'M', 'ArrowUp', 'ArrowDown']);
  const LONG_AD_WATCHED_S = 15; // some ads offer Skip only after 15 s; a pause before that is no use
  const LONG_AD_REMAINING_S = 50; // pause only if this much remains (about 3 s or more at 16x)

  let player = null;
  let observer = null;
  let docObserver = null; // watches the document until #movie_player exists (first page load)
  let inAd = false;
  let muteWanted = false; // we asked the SW to mute the tab and have not released yet
  let released = false; // the user pressed the toolbar button during this ad break
  let userUnmuted = false; // the user unmuted the video during this ad break
  let savedRate = null; // content rate before we switched to 16x
  let mutedByUs = new Set(); // <video> elements this script muted during the current break
  let pausedLongAd = false; // already paused the current ad source once
  let lastUserInput = -Infinity;
  let leavingUntil = 0; // performance.now() until which a press in the player may still end the ad
  let newSource = false; // a new source started loading since that press
  let lastRenew = 0;
  let endTimer = 0;
  let pollTimer = 0;

  function alive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function send(t) {
    if (!alive()) return teardown();
    try {
      chrome.runtime.sendMessage({ t }, () => void chrome.runtime.lastError);
    } catch {
      teardown();
    }
  }

  function video() {
    return player ? player.querySelector('video.html5-main-video') : null;
  }

  function muteElement() {
    const v = video();
    if (!v || released || userUnmuted) return;
    if (v.muted) return; // already muted (by the user, or by us earlier in this break)
    v.muted = true;
    mutedByUs.add(v);
  }

  function unmuteElements() {
    for (const v of mutedByUs) {
      if (v.muted) v.muted = false;
    }
    mutedByUs = new Set();
  }

  function leaving() {
    return performance.now() < leavingUntil;
  }

  function speedUp() {
    const v = video();
    if (!v || leaving() || v.playbackRate === AD_RATE) return;
    if (savedRate === null) savedRate = v.playbackRate;
    try {
      v.playbackRate = AD_RATE;
    } catch {
      // Out-of-range rates throw NotSupportedError; 16 is in range, so this is defensive only.
    }
  }

  function slowDown() {
    const v = video();
    // Only undo our own value or a load's reset: if YouTube or the user set another rate, keep it.
    if (v && (v.playbackRate === AD_RATE || v.playbackRate === v.defaultPlaybackRate)) {
      try {
        v.playbackRate = savedRate !== null ? savedRate : 1;
      } catch {
        /* ignore */
      }
    }
  }

  function restoreRate() {
    slowDown();
    savedRate = null;
  }

  function pauseLongAd() {
    const v = video();
    if (pausedLongAd || leaving() || !v || v.paused || !Number.isFinite(v.duration)) return;
    if (v.currentTime < LONG_AD_WATCHED_S || v.duration - v.currentTime < LONG_AD_REMAINING_S) return;
    pausedLongAd = true; // once per ad source: if the user resumes, let the ad run
    v.pause();
  }

  function releaseMute() {
    clearTimeout(endTimer);
    endTimer = 0;
    unmuteElements();
    if (muteWanted) send('unmute');
    muteWanted = false;
    released = false;
    userUnmuted = false;
  }

  function onAdStart() {
    inAd = true;
    pausedLongAd = false;
    leavingUntil = 0; // the class came back, so this is a new ad
    clearTimeout(endTimer); // a pod's next ad arrived within the grace period
    endTimer = 0;
    muteElement();
    speedUp();
    if (!released) {
      muteWanted = true;
      lastRenew = performance.now();
      send('mute');
    }
  }

  function onAdEnd() {
    inAd = false;
    restoreRate();
    clearTimeout(endTimer);
    endTimer = setTimeout(releaseMute, END_GRACE_MS);
    if (leaving() && newSource) releaseMute(); // the content started before the class went
  }

  function check() {
    if (!alive()) return teardown();
    const p = document.getElementById('movie_player');
    if (p !== player) attach(p);
    const ad = Boolean(player && player.classList.contains('ad-showing'));
    if (ad && !inAd) onAdStart();
    else if (!ad && inAd) onAdEnd();
    else if (ad) {
      muteElement();
      speedUp(); // each new ad source resets playbackRate on load
      pauseLongAd();
      if (muteWanted && !released && performance.now() - lastRenew >= RENEW_MS) {
        lastRenew = performance.now();
        send('mute');
      }
    }
  }

  function attach(p) {
    if (observer) observer.disconnect();
    observer = null;
    player = p;
    if (p) {
      observer = new MutationObserver(check);
      observer.observe(p, { attributes: true, attributeFilter: ['class'] });
      if (docObserver) docObserver.disconnect(); // the poll covers later player replacements
      docObserver = null;
    }
  }

  // The first preroll can start as soon as the player is built; finding the player only on the
  // next poll tick would let ad audio through.
  function watchForPlayer() {
    docObserver = new MutationObserver(() => {
      if (!player && document.getElementById('movie_player')) check();
    });
    docObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  // A new ad source starts at the default rate and may get the player's own mute state; re-apply
  // ours as it loads and plays, and check the long-ad rule as the ad progresses.
  function onMedia(e) {
    if (e.target !== video()) return;
    if (e.type === 'loadstart' && leaving()) {
      newSource = true;
      if (!inAd) releaseMute(); // the class went first, and now the content replaces the skipped ad
    }
    if (!inAd) return;
    if (e.type === 'loadstart') pausedLongAd = false; // next ad of a pod
    if (e.type === 'volumechange') {
      // An unmute right after the user used a volume control (click, or the m / arrow keys) is the
      // user's and wins for this break; any other unmute (the player re-applying its own state,
      // e.g. when the next ad loads after Skip) is undone.
      if (!e.target.muted) {
        if (performance.now() - lastUserInput < USER_INPUT_MS) userUnmuted = true;
        else muteElement();
      }
      return;
    }
    muteElement();
    speedUp();
    if (e.type === 'timeupdate') pauseLongAd();
  }
  const MEDIA_EVENTS = ['loadstart', 'loadedmetadata', 'canplay', 'playing', 'ratechange', 'volumechange', 'timeupdate'];
  const INPUT_EVENTS = ['pointerdown', 'keydown'];

  function onInput(e) {
    if (!e.isTrusted) return;
    const volumeInput = e.type === 'keydown'
      ? VOLUME_KEYS.has(e.key)
      : e.target instanceof Element && e.target.closest(VOLUME_CONTROLS) !== null;
    if (volumeInput) lastUserInput = performance.now();
    else if (inAd && e.type === 'pointerdown' && e.target instanceof Node && player.contains(e.target)) {
      leavingUntil = performance.now() + LEAVING_MS;
      newSource = false;
      slowDown();
    }
  }

  function onMessage(msg) {
    // Only during an ad break (an ad, or the grace period between two ads): a click outside one
    // must not carry over and leave the next break unmuted.
    if (msg && msg.t === 'release' && (inAd || endTimer)) {
      released = true; // the SW already unmuted the tab; stop muting until this break ends
      muteWanted = false;
      unmuteElements();
    }
  }

  function onPageHide() {
    if (inAd) restoreRate();
    inAd = false;
    releaseMute();
  }

  function teardown() {
    clearInterval(pollTimer);
    clearTimeout(endTimer);
    if (observer) observer.disconnect();
    if (docObserver) docObserver.disconnect();
    observer = null;
    docObserver = null;
    if (inAd) restoreRate();
    unmuteElements(); // Chrome itself unmutes the tab when the extension goes away
    inAd = false;
    for (const type of MEDIA_EVENTS) document.removeEventListener(type, onMedia, true);
    for (const type of INPUT_EVENTS) document.removeEventListener(type, onInput, true);
    window.removeEventListener('pagehide', onPageHide);
  }

  for (const type of MEDIA_EVENTS) document.addEventListener(type, onMedia, true);
  for (const type of INPUT_EVENTS) document.addEventListener(type, onInput, true);
  window.addEventListener('pagehide', onPageHide);
  chrome.runtime.onMessage.addListener(onMessage);
  pollTimer = setInterval(check, POLL_MS);
  check();
  if (!player) watchForPlayer();
})();
