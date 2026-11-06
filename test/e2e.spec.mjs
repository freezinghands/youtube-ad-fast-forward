// E2E: loads extension/ into Chrome, serves a fake youtube.com watch page, and checks that ads
// play at 16x, muted and blacked out, and that rate, sound and picture come back afterwards.
import { test, expect, chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const EXT_DIR = here('../extension');
const OTHER_DIR = here('other-ext');
const FAKE_DIR = here('fake-youtube');
const MEDIA_DIR = here('media');
// The grey page reads 68: above the black limit (8) and below the picture limit (100), so a pixel
// check cannot pass on the bare page showing through a missing background or a hidden video.
const WATCH_HTML = '<!doctype html><meta charset="utf-8"><title>watch</title><body style="background:#444"><script src="/fake/player.js"></script></body>';
const watchUrl = (ads = 1, extra = '') => `https://www.youtube.com/watch?v=test&ads=${ads}${extra}`;

let context;
let extSw; // the extension under test
let otherSw; // helper: another extension with "tabs"
let extId;

// Answers every request to www.youtube.com locally, so the real site is never contacted: the fake
// watch page, its script and the generated media, with Range support so <video> can stream.
async function serve(route) {
  const req = route.request();
  const { pathname } = new URL(req.url());
  if (pathname === '/watch') return route.fulfill({ contentType: 'text/html', body: WATCH_HTML });
  if (pathname === '/fake/player.js') return route.fulfill({ contentType: 'text/javascript', body: readFileSync(`${FAKE_DIR}/player.js`) });
  const media = pathname.match(/^\/fake\/media\/(ad|ad-long|content)\.webm$/);
  if (!media) return route.fulfill({ status: 404, body: '' });
  const body = readFileSync(`${MEDIA_DIR}/${media[1]}.webm`);
  const range = /bytes=(\d+)-(\d*)/.exec(req.headers().range || '');
  if (!range) return route.fulfill({ contentType: 'video/webm', headers: { 'accept-ranges': 'bytes' }, body });
  const start = Number(range[1]);
  const end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
  return route.fulfill({
    status: 206,
    contentType: 'video/webm',
    headers: { 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${body.length}` },
    body: body.subarray(start, end + 1),
  });
}

async function worker(file) {
  const match = (w) => w.url().startsWith('chrome-extension://') && w.url().endsWith(`/${file}`);
  return context.serviceWorkers().find(match) ?? context.waitForEvent('serviceworker', { predicate: match, timeout: 10_000 });
}

test.beforeEach(async () => {
  const executablePath = process.env.PW_CHROMIUM_EXECUTABLE || undefined;
  context = await chromium.launchPersistentContext('', {
    ...(executablePath ? { executablePath } : { channel: 'chromium' }),
    headless: true,
    args: [
      `--disable-extensions-except=${EXT_DIR},${OTHER_DIR}`,
      `--load-extension=${EXT_DIR},${OTHER_DIR}`,
      '--autoplay-policy=no-user-gesture-required',
      // Chrome preconnects to a page's origin outside context.route; this keeps it off the real site.
      '--host-resolver-rules=MAP www.youtube.com ~NOTFOUND',
    ],
  });
  await context.route('https://www.youtube.com/**', serve);
  extSw = await worker('sw.js');
  otherSw = await worker('other-sw.js');
  extId = new URL(extSw.url()).host;
  // Every tab mute change Chrome reports, with wall-clock time.
  await extSw.evaluate(() => {
    globalThis.muteLog = [];
    chrome.tabs.onUpdated.addListener((_id, info) => {
      if (info.mutedInfo) globalThis.muteLog.push({ at: Date.now(), muted: info.mutedInfo.muted, ext: info.mutedInfo.extensionId ?? null });
    });
  });
});

test.afterEach(async () => {
  await context.close();
});

// A page that logs what the tests check: rate changes, the rate, mute and opacity each time an
// ad starts playing, ad pauses, the content start, the first unmute and unmutes of a playing
// ad. Media events do not bubble, so it listens in the capture phase.
async function newPage() {
  const page = await context.newPage();
  await page.addInitScript(() => {
    const isAd = () => Boolean(document.getElementById('movie_player')?.classList.contains('ad-showing'));
    const isContent = (v) => v.currentSrc.includes('content');
    globalThis.rateLog = [];
    globalThis.adPlayingAt = null;
    globalThis.rateAtAdPlaying = [];
    globalThis.mutedAtAdPlaying = [];
    globalThis.opacityAtAdPlaying = [];
    globalThis.adPauses = [];
    globalThis.contentStart = null;
    globalThis.unmutedAt = null;
    globalThis.unmutedOnPlayingAd = 0;
    document.addEventListener('ratechange', (e) => globalThis.rateLog.push({ rate: e.target.playbackRate, ad: isAd(), content: isContent(e.target) }), true);
    document.addEventListener('playing', (e) => {
      const v = e.target;
      if (isContent(v)) globalThis.contentStart ??= { at: performance.now(), rate: v.playbackRate };
      if (!isAd()) return;
      if (!isContent(v)) globalThis.rateAtAdPlaying.push(v.playbackRate);
      globalThis.adPlayingAt ??= Date.now();
      globalThis.mutedAtAdPlaying.push(v.muted);
      globalThis.opacityAtAdPlaying.push(getComputedStyle(v).opacity);
    }, true);
    document.addEventListener('pause', (e) => {
      if (isAd() && !e.target.ended) globalThis.adPauses.push({ t: e.target.currentTime, d: e.target.duration });
    }, true);
    document.addEventListener('volumechange', (e) => {
      if (e.target.muted) return;
      globalThis.unmutedAt ??= performance.now();
      if (!isContent(e.target) && !e.target.paused) globalThis.unmutedOnPlayingAd += 1;
    }, true);
  });
  return page;
}

const phase = (page) => page.evaluate(() => globalThis.__fake.state().phase);
const videoState = (page) => page.evaluate(() => { const v = globalThis.__fake.video; return { rate: v.playbackRate, paused: v.paused, muted: v.muted }; });
const videoOpacity = (page) => page.evaluate(() => getComputedStyle(globalThis.__fake.video).opacity);
// The brightest colour channel (0-255) in what is actually drawn where the element sits.
async function brightestPixel(page, selector = '#movie_player video') {
  const png = await page.locator(selector).screenshot();
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    let max = 0;
    for (let i = 0; i < data.length; i += 4) max = Math.max(max, data[i], data[i + 1], data[i + 2]);
    return max;
  }, png.toString('base64'));
}
const muteLog = () => extSw.evaluate(() => globalThis.muteLog);
const tabMute = (url) => otherSw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.mutedInfo ?? null, url);

test('ad plays at 16x with the tab muted; rate and sound come back after', async () => {
  const page = await newPage();
  await page.goto(watchUrl());
  // A 15 s ad at 1x would still be running; at 16x it ends in about a second.
  await expect.poll(() => phase(page), { timeout: 6_000, intervals: [100] }).toBe('content');
  await page.waitForTimeout(1_500);

  const rates = await page.evaluate(() => globalThis.rateLog);
  expect(rates.some((r) => r.ad && r.rate === 16), 'ad at 16x').toBe(true);
  expect(rates.filter((r) => !r.ad && r.rate === 16), 'content never at 16x').toEqual([]);
  const mutedAtPlaying = await page.evaluate(() => globalThis.mutedAtAdPlaying);
  expect(mutedAtPlaying.length).toBeGreaterThan(0);
  expect(mutedAtPlaying.every(Boolean), 'ad video muted every time it starts playing').toBe(true);
  const opacities = await page.evaluate(() => globalThis.opacityAtAdPlaying);
  expect(opacities.every((o) => o === '0'), 'ad video hidden every time it starts playing').toBe(true);
  expect(await videoState(page)).toEqual({ rate: 1, paused: false, muted: false });
  expect(await videoOpacity(page), 'content video visible').toBe('1');

  await expect.poll(async () => (await tabMute(watchUrl()))?.muted, { timeout: 3_000 }).toBe(false);
  const log = await muteLog();
  expect(log.map((c) => [c.muted, c.ext])).toEqual([[true, extId], [false, extId]]);
  // The tab must be muted before the ad makes sound.
  const adPlayingAt = await page.evaluate(() => globalThis.adPlayingAt);
  const lead = adPlayingAt - log[0].at;
  test.info().annotations.push({ type: 'muted before ad played (ms)', description: String(lead) });
  expect(lead).toBeGreaterThanOrEqual(0);
});

test('two ads in a row: one mute for the whole pod, both ads at 16x', async () => {
  const page = await newPage();
  await page.goto(watchUrl(2));
  await expect.poll(() => phase(page), { timeout: 8_000, intervals: [100] }).toBe('content');
  await expect.poll(async () => (await tabMute(watchUrl(2)))?.muted, { timeout: 3_000 }).toBe(false);

  expect((await muteLog()).map((c) => c.muted)).toEqual([true, false]);
  const adRates = (await page.evaluate(() => globalThis.rateLog)).filter((r) => r.ad && r.rate === 16);
  expect(adRates.length).toBeGreaterThanOrEqual(2);
});

test("leaves another extension's mute alone", async () => {
  const page = await newPage();
  await page.goto('about:blank#pre');
  const tabId = await otherSw.evaluate(async () => (await chrome.tabs.query({})).find((t) => t.url === 'about:blank#pre')?.id);
  await otherSw.evaluate((id) => chrome.tabs.update(id, { muted: true }), tabId);

  await page.goto(watchUrl());
  await expect.poll(() => phase(page), { timeout: 6_000, intervals: [100] }).toBe('content');
  await page.waitForTimeout(1_500);

  const info = await tabMute(watchUrl());
  expect(info.muted).toBe(true);
  expect(info.extensionId).not.toBe(extId);
  expect((await muteLog()).filter((c) => c.ext === extId)).toEqual([]);
});

test('unmutes at once when the page is left during an ad', async () => {
  const page = await newPage();
  await page.goto(watchUrl());
  await expect.poll(async () => (await muteLog()).some((c) => c.muted), { timeout: 3_000, intervals: [20] }).toBe(true);
  const phaseAtLeave = await phase(page);
  const leftAt = Date.now();
  await page.goto('about:blank#left');
  await expect.poll(async () => (await tabMute('about:blank#left'))?.muted, { timeout: 7_000, intervals: [20] }).toBe(false);
  test.info().annotations.push({ type: 'unmuted after leaving (ms)', description: `${Date.now() - leftAt} (left during: ${phaseAtLeave})` });
});

test('ad stays muted when the player re-applies its own unmuted state', async () => {
  const page = await newPage();
  await page.goto(watchUrl(2, '&reapplyMute=1'));
  // Record whether the video is ever audible while an ad shows.
  await page.evaluate(() => {
    globalThis.audibleInAd = 0;
    globalThis.__fake.video.addEventListener('volumechange', () => {
      const v = globalThis.__fake.video;
      if (!v.muted && document.getElementById('movie_player').classList.contains('ad-showing')) {
        setTimeout(() => { if (!v.muted) globalThis.audibleInAd += 1; }, 50);
      }
    });
  });
  await expect.poll(() => phase(page), { timeout: 8_000, intervals: [100] }).toBe('content');
  const mutedAtPlaying = await page.evaluate(() => globalThis.mutedAtAdPlaying);
  expect(mutedAtPlaying.length).toBeGreaterThanOrEqual(2);
  expect(mutedAtPlaying.every(Boolean), 'both ads muted every time they start playing').toBe(true);
  expect(await page.evaluate(() => globalThis.audibleInAd), 'unmutes by the player are undone within 50 ms').toBe(0);
  await page.waitForTimeout(1_500);
  expect((await videoState(page)).muted).toBe(false);
});

test('a video the user muted before the ad stays muted after it', async () => {
  const page = await newPage();
  await page.goto(watchUrl(1, '&userMuted=1'));
  await expect.poll(() => phase(page), { timeout: 6_000, intervals: [100] }).toBe('content');
  await page.waitForTimeout(1_500);
  expect((await videoState(page)).muted).toBe(true);
});

test('a short ad (15 s) is not paused even when it can be skipped', async () => {
  const page = await newPage();
  await page.goto(watchUrl(1, '&skippable=1'));
  await expect.poll(() => phase(page), { timeout: 6_000, intervals: [100] }).toBe('content');
  expect(await page.evaluate(() => globalThis.adPauses)).toEqual([]);
});

test('a long ad (70 s) pauses once after 15 s, with Skip open even if it opens only then; the user presses it and the video goes on', async () => {
  const page = await newPage();
  const url = watchUrl(1, '&long=1&skippable=1&skipAt=15');
  await page.goto(url);
  await expect.poll(async () => (await videoState(page)).paused, { timeout: 3_000, intervals: [20] }).toBe(true);
  const [pause] = await page.evaluate(() => globalThis.adPauses);
  expect(pause.t).toBeGreaterThanOrEqual(15);
  expect(pause.d - pause.t).toBeGreaterThanOrEqual(50);
  // It stays paused and muted, waiting for the user.
  await page.waitForTimeout(1_000);
  expect(await phase(page)).toBe('ad');
  expect(await videoState(page)).toEqual({ rate: 16, paused: true, muted: true });
  // The picture is black, and the Skip button stays usable.
  expect(await brightestPixel(page), 'ad picture is black').toBeLessThanOrEqual(8);
  await expect(page.locator('.fake-skip')).toBeVisible();
  expect(await brightestPixel(page, '.fake-skip'), 'Skip is painted, toBeVisible ignores opacity').toBeGreaterThan(100);

  await page.locator('.fake-skip').click(); // a real (trusted) click
  await expect.poll(() => phase(page), { timeout: 2_000 }).toBe('content');
  await page.waitForTimeout(1_500);
  expect(await videoState(page)).toEqual({ rate: 1, paused: false, muted: false });
  expect(await brightestPixel(page), 'content picture is back').toBeGreaterThan(100);
  await expect.poll(async () => (await tabMute(url))?.muted, { timeout: 3_000 }).toBe(false);
});

test('if the user resumes a long ad instead of skipping, it is not paused again', async () => {
  const page = await newPage();
  await page.goto(watchUrl(1, '&long=1&skippable=1'));
  await expect.poll(async () => (await videoState(page)).paused, { timeout: 3_000, intervals: [20] }).toBe(true);
  // Resume from 15 s, still inside the rule's range, so only the once-per-ad rule keeps it
  // playing. The rest (55 s) runs at 16x.
  await page.evaluate(() => { const v = globalThis.__fake.video; v.currentTime = 15; return v.play(); });
  await expect.poll(() => phase(page), { timeout: 10_000, intervals: [100] }).toBe('content');
  expect(await page.evaluate(() => globalThis.adPauses.length)).toBe(1);
  expect(await page.evaluate(() => globalThis.__fake.state().skipped)).toBe(0);
});

test("the user's own unmute during an ad is respected", async () => {
  const page = await newPage();
  await page.goto(watchUrl(1, '&long=1&skippable=1'));
  // The long ad pauses, which leaves time to click.
  await expect.poll(async () => (await videoState(page)).paused, { timeout: 3_000, intervals: [20] }).toBe(true);
  expect((await videoState(page)).muted).toBe(true);
  await page.locator('.ytp-mute-button').click({ delay: 120 });
  await page.waitForTimeout(800); // several poll ticks
  expect((await videoState(page)).muted).toBe(false);
  expect((await videoState(page)).rate, 'a volume press is not taken for Skip').toBe(16);
});

test('the toolbar button unmutes only the ad break it is clicked in', async () => {
  const page = await newPage();
  const url = watchUrl(1, '&noPreroll=1&long=1&skippable=1');
  await page.goto(url);
  await expect.poll(() => page.evaluate(() => globalThis.__fake.video.readyState), { timeout: 3_000, intervals: [20] }).toBeGreaterThanOrEqual(3);
  const tabId = await otherSw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, url);
  // What sw.js does on a toolbar click (a test cannot click the toolbar).
  const clickToolbar = () => extSw.evaluate((id) => {
    unmute(id);
    return chrome.tabs.sendMessage(id, { t: 'release' }, { frameId: 0 }).catch(() => {});
  }, tabId);

  // A click during the video does not carry over to the next ad.
  await clickToolbar();
  await page.waitForTimeout(300);
  await page.evaluate(() => globalThis.__fake.midroll());
  await expect.poll(async () => (await videoState(page)).paused, { timeout: 3_000, intervals: [20] }).toBe(true);
  expect((await videoState(page)).muted).toBe(true);
  await expect.poll(async () => (await tabMute(url))?.muted, { timeout: 2_000, intervals: [20] }).toBe(true);

  // A click during the ad unmutes the video and the tab, and they stay unmuted.
  await clickToolbar();
  await page.waitForTimeout(1_500); // several poll ticks and renewal periods
  expect((await videoState(page)).muted).toBe(false);
  expect((await tabMute(url))?.muted).toBe(false);
});

// YouTube's order after Skip is not known, so both are covered, on a paused ad and on one still
// playing. Sound comes back once the class is gone and the content has started, so the only
// allowed silence is the time the class outlasts the content start. The content-first case holds
// the press for 900 ms, a slow click: the rate must stay down for all of it.
for (const [order, extra, silenceMs, holdMs] of [
  ['the class goes first', '&contentDelay=500', 0, 120],
  ['the content starts first', '&classLag=150', 200, 900],
]) {
  for (const adState of ['paused', 'playing']) {
    test(`after Skip on a ${adState} ad the content starts at 1x with sound when ${order}`, async () => {
      const page = await newPage();
      await page.goto(watchUrl(1, `&long=1&skippable=1${extra}`));
      await expect.poll(async () => (await videoState(page)).paused, { timeout: 3_000, intervals: [20] }).toBe(true);
      if (adState === 'playing') await page.evaluate(() => globalThis.__fake.video.play());
      await page.locator('.fake-skip').click({ delay: holdMs });
      await expect.poll(() => page.evaluate(() => globalThis.contentStart), { timeout: 3_000, intervals: [20] }).not.toBeNull();
      await page.waitForTimeout(1_000);

      const seen = await page.evaluate(() => {
        const { contentStart, unmutedAt, unmutedOnPlayingAd, rateLog } = globalThis;
        return { contentStart, unmutedAt, unmutedOnPlayingAd, rateLog, timeOrigin: performance.timeOrigin };
      });
      expect(seen.contentStart.rate).toBe(1);
      expect(seen.rateLog.filter((r) => r.content && r.rate === 16), 'content never at 16x').toEqual([]);
      expect(seen.unmutedOnPlayingAd, 'the skipped ad is never audible').toBe(0);
      expect(seen.unmutedAt).not.toBeNull();
      expect(seen.unmutedAt - seen.contentStart.at, 'video silent after the content started (ms)').toBeLessThanOrEqual(silenceMs);
      const tabRelease = (await muteLog()).at(-1);
      expect(tabRelease.muted).toBe(false);
      const tabSilence = tabRelease.at - (seen.timeOrigin + seen.contentStart.at);
      expect(tabSilence, 'tab silent after the content started (ms)').toBeLessThanOrEqual(silenceMs + 100);
      expect(await videoState(page)).toEqual({ rate: 1, paused: false, muted: false });
    });
  }
}

test('a press on Skip puts the rate back before the click lands', async () => {
  const page = await newPage();
  await page.goto(watchUrl(1, '&long=1&skippable=1&contentDelay=500'));
  await expect.poll(async () => (await videoState(page)).paused, { timeout: 3_000, intervals: [20] }).toBe(true);
  await page.evaluate(() => globalThis.__fake.video.play()); // about 3 s left at 16x
  await page.locator('.fake-skip').hover();
  await page.mouse.down();
  await expect.poll(async () => (await videoState(page)).rate, { timeout: 500, intervals: [10] }).toBe(1);
  await page.waitForTimeout(150);
  expect((await videoState(page)).rate, 'it stays down for the length of a press').toBe(1);
  expect(await phase(page), 'still the ad until the click').toBe('ad');
  await page.mouse.up();
  await expect.poll(() => phase(page), { timeout: 1_000 }).toBe('content');
});

test('Skip on a playing ad of a pod keeps the gap muted, and the next ad starts at 16x', async () => {
  const page = await newPage();
  await page.goto(watchUrl(2, '&long=1&skippable=1'));
  await expect.poll(async () => (await videoState(page)).paused, { timeout: 3_000, intervals: [20] }).toBe(true);
  await page.evaluate(() => globalThis.__fake.video.play());
  const startsBefore = await page.evaluate(() => globalThis.rateAtAdPlaying.length);
  await page.locator('.fake-skip').click({ delay: 120 });
  await expect.poll(() => page.evaluate(() => globalThis.__fake.state().played), { timeout: 2_000 }).toBe(1);
  await expect.poll(() => page.evaluate(() => globalThis.rateAtAdPlaying.length), { timeout: 3_000, intervals: [20] }).toBeGreaterThan(startsBefore);

  expect((await page.evaluate(() => globalThis.rateAtAdPlaying)).at(-1), 'next ad at 16x from its first frame').toBe(16);
  expect(await page.evaluate(() => globalThis.unmutedOnPlayingAd), 'muted through the gap').toBe(0);
  expect((await muteLog()).map((c) => c.muted), 'one mute, not released in the gap').toEqual([true]);
});

test('Skip during a mid-roll gives a video watched at 2x its rate back', async () => {
  const page = await newPage();
  await page.goto(watchUrl(1, '&noPreroll=1&long=1&skippable=1&classLag=150'));
  await expect.poll(() => page.evaluate(() => globalThis.__fake.video.readyState), { timeout: 3_000, intervals: [20] }).toBeGreaterThanOrEqual(3);
  await page.evaluate(() => { globalThis.__fake.video.playbackRate = 2; });
  await page.waitForTimeout(200); // past the fake's own classLag timer from the start of the page
  await page.evaluate(() => globalThis.__fake.midroll());
  await expect.poll(async () => (await videoState(page)).paused, { timeout: 3_000, intervals: [20] }).toBe(true);
  await page.locator('.fake-skip').click({ delay: 120 });
  await expect.poll(() => phase(page), { timeout: 2_000 }).toBe('content');
  await page.waitForTimeout(1_000);
  expect((await videoState(page)).rate).toBe(2);
});

test('after Skip the long-ad rule leaves a video alone that resumes before the class goes', async () => {
  const page = await newPage();
  await page.goto(watchUrl(1, '&long=1&skippable=1&classLag=150&resume=16')); // inside the rule's range
  await expect.poll(async () => (await videoState(page)).paused, { timeout: 3_000, intervals: [20] }).toBe(true);
  await page.locator('.fake-skip').click({ delay: 120 });
  await expect.poll(() => phase(page), { timeout: 2_000 }).toBe('content');
  await page.waitForTimeout(1_000);
  expect(await videoState(page)).toEqual({ rate: 1, paused: false, muted: false });
});

test('a press in the player that is not Skip only slows the ad for a moment', async () => {
  const page = await newPage();
  await page.goto(watchUrl(1, '&long=1&skippable=1'));
  await expect.poll(async () => (await videoState(page)).paused, { timeout: 3_000, intervals: [20] }).toBe(true);
  await page.evaluate(() => globalThis.__fake.video.play());
  await page.locator('#movie_player video').click();
  await expect.poll(async () => (await videoState(page)).rate, { timeout: 500, intervals: [10] }).toBe(1);
  await expect.poll(async () => (await videoState(page)).rate, { timeout: 3_000, intervals: [50] }).toBe(16);
  expect(await phase(page)).toBe('ad');
  expect((await videoState(page)).muted).toBe(true);
});

test('after Skip, the next ad of the pod is muted even if the player unmutes on load', async () => {
  const page = await newPage();
  await page.goto(watchUrl(2, '&long=1&skippable=1&reapplyMute=1'));
  await expect.poll(async () => (await videoState(page)).paused, { timeout: 3_000, intervals: [20] }).toBe(true);
  const playsBefore = await page.evaluate(() => globalThis.mutedAtAdPlaying.length);
  await page.locator('.fake-skip').click();
  // Second ad: wait until it has started playing, then until it pauses after its own first 15 s.
  await expect.poll(() => page.evaluate(() => globalThis.mutedAtAdPlaying.length), { timeout: 3_000, intervals: [20] }).toBeGreaterThan(playsBefore);
  await expect.poll(async () => (await videoState(page)).paused, { timeout: 3_000, intervals: [20] }).toBe(true);
  expect(await videoState(page)).toEqual({ rate: 16, paused: true, muted: true });
  expect((await page.evaluate(() => globalThis.mutedAtAdPlaying)).every(Boolean)).toBe(true);
});
