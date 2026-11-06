// Stand-in for the YouTube watch page, served by the e2e in place of youtube.com. Only YouTube's
// element id and class names are copied, no YouTube code or media. It builds #movie_player with
// the main <video>, an ad module and a mute button, plays `ads` ads (default 1) under the
// `ad-showing` class, then the content video. Between two ads the class is off for 300 ms, as
// in a pod. The Skip button has a made-up class, so the extension cannot depend on YouTube's
// markup, and like YouTube's it ignores script clicks.
// Query options:
//   long=1             70 s ads instead of 15 s
//   skippable=1        show Skip after skipAt=<s> of ad time (default 5)
//   reapplyMute=1      set muted=false on every load and 700 ms after each ad starts playing, as
//                      the player may when it re-applies its own stored state
//   userMuted=1        start with the video muted by the user
//   contentDelay=<ms>  after the last ad, remove the class at once but start the content this
//                      much later (the ad source keeps running until then)
//   classLag=<ms>      after the last ad, start the content at once but remove the class this
//                      much later
//   resume=<s>         start the content at this position of a 70 s video
//   noPreroll=1        start with the content; __fake.midroll() then plays an ad
(() => {
  const q = new URLSearchParams(location.search);
  const ads = Number(q.get('ads') || 1);
  const skippable = q.get('skippable') === '1';
  const skipAt = Number(q.get('skipAt') || 5);
  const adFile = q.get('long') === '1' ? 'ad-long.webm' : 'ad.webm';
  const reapplyMute = q.get('reapplyMute') === '1';
  const contentDelay = Number(q.get('contentDelay') || 0);
  const classLag = Number(q.get('classLag') || 0);
  const resume = Number(q.get('resume') || 0);

  const player = document.createElement('div');
  player.id = 'movie_player';
  player.className = 'html5-video-player';
  const video = document.createElement('video');
  video.className = 'html5-main-video';
  video.muted = q.get('userMuted') === '1';
  const adModule = document.createElement('div');
  adModule.className = 'video-ads ytp-ad-module';
  const skip = document.createElement('button');
  skip.className = 'fake-skip';
  skip.textContent = 'Skip';
  skip.style.display = 'none';
  adModule.appendChild(skip);
  const muteButton = document.createElement('button');
  muteButton.className = 'ytp-mute-button';
  muteButton.textContent = 'Mute';
  muteButton.addEventListener('click', () => {
    video.muted = !video.muted;
  });
  player.append(video, adModule, muteButton);
  document.body.appendChild(player);

  let phase = 'ad';
  let played = 0;
  let skipped = 0;
  const play = () => video.play().catch(() => {});
  const setAdClass = (on) => {
    player.classList.toggle('ad-showing', on);
    player.classList.toggle('ad-interrupting', on);
  };
  function ad() {
    phase = 'ad';
    setAdClass(true);
    skip.style.display = 'none';
    video.src = `/fake/media/${adFile}`;
    play();
  }
  function content() {
    phase = 'content';
    skip.style.display = 'none';
    const start = () => {
      video.src = resume ? `/fake/media/ad-long.webm#t=${resume}` : '/fake/media/content.webm';
      play();
    };
    if (classLag) {
      start();
      setTimeout(() => setAdClass(false), classLag);
    } else if (contentDelay) {
      setAdClass(false);
      setTimeout(start, contentDelay);
    } else {
      setAdClass(false);
      start();
    }
  }
  function adDone() {
    played += 1;
    if (played < ads) {
      setAdClass(false);
      setTimeout(ad, 300);
    } else {
      content();
    }
  }
  video.addEventListener('loadstart', () => {
    if (reapplyMute) video.muted = false;
  });
  video.addEventListener('playing', () => {
    if (reapplyMute && phase === 'ad') setTimeout(() => { video.muted = false; }, 700);
  });
  video.addEventListener('timeupdate', () => {
    if (phase === 'ad' && skippable && video.currentTime >= skipAt) skip.style.display = '';
  });
  video.addEventListener('ended', () => {
    if (phase === 'ad') adDone();
  });
  skip.addEventListener('click', (e) => {
    if (!e.isTrusted || phase !== 'ad') return;
    skipped += 1;
    adDone();
  });

  function midroll() {
    played = 0;
    setAdClass(true); // the source loads a moment later, so the extension sees the content's rate
    setTimeout(ad, 50);
  }

  window.__fake = { state: () => ({ phase, played, skipped }), video, midroll };
  if (q.get('noPreroll') === '1') content();
  else ad();
})();
