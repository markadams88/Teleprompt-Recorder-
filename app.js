/* Teleprompter — plain JavaScript, no build step. */
(function () {
  'use strict';

  // ---------------------------------------------------------------- helpers

  const $ = (id) => document.getElementById(id);

  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v === null ? fallback : JSON.parse(v);
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage full or blocked */ }
    }
  };

  const KEYS = {
    script: 'tp.script',
    size: 'tp.fontSize',
    speed: 'tp.speed',
    countdown: 'tp.countdown',
    camera: 'tp.cameraId',
    mic: 'tp.micId',
    recorder: 'tp.recorderFormat'
  };

  const IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const IS_DESKTOP = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  // Safari writes the most reliable MP4 in one go; other browsers are happy with 1-second pieces.
  const IS_SAFARI = /^((?!chrome|chromium|crios|fxios|android|edg).)*safari/i.test(navigator.userAgent);

  const READING_POS = 1 / 3;    // reading line, fraction of screen height
  const LINE_HEIGHT = 1.3;      // must match .script-text line-height
  const HIDE_DELAY = 3000;      // controls auto-hide (ms)

  let toastTimer = 0;
  function toast(msg, ms) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms || 3500);
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  // Short log of recorder events, shown if a recording fails, to help troubleshoot.
  const recLog = [];
  let recLogStart = 0;
  function logRec(msg) {
    const t = recLogStart ? ((performance.now() - recLogStart) / 1000).toFixed(1) : '0.0';
    recLog.push(`${t}s ${msg}`);
    if (recLog.length > 40) recLog.shift();
  }

  function formatTime(ms) {
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
  }

  function formatDuration(ms) {
    const total = Math.round(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m ? `${m} min ${s} s` : `${s} s`;
  }

  // ---------------------------------------------------------------- elements

  const screens = {
    script: $('screen-script'),
    record: $('screen-record'),
    preview: $('screen-preview')
  };

  const scriptInput = $('script-input');
  const saveStatus = $('save-status');
  const wordCount = $('word-count');

  const stage = $('stage');
  const video = $('camera');
  const band = $('band');
  const textEl = $('script-text');
  const readingLine = $('reading-line');
  const controls = $('controls');
  const topbar = $('topbar');
  const sizeSlider = $('size-slider');
  const speedSlider = $('speed-slider');
  const playBtn = $('play-btn');
  const recordBtn = $('record-btn');
  const flipBtn = $('flip-btn');
  const mirrorBtn = $('mirror-btn');
  const resetBtn = $('reset-btn');
  const backBtn = $('back-btn');
  const countdownBtn = $('countdown-btn');
  const recIndicator = $('rec-indicator');
  const recTime = $('rec-time');
  const captureInfo = $('capture-info');
  const countdownEl = $('countdown');
  const countdownNum = $('countdown-num');
  const cameraMsg = $('camera-msg');

  const clipVideo = $('clip');
  const clipInfo = $('clip-info');
  const saveBtn = $('save-btn');
  const downloadLink = $('download-link');
  const shareStatus = $('share-status');

  // ---------------------------------------------------------------- state

  const state = {
    screen: 'script',
    // camera
    stream: null,
    facing: 'user',
    mirror: true,
    cameraId: store.get(KEYS.camera, ''),
    micId: store.get(KEYS.mic, ''),
    cameraReq: 0,
    // scrolling
    playing: false,
    dragging: false,
    offset: 0,
    lastTs: 0,
    raf: 0,
    readingY: 0,
    textHeight: 0,
    fontSize: store.get(KEYS.size, 44),
    speedLevel: store.get(KEYS.speed, 45),
    countdown: store.get(KEYS.countdown, true),
    // recording
    recorder: null,
    recConfigs: [],
    recConfigIdx: 0,
    recConfigStartedAt: 0,
    chunks: [],
    mimeType: '',
    recording: false,
    recStartedAt: 0,
    recStartDate: null,
    recElapsed: 0,
    recTimer: 0,
    countdownTimer: 0,
    countingDown: false,
    // preview
    clipUrl: '',
    clipFile: null,
    saved: false,
    // misc
    wakeLock: null,
    hideTimer: 0,
    finishTimer: 0
  };

  function showScreen(name) {
    state.screen = name;
    Object.keys(screens).forEach((key) => { screens[key].hidden = key !== name; });
  }

  // ================================================================ 1. SCRIPT SCREEN

  let saveTimer = 0;

  function updateWordCount() {
    const words = (scriptInput.value.match(/\S+/g) || []).length;
    if (!words) { wordCount.textContent = ''; return; }
    const ms = (words / 140) * 60000; // a typical speaking pace
    wordCount.textContent = `${words.toLocaleString('en-GB')} word${words === 1 ? '' : 's'} · about ${formatDuration(ms)} to read aloud`;
  }

  function saveScript() {
    clearTimeout(saveTimer);
    store.set(KEYS.script, scriptInput.value);
    saveStatus.textContent = 'Saved';
  }

  scriptInput.value = store.get(KEYS.script, '');
  updateWordCount();
  if (scriptInput.value) saveStatus.textContent = 'Saved';

  scriptInput.addEventListener('input', () => {
    saveStatus.textContent = 'Saving…';
    updateWordCount();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveScript, 400);
  });

  $('clear-btn').addEventListener('click', () => {
    if (!scriptInput.value) return;
    if (!confirm('Clear the whole script? This can’t be undone.')) return;
    scriptInput.value = '';
    saveScript();
    updateWordCount();
  });

  // IMPORTANT (iOS): the camera is requested synchronously inside this tap handler,
  // so Safari treats it as user-initiated on first use.
  $('start-btn').addEventListener('click', () => {
    saveScript();
    scriptInput.blur();
    enterRecording();
  });

  window.addEventListener('pagehide', () => { if (state.screen === 'script') saveScript(); });

  // ================================================================ 2. RECORDING SCREEN

  function enterRecording() {
    const text = scriptInput.value.trim() ? scriptInput.value : '';
    textEl.textContent = text || 'Your script is empty. Go back and paste or type it on the Script screen.';
    textEl.classList.toggle('is-empty', !text);

    showScreen('record');
    applyFontSize();
    applySpeedLabel();
    updateCountdownBtn();
    setPlaying(false);
    state.offset = 0;
    layout();
    showControls();
    requestWakeLock();
    startCamera();
  }

  function exitRecording() {
    if (state.recording) return;
    cancelCountdown();
    setPlaying(false);
    stopStream();
    releaseWakeLock();
    hideCameraMessage();
    showScreen('script');
  }

  backBtn.addEventListener('click', exitRecording);

  // ---------------------------------------------------------------- scrolling

  function speedPx() {
    // Exponential: fine steps at the slow end. Level 1 ≈ 4 px/s, level 100 ≈ 300 px/s.
    return 4 * Math.pow(75, (state.speedLevel - 1) / 99);
  }

  function maxOffset() { return Math.max(0, state.textHeight - state.fontSize * LINE_HEIGHT); }

  function applyOffset() {
    // Centre of the current line sits on the reading line.
    const y = state.readingY - state.offset - (state.fontSize * LINE_HEIGHT) / 2;
    textEl.style.transform = `translate3d(0, ${y.toFixed(2)}px, 0)`;
  }

  function layout() {
    state.readingY = stage.clientHeight * READING_POS - band.offsetTop;
    readingLine.style.top = `${state.readingY}px`;
    state.textHeight = textEl.offsetHeight;
    applyOffset();
  }

  function tick(ts) {
    state.raf = 0;
    if (!state.playing) return;
    const dt = state.lastTs ? Math.min((ts - state.lastTs) / 1000, 0.1) : 0;
    state.lastTs = ts;
    if (!state.dragging) {
      state.offset += speedPx() * dt;
      const max = maxOffset();
      if (state.offset >= max) {
        state.offset = max;
        applyOffset();
        setPlaying(false);
        return;
      }
      applyOffset();
    }
    state.raf = requestAnimationFrame(tick);
  }

  function setPlaying(on) {
    if (on && state.offset >= maxOffset() && maxOffset() > 0) state.offset = 0; // finished: start again
    state.playing = on;
    playBtn.classList.toggle('is-playing', on);
    playBtn.setAttribute('aria-label', on ? 'Pause scroll' : 'Play scroll');
    $('play-label').textContent = on ? 'Pause' : 'Play';
    if (on && !state.raf) {
      state.lastTs = 0;
      state.raf = requestAnimationFrame(tick);
    } else if (!on && state.raf) {
      cancelAnimationFrame(state.raf);
      state.raf = 0;
    }
    if (!on) applyOffset();
  }

  function togglePlay() { setPlaying(!state.playing); }

  function resetScroll() {
    state.offset = 0;
    applyOffset();
  }

  // Keep position proportional when the text reflows (size change, rotation).
  if ('ResizeObserver' in window) {
    new ResizeObserver(() => {
      const old = state.textHeight;
      const h = textEl.offsetHeight;
      if (old > 0 && h > 0 && h !== old) state.offset *= h / old;
      state.textHeight = h;
      applyOffset();
    }).observe(textEl);
    new ResizeObserver(() => layout()).observe(stage);
  } else {
    window.addEventListener('resize', layout);
  }
  window.addEventListener('orientationchange', () => setTimeout(layout, 300));

  // ---------------------------------------------------------------- sliders

  function applyFontSize() {
    sizeSlider.value = state.fontSize;
    $('size-value').textContent = state.fontSize;
    textEl.style.fontSize = `${state.fontSize}px`;
  }

  function applySpeedLabel() {
    speedSlider.value = state.speedLevel;
    $('speed-value').textContent = state.speedLevel;
  }

  sizeSlider.addEventListener('input', () => {
    state.fontSize = Number(sizeSlider.value);
    applyFontSize();
    store.set(KEYS.size, state.fontSize);
    showControls();
  });

  speedSlider.addEventListener('input', () => {
    state.speedLevel = Number(speedSlider.value);
    applySpeedLabel();
    store.set(KEYS.speed, state.speedLevel);
    showControls();
  });

  // ---------------------------------------------------------------- controls show / hide

  function showControls() {
    controls.classList.remove('is-hidden');
    topbar.classList.remove('is-hidden');
    clearTimeout(state.hideTimer);
    state.hideTimer = setTimeout(hideControls, HIDE_DELAY);
  }

  function hideControls() {
    controls.classList.add('is-hidden');
    topbar.classList.add('is-hidden');
  }

  // Any touch within the controls keeps them visible.
  [controls, topbar].forEach((el) => {
    el.addEventListener('pointerdown', showControls);
    el.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'touch') showControls(); });
  });

  // Tap the screen to show controls; tap the text to pause/play; drag the text to scroll by hand.
  let drag = null;

  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.chrome, .camera-msg, .sheet')) return;
    drag = {
      id: e.pointerId,
      y: e.clientY,
      startOffset: state.offset,
      moved: false,
      onText: !!e.target.closest('#band')
    };
  });

  stage.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(dy) > 10) {
      drag.moved = true;
      if (drag.onText) state.dragging = true;
    }
    if (drag.moved && drag.onText) {
      state.offset = Math.min(maxOffset(), Math.max(0, drag.startOffset - dy));
      applyOffset();
    }
  });

  function endDrag(e, cancelled) {
    if (!drag || e.pointerId !== drag.id) return;
    if (!cancelled && !drag.moved && drag.onText) togglePlay();
    if (!cancelled) showControls();
    state.dragging = false;
    state.lastTs = 0;
    drag = null;
  }
  stage.addEventListener('pointerup', (e) => endDrag(e, false));
  stage.addEventListener('pointercancel', (e) => endDrag(e, true));

  playBtn.addEventListener('click', togglePlay);
  resetBtn.addEventListener('click', resetScroll);

  // ---------------------------------------------------------------- countdown toggle

  function updateCountdownBtn() {
    countdownBtn.textContent = `3-2-1: ${state.countdown ? 'On' : 'Off'}`;
    countdownBtn.setAttribute('aria-pressed', String(state.countdown));
  }

  countdownBtn.addEventListener('click', () => {
    state.countdown = !state.countdown;
    store.set(KEYS.countdown, state.countdown);
    updateCountdownBtn();
  });

  // ================================================================ CAMERA

  const AUDIO_CONSTRAINTS = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    sampleRate: { ideal: 48000 },
    channelCount: { ideal: 2 }   // stereo if the microphone offers it
  };

  function videoConstraints(useIds) {
    const c = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
    if (useIds && state.cameraId) c.deviceId = { exact: state.cameraId };
    else c.facingMode = { ideal: state.facing };
    return c;
  }

  function audioConstraints(useIds) {
    const c = Object.assign({}, AUDIO_CONSTRAINTS);
    if (useIds && state.micId) c.deviceId = { exact: state.micId };
    return c;
  }

  function stopStream() {
    state.cameraReq++; // invalidates any camera request still in flight
    if (state.stream) {
      state.stream.getTracks().forEach((t) => t.stop());
      state.stream = null;
    }
    video.srcObject = null;
  }

  // Note: getUserMedia is called before the first `await`, so when this runs
  // from a tap handler it is still inside the user gesture.
  async function openCamera() {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(true), audio: audioConstraints(true) });
    } catch (err) {
      const name = err && err.name;
      if (name !== 'OverconstrainedError' && name !== 'NotFoundError' && name !== 'TypeError') throw err;
      // A remembered camera or microphone has gone (e.g. unplugged): forget it and use the default.
      if (state.cameraId || state.micId) {
        state.cameraId = ''; state.micId = '';
        store.set(KEYS.camera, ''); store.set(KEYS.mic, '');
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(false), audio: audioConstraints(false) });
        } catch (e2) {
          stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        }
      } else {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      }
    }
    const track = stream.getVideoTracks()[0];
    if (track) await improveVideo(track);
    return stream;
  }

  // Step up to the best mode the camera actually supports, without a new permission prompt.
  async function improveVideo(track) {
    if (!track.applyConstraints) return;
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    const capLong = Math.max((caps.width && caps.width.max) || 0, (caps.height && caps.height.max) || 0);
    const capShort = Math.min((caps.width && caps.width.max) || 0, (caps.height && caps.height.max) || 0);
    const capFps = (caps.frameRate && caps.frameRate.max) || 0;

    // Resolution first, at 30 fps: for talking to camera, 30 fps lets each frame gather
    // more light (less noise indoors) and matches the Camera app's default.
    const ladder = [[3840, 2160, 30], [1920, 1080, 30]];

    await setAutoModes(track, caps);
    for (const [w, h, fps] of ladder) {
      if (capLong && (capLong < w || capShort < h)) continue;   // sensor mode not offered
      if (fps > 30 && capFps && capFps < fps) continue;
      const before = track.getSettings();
      if (meets(before, w, fps)) return;                         // already there
      try {
        await track.applyConstraints({
          width: { ideal: w },
          height: { ideal: h },
          frameRate: { ideal: fps }
        });
      } catch (e) { /* try the next step down */ }
      if (meets(track.getSettings(), w, fps)) return;
    }
  }

  // Continuous auto focus, exposure and white balance, where Safari exposes them.
  async function setAutoModes(track, caps) {
    const modes = {};
    ['focusMode', 'exposureMode', 'whiteBalanceMode'].forEach((key) => {
      if (Array.isArray(caps[key]) && caps[key].includes('continuous')) modes[key] = 'continuous';
    });
    if (!Object.keys(modes).length) return;
    try { await track.applyConstraints({ advanced: [modes] }); } catch (e) { /* not supported */ }
  }

  function meets(s, w, fps) {
    const long = Math.max(s.width || 0, s.height || 0);
    return long >= w * 0.95 && (s.frameRate || 0) >= fps - 1;
  }

  async function startCamera() {
    hideCameraMessage();
    captureInfo.textContent = 'Starting camera…';

    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showCameraMessage('Camera not available',
        'This browser can’t use the camera here. Use an up-to-date Safari, Chrome or Edge, and open the app over https.', false);
      return;
    }

    stopStream();
    const req = state.cameraReq;
    updateCameraButtons();
    try {
      const stream = await openCamera();
      if (req !== state.cameraReq || state.screen !== 'record') {
        stream.getTracks().forEach((t) => t.stop()); // user left or switched meanwhile
        return;
      }
      attachStream(stream);
    } catch (err) {
      if (req !== state.cameraReq) return;
      showCameraError(err);
    } finally {
      updateCameraButtons();
    }
  }

  function attachStream(stream) {
    state.stream = stream;
    video.muted = true;               // iOS: inline autoplay needs muted + playsinline
    video.setAttribute('playsinline', '');
    video.srcObject = stream;
    const p = video.play();
    if (p && p.catch) p.catch(() => { /* will start on the next tap */ });

    // Which way does this camera face? (Laptop webcams usually don't say: treat as facing you.)
    const vt = stream.getVideoTracks()[0];
    if (vt) {
      const vs = vt.getSettings();
      if (vs.facingMode) state.facing = vs.facingMode === 'environment' ? 'environment' : 'user';
      else state.facing = /back|rear|environment/i.test(vt.label) ? 'environment' : 'user';
    }
    state.mirror = state.facing === 'user';
    applyMirror();
    refreshDeviceLists();

    stream.getTracks().forEach((t) => {
      t.addEventListener('ended', () => {
        if (state.stream !== stream || state.screen !== 'record') return;
        logRec(`${t.kind} track ended`);
        if (state.recording) stopRecording();
        showCameraMessage('Camera stopped',
          'The camera or microphone was interrupted (perhaps by a call or another app). Tap below to start it again.', true);
      });
    });

    updateCaptureInfo();
  }

  function updateCaptureInfo() {
    const track = state.stream && state.stream.getVideoTracks()[0];
    if (!track) return;
    const s = track.getSettings();
    // videoWidth/videoHeight reflect the real frames (and their orientation).
    const w = video.videoWidth || s.width || 0;
    const h = video.videoHeight || s.height || 0;
    const fps = s.frameRate ? Math.round(s.frameRate) : '?';
    const audio = state.stream.getAudioTracks()[0];
    const rate = audio && audio.getSettings().sampleRate;
    let txt = `${w}×${h} · ${fps} fps`;
    if (rate) txt += ` · ${(rate / 1000).toFixed(rate % 1000 ? 1 : 0)} kHz`;
    const ch = audio && audio.getSettings().channelCount;
    if (ch) txt += ch > 1 ? ' stereo' : ' mono';
    if (state.recording && state.recorder) {
      const vb = state.recorder.videoBitsPerSecond;
      txt += ` · ${codecLabel(state.mimeType)}${vb ? ` ${Math.round(vb / 1e6)} Mbps` : ''}`;
    }
    captureInfo.textContent = txt;
  }

  video.addEventListener('resize', updateCaptureInfo);
  video.addEventListener('loadedmetadata', updateCaptureInfo);

  function codecLabel(type) {
    if (!type) return 'default';
    if (/hvc1|hev1/i.test(type)) return 'HEVC';
    if (/vp9|vp09/i.test(type)) return 'VP9';
    if (/vp8/i.test(type)) return 'VP8';
    if (/av01/i.test(type)) return 'AV1';
    if (/avc1|mp4/i.test(type)) return 'H.264';
    return type.split(';')[0];
  }

  function applyMirror() {
    video.classList.toggle('mirrored', state.mirror);
    mirrorBtn.setAttribute('aria-pressed', String(state.mirror));
  }

  mirrorBtn.addEventListener('click', () => {
    state.mirror = !state.mirror;   // preview only; the recording is the raw camera stream
    applyMirror();
  });

  // ---------------------------------------------------------------- camera / microphone chooser

  const deviceSheet = $('device-sheet');
  let devices = { video: [], audio: [] };

  function cleanLabel(label, fallback) {
    // e.g. "FaceTime HD Camera (Built-in) (05ac:8514)" → "FaceTime HD Camera (Built-in)"
    return (label || '').replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '').trim() || fallback;
  }

  async function refreshDeviceLists() {
    if (!navigator.mediaDevices.enumerateDevices) return;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      devices = {
        video: all.filter((d) => d.kind === 'videoinput'),
        audio: all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications')
      };
    } catch (e) { /* leave lists as they were */ }
    renderDeviceLists();
  }

  function currentId(kind) {
    const t = state.stream && (kind === 'video' ? state.stream.getVideoTracks()[0] : state.stream.getAudioTracks()[0]);
    return (t && t.getSettings().deviceId) || (kind === 'video' ? state.cameraId : state.micId);
  }

  function renderDeviceLists() {
    [['video', $('camera-list'), 'Camera'], ['audio', $('mic-list'), 'Microphone']].forEach(([kind, list, word]) => {
      list.textContent = '';
      const cur = currentId(kind);
      const items = devices[kind];
      if (!items.length) {
        const p = document.createElement('p');
        p.className = 'slider-label';
        p.textContent = `No ${word.toLowerCase()} found.`;
        list.appendChild(p);
        return;
      }
      items.forEach((d, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'choice';
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(d.deviceId === cur));
        b.textContent = d.deviceId === 'default'
          ? `System default${d.label ? ` (${cleanLabel(d.label.replace(/^Default\s*-\s*/i, ''), '')})` : ''}`
          : cleanLabel(d.label, `${word} ${i + 1}`);
        b.addEventListener('click', () => chooseDevice(kind, d.deviceId));
        list.appendChild(b);
      });
    });
  }

  function chooseDevice(kind, id) {
    if (state.recording || state.countingDown) return;
    if (kind === 'video') { state.cameraId = id; store.set(KEYS.camera, id); }
    else { state.micId = id; store.set(KEYS.mic, id); }
    startCamera(); // called from the tap, so iOS allows it
  }

  function openDeviceSheet() {
    if (state.recording || state.countingDown) return;
    renderDeviceLists();
    refreshDeviceLists();
    deviceSheet.hidden = false;
  }

  function closeDeviceSheet() { deviceSheet.hidden = true; showControls(); }

  flipBtn.addEventListener('click', openDeviceSheet);
  $('sheet-done').addEventListener('click', closeDeviceSheet);
  deviceSheet.addEventListener('click', (e) => { if (e.target === deviceSheet) closeDeviceSheet(); });
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => { if (state.stream) refreshDeviceLists(); });
  }

  function updateCameraButtons() {
    const busy = state.recording || state.countingDown;
    flipBtn.disabled = busy;
    backBtn.disabled = state.recording;
  }

  function showCameraError(err) {
    const name = (err && err.name) || '';
    const where = 'Settings > Safari > Camera and Settings > Safari > Microphone' +
      ' (on iOS 18 and later: Settings > Apps > Safari)';
    if ((name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') && IS_IOS) {
      showCameraMessage('Camera or microphone blocked',
        'Teleprompter needs your camera and microphone to record.\n\n' +
        `To allow them, go to ${where} and choose “Ask” or “Allow”.\n\n` +
        'In Safari you can also tap “aA” in the address bar > Website Settings.\n\n' +
        'Then come back here and tap Try again.', true);
    } else if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
      showCameraMessage('Camera or microphone blocked',
        'Teleprompter needs your camera and microphone to record.\n\n' +
        'Click the camera or padlock icon in the address bar and allow the camera and microphone for this site.\n\n' +
        'On a Mac, also check System Settings > Privacy & Security > Camera and Microphone, and make sure your browser is switched on. ' +
        'On Windows, check Settings > Privacy & security > Camera and Microphone.\n\n' +
        'Then click Try again.', true);
    } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      showCameraMessage('No camera found', 'No camera or microphone could be found on this device.', true);
    } else if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
      showCameraMessage('Camera in use',
        'The camera or microphone is being used by another app (or a phone call). Close it, then tap Try again.', true);
    } else {
      showCameraMessage('Camera unavailable',
        `The camera couldn’t be started${name ? ` (${name})` : ''}. Tap Try again.`, true);
    }
    captureInfo.textContent = 'No camera';
  }

  function showCameraMessage(title, text, canRetry) {
    $('camera-msg-title').textContent = title;
    $('camera-msg-text').textContent = text;
    $('camera-retry').hidden = !canRetry;
    cameraMsg.hidden = false;
    showControls();
  }

  function hideCameraMessage() { cameraMsg.hidden = true; }

  // Retry from a tap, so iOS can prompt for permission again.
  $('camera-retry').addEventListener('click', startCamera);

  // ================================================================ RECORDING

  function pickMimeType() {
    if (!window.MediaRecorder) return null;
    const types = [
      'video/mp4;codecs=avc1,mp4a.40.2',   // H.264 video + AAC audio, stated explicitly
      'video/mp4;codecs=avc1',
      'video/mp4;codecs=avc1,opus',        // Chrome on some laptops
      'video/mp4',
      'video/webm;codecs=vp9,opus',        // e.g. Firefox
      'video/webm'
    ];
    if (typeof MediaRecorder.isTypeSupported !== 'function') return '';
    for (const t of types) if (MediaRecorder.isTypeSupported(t)) return t;
    return '';
  }

  recordBtn.addEventListener('click', () => {
    if (state.recording) stopRecording();
    else if (state.countingDown) cancelCountdown();
    else if (state.countdown) beginCountdown();
    else startRecording();
  });

  function beginCountdown() {
    if (!state.stream) { toast('The camera isn’t ready yet.'); return; }
    let n = 3;
    state.countingDown = true;
    recordBtn.classList.add('is-counting');
    recordBtn.setAttribute('aria-label', 'Cancel countdown');
    updateCameraButtons();
    showNumber(n);
    state.countdownTimer = setInterval(() => {
      n -= 1;
      if (n > 0) {
        showNumber(n);
      } else {
        cancelCountdown();
        startRecording();
      }
    }, 1000);
    hideControls();
  }

  let countdownNumRef = countdownNum;
  function showNumber(n) {
    countdownEl.hidden = false;
    // Replace the node so the CSS pop animation restarts for each number.
    const fresh = countdownNumRef.cloneNode(false);
    fresh.textContent = n;
    countdownNumRef.replaceWith(fresh);
    countdownNumRef = fresh;
  }

  function cancelCountdown() {
    clearInterval(state.countdownTimer);
    state.countdownTimer = 0;
    state.countingDown = false;
    countdownEl.hidden = true;
    countdownNumRef.textContent = '';
    recordBtn.classList.remove('is-counting');
    recordBtn.setAttribute('aria-label', 'Start recording');
    updateCameraButtons();
  }

  // Recording formats to try, best first. If one fails in the first few seconds
  // (some laptops' encoders reject certain settings), the next is used automatically.
  function recorderConfigs(stream) {
    const s = stream.getVideoTracks()[0].getSettings();
    const long = Math.max(video.videoWidth, video.videoHeight, s.width || 0, s.height || 0);
    // Sized so a 20-minute take stays manageable (the whole clip is held in memory
    // until saved): 4K ≈ 2.4 GB, 1080p ≈ 1.8 GB, 720p ≈ 1.2 GB per 20 minutes.
    const vbps = long >= 3000 ? 16000000 : long >= 1900 ? 12000000 : 8000000;
    const supported = (t) => typeof MediaRecorder.isTypeSupported !== 'function' || MediaRecorder.isTypeSupported(t);
    const list = [];
    const add = (cfg) => {
      cfg.key = `${cfg.mimeType || 'default'}|${cfg.videoBitsPerSecond || 0}|${cfg.audioBitsPerSecond || 0}`;
      if (!list.some((c) => c.key === cfg.key)) list.push(cfg);
    };

    const mp4 = pickMimeType();
    // 192 kbps is the highest AAC rate every platform encoder accepts (Windows tops out there).
    if (mp4) {
      add({ mimeType: mp4, videoBitsPerSecond: vbps, audioBitsPerSecond: 192000 });
      add({ mimeType: mp4, videoBitsPerSecond: vbps, audioBitsPerSecond: 128000 });
      add({ mimeType: mp4, videoBitsPerSecond: vbps });   // audio at the encoder's own default
    }
    if (!IS_SAFARI) {
      const webm = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(supported);
      if (webm) add({ mimeType: webm, videoBitsPerSecond: vbps, audioBitsPerSecond: 128000 });
    }
    if (mp4) add({ mimeType: mp4 });
    add({});   // whatever the browser likes

    // Start with the format that worked last time on this device.
    const good = store.get(KEYS.recorder, '');
    const i = list.findIndex((c) => c.key === good);
    if (i > 0) list.unshift(list.splice(i, 1)[0]);
    return list;
  }

  function describeConfig(c) {
    const v = c.videoBitsPerSecond ? `${c.videoBitsPerSecond / 1e6} Mbps` : 'default video rate';
    const a = c.audioBitsPerSecond ? `${c.audioBitsPerSecond / 1000} kbps` : 'default audio rate';
    return `${c.mimeType || 'browser default'} @ ${v}, ${a}`;
  }

  // Creates and starts a recorder from state.recConfigIdx onwards. Returns true on success.
  function launchRecorder() {
    const prevRecorder = state.recorder;
    const prevChunks = state.chunks;
    while (state.recConfigIdx < state.recConfigs.length) {
      const cfg = state.recConfigs[state.recConfigIdx];
      logRec(`try ${describeConfig(cfg)}`);
      let rec;
      try {
        const opts = Object.assign({}, cfg);
        delete opts.key;
        rec = Object.keys(opts).length ? new MediaRecorder(state.stream, opts) : new MediaRecorder(state.stream);
      } catch (e) {
        logRec(`create failed: ${e.name} ${e.message || ''}`);
        state.recConfigIdx++;
        continue;
      }

      rec.addEventListener('dataavailable', (e) => {
        if (state.recorder === rec && e.data && e.data.size) state.chunks.push(e.data);
      });
      rec.addEventListener('stop', () => { logRec('stop event'); onRecorderStop(rec); });
      rec.addEventListener('error', (e) => {
        const err = e.error || {};
        logRec(`error ${err.name || ''} ${err.message || ''}`);
        if (state.recorder === rec && tryNextRecorder('recorder error')) return;
        if (state.recorder === rec) toast(`Recording error: ${err.name || 'unknown'}`, 5000);
      });
      rec.addEventListener('start', () => {
        if (state.recorder !== rec) return;
        logRec(`start event, mimeType ${rec.mimeType || '(none)'}`);
        if (rec.mimeType) state.mimeType = rec.mimeType;
        updateCaptureInfo();
        state.recStartedAt = performance.now();
        setPlaying(true);   // scroll starts as the recording starts
      });

      state.recorder = rec;
      state.chunks = [];
      state.mimeType = rec.mimeType || cfg.mimeType || 'video/mp4';
      try {
        // Safari: one complete MP4, written when stopped. Elsewhere: 1-second pieces, so nothing is lost.
        if (IS_SAFARI) rec.start(); else rec.start(1000);
        state.recConfigStartedAt = performance.now();
        logRec(`started, state ${rec.state}`);
        return true;
      } catch (e) {
        logRec(`start() failed: ${e.name} ${e.message || ''}`);
        state.recorder = prevRecorder;
        state.chunks = prevChunks;
        state.recConfigIdx++;
      }
    }
    return false;
  }

  // A take that fails right at the start: quietly carry on with the next format.
  function tryNextRecorder(reason) {
    if (!state.recording || state.recConfigIdx + 1 >= state.recConfigs.length) return false;
    if (performance.now() - state.recConfigStartedAt > 15000) return false;
    logRec(`${reason}: trying a more compatible format`);
    const old = state.recorder;
    state.recConfigIdx++;
    if (!launchRecorder()) return false;
    try { if (old && old.state !== 'inactive') old.stop(); } catch (e) { /* already stopped */ }
    state.recStartedAt = performance.now();
    recTime.textContent = '0:00';
    toast('Switched to a more compatible recording format. Carry on!');
    return true;
  }

  function startRecording() {
    const stream = state.stream;
    if (!stream || !stream.getVideoTracks().length) {
      toast('The camera isn’t ready yet.');
      return;
    }
    if (!window.MediaRecorder) {
      toast('Recording isn’t supported in this browser. Please update it, or try Safari, Chrome or Edge.', 5000);
      return;
    }

    recLog.length = 0;
    recLogStart = performance.now();
    const ua = navigator.userAgent.match(/(iPhone OS|Mac OS X|Windows NT|CrOS|Chrome|Edg|Firefox|Version)[\/ ][\d_.]+/g);
    logRec(`${ua ? ua.join(', ').replace(/_/g, '.') : 'browser'}${navigator.standalone ? ' (Home Screen)' : ''}`);
    logRec(`stream ${stream.getVideoTracks().length}v ${stream.getAudioTracks().length}a, ${captureInfo.textContent}`);

    state.recConfigs = recorderConfigs(stream);
    state.recConfigIdx = 0;
    state.recording = true;   // set first, so an instant failure can fall back
    if (!launchRecorder()) {
      state.recording = false;
      showCameraMessage('Recording failed',
        'This browser wouldn’t start recording. Please try again, or try another browser. If it keeps happening, take a screenshot of this message.\n\n' +
        recLog.join('\n'), true);
      return;
    }

    state.recStartDate = new Date();
    state.recStartedAt = performance.now();
    recordBtn.classList.add('is-recording');
    recordBtn.setAttribute('aria-label', 'Stop recording');
    recIndicator.hidden = false;
    recTime.textContent = '0:00';
    state.recTimer = setInterval(() => {
      recTime.textContent = formatTime(performance.now() - state.recStartedAt);
    }, 250);
    updateCameraButtons();
    updateCaptureInfo();
    hideControls();
  }

  function endRecordingUI() {
    state.recording = false;
    state.recElapsed = performance.now() - state.recStartedAt;
    clearInterval(state.recTimer);
    setPlaying(false);
    recIndicator.hidden = true;
    recordBtn.classList.remove('is-recording');
    recordBtn.setAttribute('aria-label', 'Start recording');
    updateCameraButtons();
  }

  function stopRecording() {
    const rec = state.recorder;
    if (!state.recording || !rec) return;
    endRecordingUI();
    captureInfo.textContent = 'Finishing…';
    logRec(`stop pressed, state ${rec.state}, ${state.chunks.length} pieces so far`);
    try {
      if (rec.state !== 'inactive') rec.stop();
    } catch (e) { logRec(`stop() failed: ${e.name}`); }
    if (rec.state === 'inactive' && state.recorder !== rec) return;
    // Safari sometimes never fires 'stop'. Don't wait for it for ever: use what we have.
    clearTimeout(state.finishTimer);
    state.finishTimer = setTimeout(() => { logRec('no stop event after 3 s'); onRecorderStop(rec); }, 3000);
  }

  function onRecorderStop(rec) {
    if (!rec || state.recorder !== rec) return;   // already finished, or an old recorder
    // Stopped by itself just after starting: carry on with a more compatible format.
    if (state.recording && tryNextRecorder('recorder stopped by itself')) return;
    clearTimeout(state.finishTimer);
    state.recorder = null;
    if (state.recording) endRecordingUI(); // stopped by the system (e.g. camera interrupted)

    const chunks = state.chunks;
    state.chunks = [];
    if (!chunks.length) {
      updateCaptureInfo();
      showCameraMessage('Recording failed',
        'No video was captured. Please try again. If it keeps happening, take a screenshot of this message.\n\n' +
        recLog.join('\n'), true);
      return;
    }
    const cfg = state.recConfigs && state.recConfigs[state.recConfigIdx];
    if (cfg) store.set(KEYS.recorder, cfg.key);   // remember what works on this device
    const type = (state.mimeType || 'video/mp4').split(';')[0];
    const blob = new Blob(chunks, { type });
    showPreview(blob, type);
  }

  function clipName(date, type) {
    const d = date || new Date();
    const ext = /webm/.test(type) ? 'webm' : 'mp4';
    return `teleprompter-${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}-` +
      `${pad2(d.getHours())}${pad2(d.getMinutes())}.${ext}`;
  }

  // ================================================================ 3. PREVIEW / SAVE

  function showPreview(blob, type) {
    // Release the camera and microphone: saves battery, and stops iOS routing
    // playback to the quiet earpiece while the mic is open.
    stopStream();
    cancelCountdown();
    releaseWakeLock();
    hideCameraMessage();

    const name = clipName(state.recStartDate, type);
    state.clipFile = new File([blob], name, { type, lastModified: Date.now() });
    state.clipUrl = URL.createObjectURL(blob);
    state.saved = false;

    clipVideo.src = `${state.clipUrl}#t=0.1`; // shows the first frame on iOS
    clipVideo.load();

    const mb = blob.size / (1024 * 1024);
    clipInfo.textContent = `${name} · ${formatDuration(state.recElapsed)} · ` +
      `${mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`}`;

    // Phones: share sheet → Save Video. Laptops: a plain download is what you want.
    const canShareFiles = !IS_DESKTOP &&
      !!(navigator.canShare && navigator.share && navigator.canShare({ files: [state.clipFile] }));
    saveBtn.hidden = !canShareFiles;
    downloadLink.href = state.clipUrl;
    downloadLink.download = name;
    downloadLink.hidden = canShareFiles;
    shareStatus.textContent = canShareFiles
      ? 'Tap Save to Photos, then choose “Save Video”.'
      : (IS_DESKTOP ? 'The video will go to your Downloads folder.' : 'Sharing isn’t available here, so download the video instead.');

    showScreen('preview');
  }

  clipVideo.addEventListener('loadedmetadata', () => {
    if (clipVideo.videoWidth) {
      clipInfo.textContent += ` · ${clipVideo.videoWidth}×${clipVideo.videoHeight}`;
    }
    const d = clipVideo.duration;
    if (isFinite(d) && d > 0 && Math.abs(d * 1000 - state.recElapsed) > 3000) {
      logRec(`clip plays ${d.toFixed(1)} s but recorded ${(state.recElapsed / 1000).toFixed(1)} s`);
    }
  }, false);

  saveBtn.addEventListener('click', async () => {
    if (!state.clipFile) return;
    try {
      // Files only — adding a title or text stops iOS offering “Save Video”.
      await navigator.share({ files: [state.clipFile] });
      state.saved = true;
      shareStatus.textContent = 'Done. If you chose “Save Video”, it’s in Photos.';
    } catch (err) {
      if (err && err.name === 'AbortError') {
        shareStatus.textContent = 'Sharing cancelled.';
      } else {
        shareStatus.textContent = 'Couldn’t open sharing. Use Download video instead.';
        downloadLink.hidden = false;
      }
    }
  });

  downloadLink.addEventListener('click', () => { state.saved = true; });

  function clearClip() {
    clipVideo.pause();
    clipVideo.removeAttribute('src');
    clipVideo.load();
    if (state.clipUrl) URL.revokeObjectURL(state.clipUrl);
    state.clipUrl = '';
    state.clipFile = null;
  }

  $('again-btn').addEventListener('click', () => {
    if (!state.saved && !confirm('This clip hasn’t been saved. Record again anyway?')) return;
    clearClip();
    enterRecording(); // camera restarted from this tap
  });

  $('discard-btn').addEventListener('click', () => {
    if (!state.saved && !confirm('Discard this clip? It hasn’t been saved.')) return;
    clearClip();
    showScreen('script');
  });

  // ================================================================ WAKE LOCK & LIFECYCLE

  async function requestWakeLock() {
    if (!('wakeLock' in navigator) || state.wakeLock || document.visibilityState !== 'visible') return;
    try {
      const lock = await navigator.wakeLock.request('screen');
      state.wakeLock = lock;
      lock.addEventListener('release', () => { if (state.wakeLock === lock) state.wakeLock = null; });
    } catch (e) { /* refused — fail quietly */ }
  }

  function releaseWakeLock() {
    const lock = state.wakeLock;
    state.wakeLock = null;
    if (lock) lock.release().catch(() => {});
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      // iOS suspends the camera in the background: finish the clip so it isn't lost.
      // Laptops keep recording happily (Chrome reports "hidden" when the window is
      // merely covered or minimised), so leave those alone.
      if (!IS_IOS) { logRec('page hidden, still recording'); return; }
      if (state.recording) stopRecording();
      cancelCountdown();
      setPlaying(false);
    } else if (state.screen === 'record') {
      logRec('back from background');
      // A clip that was being finished when the app went to the background: show it now.
      if (state.recorder && !state.recording) { onRecorderStop(state.recorder); return; }
      requestWakeLock();
      const live = state.stream && state.stream.getTracks().every((t) => t.readyState === 'live');
      if (state.stream && !live) {
        showCameraMessage('Camera stopped', 'The camera was paused while the app was in the background. Tap below to start it again.', true);
      } else if (state.stream && video.paused) {
        video.play().catch(() => {});
      }
    }
  });

  // ================================================================ LAPTOP: KEYBOARD, MOUSE, FULL SCREEN

  document.addEventListener('keydown', (e) => {
    if (state.screen !== 'record' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!deviceSheet.hidden) { if (e.key === 'Escape') closeDeviceSheet(); return; }
    const onSlider = e.target && e.target.type === 'range';
    let handled = true;
    switch (e.key) {
      case ' ': togglePlay(); break;
      case 'r': case 'R': recordBtn.click(); break;
      case 'ArrowUp': if (onSlider) return; nudgeSpeed(e.shiftKey ? 5 : 1); break;
      case 'ArrowDown': if (onSlider) return; nudgeSpeed(e.shiftKey ? -5 : -1); break;
      case '+': case '=': nudgeSize(2); break;
      case '-': case '_': nudgeSize(-2); break;
      case 'Home': resetScroll(); break;
      default: handled = false;
    }
    if (handled) { e.preventDefault(); showControls(); }
  });

  function nudgeSpeed(d) {
    speedSlider.value = Math.min(100, Math.max(1, state.speedLevel + d));
    speedSlider.dispatchEvent(new Event('input'));
  }

  function nudgeSize(d) {
    sizeSlider.value = Math.min(96, Math.max(24, state.fontSize + d));
    sizeSlider.dispatchEvent(new Event('input'));
  }

  // Moving the mouse shows the controls, like tapping does on a phone.
  stage.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse' && !drag) showControls(); });

  const fullscreenBtn = $('fullscreen-btn');
  const root = document.documentElement;
  if (document.fullscreenEnabled || document.webkitFullscreenEnabled) {
    fullscreenBtn.hidden = false;
    fullscreenBtn.addEventListener('click', () => {
      const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
      if (fsEl) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      else (root.requestFullscreen || root.webkitRequestFullscreen).call(root);
    });
    const fsLabel = () => {
      fullscreenBtn.textContent = (document.fullscreenElement || document.webkitFullscreenElement) ? 'Exit full screen' : 'Full screen';
    };
    document.addEventListener('fullscreenchange', fsLabel);
    document.addEventListener('webkitfullscreenchange', fsLabel);
  }

  // ================================================================ SERVICE WORKER

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => { /* offline support unavailable */ });
    });
  }

  // Initial UI state
  applyFontSize();
  applySpeedLabel();
  updateCountdownBtn();
  showScreen('script');
})();
