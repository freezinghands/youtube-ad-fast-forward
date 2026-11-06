# Contributing

Thanks for helping. This project is deliberately small, so please read the ground rules before you start on a change. Questions and ideas go to [Discussions](https://github.com/freezinghands/youtube-ad-fast-forward/discussions), bugs and translations to the issue forms. Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

## Ground rules

- `extension/` has no build step and no dependencies: Chrome loads the files as they are.
- No new permissions. The extension asks only to run its content script on `www.youtube.com`.
- The scope is to mute ads, black them out, play them at 16x and pause long ads once. The user presses Skip; the extension never clicks it (YouTube ignores clicks made by scripts).
- 16x is a deliberate choice. Open an issue before you propose to change it.
- A change in behaviour comes with an end-to-end test that fails without it, and with a README update.
- Docs and comments say what the code does and why, not how it got there.
- Each file in `extension/` keeps its license header (the copyright line and `SPDX-License-Identifier: Apache-2.0`). A new file gets the same header.

## Development setup

You need bash, Node.js 22 or later and ffmpeg (with libvpx-vp9 and libopus, which the default Homebrew and apt builds include). To try the extension by hand you also need Chrome 123 or later.

```sh
cd test
npm ci
npx playwright install --no-shell chromium   # again whenever the Playwright version changes
npm test                                     # the first run also generates test/media/
```

To use a Chromium or Chrome for Testing you already have, set `PW_CHROMIUM_EXECUTABLE` to the path of its executable. Google Chrome itself does not work: it ignores `--load-extension`, so every test times out waiting for the extension's service worker.

To try a change in your own browser, load `extension/` as described in the README, click the reload button on the extension in `chrome://extensions` after each change, and reload your YouTube tabs.

## How the tests work

- `test/e2e.spec.mjs` starts Chromium with `extension/` and a helper extension, `test/other-ext/`. The tests use the helper to find a tab by its URL (it has the `tabs` permission for that), to read the tab's mute state and to mute the tab as another extension would.
- The tests answer every request to `https://www.youtube.com/` themselves, with a fake watch page (`test/fake-youtube/player.js`) and generated media. The browser cannot resolve `www.youtube.com`, so the real site is never contacted.
- The fake page copies only YouTube's element id and class names. Its query options (number of ads, long ads, when Skip opens, the order of events after Skip, and so on) are listed at the top of `player.js`.
- The tests depend on timing, so they run one at a time. On CI a failed test is retried once.
- When CI fails, the Playwright traces are uploaded as the `test-results` artifact. Open one with `npx playwright show-trace <file>`.

The tests cannot follow YouTube's real player. Changes that depend on YouTube's behaviour also need a manual check on youtube.com with the unpacked extension.

## Translations

The extension's name, description and toolbar tooltip live in `extension/_locales/<code>/messages.json`, with English (`en`) as the default.

1. Copy `extension/_locales/en/messages.json` to `extension/_locales/<code>/messages.json`, where `<code>` is one of [the locale codes Chrome supports](https://developer.chrome.com/docs/extensions/reference/api/i18n#locales), for example `ja`, `pt_BR` or `zh_TW`.
2. Translate each `message`. Leave each `description` in English: it tells translators what the message is for and is never shown to users.
3. Keep "YouTube" as it is, write 16x the way your language writes a playback speed (the Korean text uses "16배속"), keep the name within 75 characters and the description within 132, and keep the name recognisable: the Korean name, for example, is the English name followed by a Korean subtitle.
4. Load the extension with Chrome set to that language and check `chrome://extensions` and the toolbar tooltip.

A README translation goes in `README.<code>.md`, linked from the language line at the top of `README.md`. The English README is the reference: a translation states that it is one and links to the English version. Translations of the Chrome Web Store listing can be sent with the translation issue form; the maintainer adds them to the store.

## Icons

`assets/icon.svg` is the icon source. `extension/icons/128.png` is exported from it as it is, with the 16 px of transparent padding the Chrome Web Store asks for. The 16, 32 and 48 px icons are exported with `viewBox="14 14 100 100"`, so the tile fills the toolbar slot. The icon must not use YouTube's logo or colours.

## When YouTube changes

YouTube changes its player without notice, and the extension can break as a result. If it does, open an issue with the bug report form and describe what you saw and heard. If you can, include the classes on `#movie_player` while the ad shows. Never paste cookies or account details.

## Pull requests

- Keep each pull request to one change, and explain the reason for it.
- Run `npm test` in `test/` before you push. CI runs the same tests, and it must pass.
- Leave `version` in `extension/manifest.json` as it is. The maintainer sets it on release.
- By submitting a contribution you agree that it is licensed under the [Apache License 2.0](LICENSE), as section 5 of the license describes.

## Releases

The maintainer sets `version` in `extension/manifest.json`, merges it to `main` and pushes a tag with the same version, for example `v0.5.0`. The release workflow checks that the tag matches the manifest, packages `extension/` with LICENSE and NOTICE into a ZIP, and publishes a GitHub release with it. That ZIP is what goes to the browser stores.
