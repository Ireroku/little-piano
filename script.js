(() => {
  'use strict';

  const firstNote = 60;
  const noteNames = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  const keyCodes = [
    'KeyZ', 'KeyS', 'KeyX', 'KeyD', 'KeyC', 'KeyV', 'KeyG', 'KeyB', 'KeyH', 'KeyN', 'KeyJ', 'KeyM',
    'KeyQ', 'Digit2', 'KeyW', 'Digit3', 'KeyE', 'KeyR', 'Digit5', 'KeyT', 'Digit6', 'KeyY', 'Digit7', 'KeyU',
    'KeyI',
  ];
  const noteByCode = new Map(keyCodes.map((code, index) => [code, firstNote + index]));
  const keyboard = document.getElementById('keyboard');
  const playToggle = document.getElementById('play-toggle');

  // 表示
  function labelKey(button, index, label) {
    const note = noteNames[index % 12] + (4 + Math.floor(index / 12));
    button.firstElementChild.textContent = label;
    button.setAttribute('aria-label', `${note}、${label} キー`);
  }

  let whiteKeys = 0;
  const keys = keyCodes.map((code, index) => {
    const name = noteNames[index % 12];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'piano-key';
    button.dataset.note = firstNote + index;
    const face = document.createElement('span');
    face.className = 'piano-key-face';
    button.append(face);
    labelKey(button, index, code.replace(/^(Key|Digit)/, ''));
    if (name.length === 2) {
      button.classList.add('piano-key--black');
      button.style.setProperty('--boundary', whiteKeys);
    } else {
      whiteKeys += 1;
    }
    return button;
  });
  keyboard.append(...keys);

  async function updateKeyLabels() {
    try {
      const layout = await navigator.keyboard?.getLayoutMap?.();
      if (!layout) return;
      keys.forEach((button, index) => {
        const label = layout.get(keyCodes[index]);
        if (label) labelKey(button, index, /^[a-z]$/.test(label) ? label.toUpperCase() : label);
      });
      const labels = keys.map((button) => button.firstElementChild.textContent);
      document.querySelector('.key-guide').textContent =
        `PC のキーボードでは ${labels[0]}〜${labels[11]} が C4〜B4、${labels[12]}〜${labels[24]} が C5〜C6 です（黒鍵はひとつ上の段）。`;
    } catch {
      // キーボード配列を取得できない場合は既定の表示を使う。
    }
  }
  void updateKeyLabels();

  const manualNotes = new Map();
  let playback = null;

  function drawKeys() {
    const litNotes = new Set(playback?.litNotes);
    for (const { note } of manualNotes.values()) litNotes.add(note);
    keys.forEach((key, index) => {
      key.classList.toggle('is-active', litNotes.has(firstNote + index));
    });
  }

  // 音源
  const voiceLimit = 24;
  const releaseTime = 0.46;
  const releaseDecay = releaseTime / 5;
  const voices = new Set();
  const partials = [
    [1, .78, 1.08],
    [2.002, .29, .57],
    [3.009, .15, .30],
    [4.018, .072, .18],
    [5.031, .043, .12],
    [6.049, .020, .085],
  ];
  const buses = new Map();
  let audio;
  let master;
  let roomImpulse;
  let hammerNoise;

  function makeNoise(seconds, channels, decay) {
    const length = Math.ceil(audio.sampleRate * seconds);
    const buffer = audio.createBuffer(channels, length, audio.sampleRate);
    for (let channel = 0; channel < channels; channel += 1) {
      const samples = buffer.getChannelData(channel);
      for (let i = 0; i < length; i += 1) {
        samples[i] = (Math.random() * 2 - 1) * (1 - i / length) ** decay;
      }
    }
    return buffer;
  }

  function activateAudio() {
    if (!audio) {
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (!Audio) return;
      audio = new Audio();
      master = audio.createDynamicsCompressor();
      master.threshold.value = -14;
      master.knee.value = 14;
      master.ratio.value = 5;
      master.attack.value = .003;
      master.release.value = .18;
      master.connect(audio.destination);
      roomImpulse = makeNoise(.72, 2, 3);
      hammerNoise = makeNoise(.028, 1, 2);
    }
    if (audio.state !== 'running') return audio.resume();
  }

  function getBus(group) {
    if (buses.has(group)) return buses.get(group);
    const input = audio.createGain();
    const output = audio.createGain();
    const room = audio.createConvolver();
    const wet = audio.createGain();
    room.buffer = roomImpulse;
    wet.gain.value = .16;
    input.connect(output);
    input.connect(room).connect(wet).connect(output);
    output.connect(master);
    const bus = { input, output, room, wet };
    buses.set(group, bus);
    return bus;
  }

  function addPartial(voice, frequency, [ratio, level, decay], brightness) {
    const { start, filter, sources, nodes } = voice;
    const osc = audio.createOscillator();
    const envelope = audio.createGain();
    osc.type = 'sine';
    osc.frequency.value = frequency * ratio;
    envelope.gain.setValueAtTime(0, start);
    envelope.gain.linearRampToValueAtTime(level * brightness, start + .008);
    envelope.gain.setTargetAtTime(0, start + .008, decay);
    osc.connect(envelope).connect(filter);
    sources.push(osc);
    nodes.push(osc, envelope);
  }

  function addHammer(voice, velocity) {
    const noise = audio.createBufferSource();
    const lowpass = audio.createBiquadFilter();
    const level = audio.createGain();
    noise.buffer = hammerNoise;
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 620 + 680 * velocity;
    level.gain.value = .07 + .11 * velocity;
    noise.connect(lowpass).connect(level).connect(voice.filter);
    voice.sources.push(noise);
    voice.nodes.push(noise, lowpass, level);
  }

  function disposeVoice(voice) {
    if (!voices.delete(voice)) return;
    voice.sources[0].onended = null;
    for (const node of voice.nodes) node.disconnect();
  }

  function stopSources(voice, time) {
    for (const source of voice.sources) source.stop(time);
  }

  function startVoice(note, velocity, group, start) {
    const active = [...voices].filter((voice) => !voice.stopping);
    if (active.length >= voiceLimit) {
      const now = audio.currentTime;
      const victim = active.find((voice) => voice.releasedAt <= now) ?? active[0];
      const gate = victim.gate.gain;
      const release = Math.max(victim.releasedAt, victim.start + .032);
      const level = Math.exp(-Math.max(0, now - release) / releaseDecay);
      gate.cancelScheduledValues(now);
      gate.setValueAtTime(level, now);
      gate.linearRampToValueAtTime(0, now + .005);
      victim.stopping = true;
      victim.end = Math.min(victim.end, now + .005);
      stopSources(victim, victim.end);
    }

    const frequency = 440 * 2 ** ((note - 69) / 12);
    const filter = audio.createBiquadFilter();
    const gain = audio.createGain();
    const gate = audio.createGain();
    filter.type = 'lowpass';
    filter.frequency.value = 1560 + 4300 * velocity ** 1.6;
    filter.Q.value = .4;
    gain.gain.value = .28 * velocity ** 1.55;
    filter.connect(gain).connect(gate).connect(getBus(group).input);

    const voice = {
      group, start, filter, gate, sources: [], nodes: [filter, gain, gate],
      end: start + 5, releasedAt: Infinity, stopping: false,
    };
    // 強い音ほど高次の倍音を増やし、低域は丸い響きに保つ。
    partials.forEach((partial, index) => {
      const brightness = index === 0 ? 1 : (.54 + .57 * velocity) ** index;
      addPartial(voice, frequency, partial, brightness);
    });
    addHammer(voice, velocity);
    voice.sources[0].onended = () => disposeVoice(voice);
    for (const source of voice.sources) source.start(start);
    stopSources(voice, voice.end);
    voices.add(voice);
    return voice;
  }

  function releaseVoice(voice, time) {
    if (!voices.has(voice) || voice.stopping) return;
    const release = Math.max(time, voice.start + .032);
    if (release >= voice.end) return;
    voice.releasedAt = time;
    voice.gate.gain.setTargetAtTime(0, release, releaseDecay);
    voice.end = Math.min(voice.end, release + releaseTime);
    stopSources(voice, voice.end);
  }

  function disconnectBus(bus) {
    for (const node of Object.values(bus)) node.disconnect();
  }

  function silence(group) {
    const bus = buses.get(group);
    if (!bus) return;
    buses.delete(group);

    const now = audio.currentTime;
    const running = audio.state === 'running';
    const end = running ? now + .015 : now;
    const stopping = [...voices].filter((voice) => voice.group === group);
    for (const voice of stopping) {
      voice.stopping = true;
      voice.end = Math.min(end, voice.end);
      stopSources(voice, voice.end);
    }
    const dispose = () => {
      disconnectBus(bus);
      for (const voice of stopping) disposeVoice(voice);
    };
    if (running) {
      // 残響も含めて短くフェードさせる。
      bus.output.gain.setValueAtTime(1, now);
      bus.output.gain.linearRampToValueAtTime(0, end);
      setTimeout(dispose, 50);
    } else {
      dispose();
    }
  }

  // ベロシティ
  const clampVelocity = (velocity) => Math.min(1, Math.max(0, velocity));
  const lastStrike = new Map();
  let playingVariation = 0;

  function manualVelocity(note) {
    // 前のゆらぎを引き継ぎながら、少しずつ中心に戻す。
    playingVariation = .78 * playingVariation + (Math.random() - .5) * .095;
    const now = performance.now();
    const interval = now - (lastStrike.get(note) ?? -Infinity);
    lastStrike.set(note, now);
    const repeat = .06 * Math.max(0, 1 - interval / 260);
    const register = (note - 69) / 12;
    return clampVelocity(.70 - .15 * register ** 2 + playingVariation - repeat);
  }

  const beatSeconds = 60 / 94;
  const bars = [
    [60, [[76, 1], [79, .5], [81, .5], [79, 1]], 64],
    [67, [[74, 1], [79, .5], [77, .5], [74, 1]], 71],
    [69, [[76, 1], [81, .5], [83, .5], [81, 1]], 72],
    [67, [[79, 1], [77, .5], [74, .5], [null, 1]], 71],

    [65, [[77, 1], [76, .5], [77, .5], [81, 1]], 69],
    [62, [[77, .75], [76, .25], [74, 1], [77, 1]], 69],
    [67, [[79, 1], [83, .5], [79, .5], [71, 1]], 77],
    [60, [[72, 2.5], [null, .5]], 67],

    [69, [[76, .5], [79, .5], [81, 1], [79, .5], [76, .5]], 72],
    [64, [[79, 1.5], [76, .5], [71, 1]], 67],
    [65, [[72, .5], [77, .5], [84, 1], [79, .5], [77, .5]], 69],
    [64, [[76, 1.5], [74, .5], [80, 1]], 68],

    [62, [[81, 1], [77, .5], [76, .5], [74, 1]], 65],
    [69, [[76, 1], [72, .5], [76, .5], [81, 1]], 72],
    [65, [[84, 1], [81, .5], [79, .5], [77, 1]], 69],
    [67, [[79, 1.5], [74, .5], [null, 1]], 71],

    [60, [[76, 1], [79, .5], [81, .5], [79, 1]], 64],
    [67, [[74, 1], [79, .5], [77, .5], [74, 1]], 71],
    [69, [[76, .5], [79, .5], [81, 1], [84, 1]], 72],
    [67, [[83, 1], [79, .5], [77, .5], [74, 1]], 71],

    [65, [[77, 1], [76, .5], [77, .5], [81, 1]], 69],
    [62, [[77, .75], [76, .25], [74, 1], [77, 1]], 69],
    [67, [[79, 1], [83, .5], [79, .5], [71, 1]], 77],
    [60, [[72, 3]], 64],
  ];
  const phraseBeats = 12;
  const phrasePeaks = [7.5, 7, 7, 6, 8, 7];
  const phraseLevels = [.74, .86, .97, 1.08, 1.22, .80];

  function phraseVelocity(note, beat, part) {
    const phrase = Math.floor(beat / phraseBeats);
    const position = beat % phraseBeats;
    const peak = phrasePeaks[phrase];
    // フレーズの高音が集まるあたりに向けて強め、終止に向けて弱める。
    const rise = Math.min(position / peak, (phraseBeats - position) / (phraseBeats - peak));
    const contour = .64 + .64 * rise - .18 * (position / phraseBeats) ** 3;
    const downbeat = beat % 3 === 0 ? .055 : 0;
    const highNote = part === 'melody' ? Math.max(0, note - 76) * .012 : 0;
    const partLevel = { melody: .59, bass: .43, chord: .29 };
    const ending = beat >= 69 ? .78 - (beat - 69) * .07 : 1;
    return clampVelocity((partLevel[part] * contour + downbeat + highNote) * phraseLevels[phrase] * ending);
  }

  // 自動演奏
  function buildScore() {
    const score = [];
    function add(note, beat, length, part) {
      if (note === null) return;
      score.push({
        note,
        start: beat * beatSeconds,
        length: length * beatSeconds,
        velocity: phraseVelocity(note, beat, part),
      });
    }

    bars.forEach(([bass, melody, chord], index) => {
      const downbeat = index * 3;
      add(bass, downbeat, 1.05, 'bass');
      add(chord, downbeat + 1, .47, 'chord');
      if (index < bars.length - 1) add(chord, downbeat + 2, .39, 'chord');
      let beat = downbeat;
      for (const [note, length] of melody) {
        add(note, beat, length * .91, 'melody');
        beat += length;
      }
    });
    return score.sort((a, b) => a.start - b.start);
  }

  const score = buildScore();
  const songLength = bars.length * 3 * beatSeconds + .65;

  function schedule(run) {
    if (playback !== run) return;
    const now = audio.currentTime;
    const horizon = now + .3;
    while (run.next < score.length && run.start + score[run.next].start <= horizon) {
      const event = score[run.next++];
      const start = run.start + event.start;
      const end = start + event.length;
      if (end <= now) continue;
      const voice = startVoice(event.note, event.velocity, run, Math.max(start, now));
      releaseVoice(voice, end);
      run.scheduled.push({ note: event.note, start, end });
    }
  }

  function audibleTime() {
    // 出力のタイムスタンプが取れる場合は、スピーカーに届く時刻に合わせる。
    const stamp = audio.getOutputTimestamp?.();
    if (stamp?.performanceTime > 0) {
      const time = stamp.contextTime + (performance.now() - stamp.performanceTime) / 1000;
      return Math.min(time, audio.currentTime);
    }
    return audio.currentTime;
  }

  function followScore(run) {
    if (playback !== run) return;
    const now = audibleTime();
    if (now >= run.start + songLength) {
      stopPlayback(true);
      return;
    }
    run.scheduled = run.scheduled.filter((event) => now < event.end);
    run.litNotes = run.scheduled.filter((event) => now >= event.start).map((event) => event.note);
    drawKeys();
    run.frame = requestAnimationFrame(() => followScore(run));
  }

  async function startPlayback() {
    const run = { next: 0, scheduled: [], litNotes: [] };
    playback = run;
    playToggle.textContent = '止める';
    let resumeTimer;
    try {
      await Promise.race([
        activateAudio(),
        new Promise((resolve) => { resumeTimer = setTimeout(resolve, 1500); }),
      ]);
    } catch {
      if (playback === run) stopPlayback();
      return;
    } finally {
      clearTimeout(resumeTimer);
    }
    if (playback !== run) return;
    if (audio?.state !== 'running') {
      stopPlayback();
      return;
    }
    run.start = audio.currentTime + .065;
    schedule(run);
    run.timer = setInterval(() => schedule(run), 25);
    run.frame = requestAnimationFrame(() => followScore(run));
  }

  function stopPlayback(finished = false) {
    const run = playback;
    if (!run) return;
    clearInterval(run.timer);
    cancelAnimationFrame(run.frame);
    playback = null;
    playToggle.textContent = '曲を流す';
    drawKeys();
    if (finished) {
      const tailEnd = audio.currentTime + 1;
      function disposeTail() {
        const bus = buses.get(run);
        if (!bus) return;
        const remaining = tailEnd - audio.currentTime;
        if (remaining > 0 && audio.state === 'running') {
          setTimeout(disposeTail, Math.max(50, remaining * 1000));
          return;
        }
        buses.delete(run);
        disconnectBus(bus);
      }
      setTimeout(disposeTail, 1000);
    } else {
      silence(run);
    }
  }

  playToggle.addEventListener('click', () => {
    if (playback) stopPlayback();
    else void startPlayback();
  });

  // 入力
  // 画面を離れたら増やし、音声の再開待ちだった打鍵を後から鳴らさない。
  let generation = 0;

  async function startManual(source, note) {
    const held = { note, voice: null, tapped: false, pressedAt: performance.now(), generation };
    manualNotes.set(source, held);
    drawKeys();

    const velocity = manualVelocity(note);
    try {
      const resume = activateAudio();
      if (resume) await resume;
    } catch {
      return;
    }
    if (audio?.state !== 'running' || held.generation !== generation) return;
    if (manualNotes.get(source) === held) {
      held.voice = startVoice(note, velocity, 'manual', audio.currentTime);
    } else if (held.tapped && performance.now() - held.pressedAt < 600) {
      // 指を離した時点で音声が許可された場合も、最初の一打を短く鳴らす。
      const voice = startVoice(note, velocity, 'manual', audio.currentTime);
      releaseVoice(voice, audio.currentTime + .16);
    }
  }

  function stopManual(source) {
    const held = manualNotes.get(source);
    if (!held) return;
    if (held.voice) releaseVoice(held.voice, audio.currentTime);
    manualNotes.delete(source);
    drawKeys();
  }

  function noteAt(element) {
    return element?.closest('.piano-key')?.dataset.note;
  }

  const pointers = new Map();
  keyboard.addEventListener('pointerdown', (event) => {
    const note = noteAt(event.target);
    if (event.button !== 0 || note === undefined) return;
    keyboard.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, note);
    startManual(event.pointerId, Number(note));
  });

  keyboard.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return;
    if (event.pointerType === 'mouse' && (event.buttons & 1) === 0) {
      endPointer(event);
      if (keyboard.hasPointerCapture(event.pointerId)) keyboard.releasePointerCapture(event.pointerId);
      return;
    }
    const note = noteAt(document.elementFromPoint(event.clientX, event.clientY));
    if (pointers.get(event.pointerId) === note) return;
    stopManual(event.pointerId);
    if (note !== undefined) startManual(event.pointerId, Number(note));
    pointers.set(event.pointerId, note);
  });

  function endPointer(event) {
    if (pointers.delete(event.pointerId)) stopManual(event.pointerId);
  }

  keyboard.addEventListener('pointerup', (event) => {
    // タッチでは指を離した時点で音声再生が許可されることがある。
    if (pointers.has(event.pointerId) && audio && audio.state !== 'running') {
      const held = manualNotes.get(event.pointerId);
      if (held) held.tapped = true;
      void activateAudio()?.catch(() => {});
    }
    endPointer(event);
  });
  keyboard.addEventListener('pointercancel', endPointer);
  keyboard.addEventListener('lostpointercapture', endPointer);

  // ボタンをキーボードや支援技術で起動した場合も、短く音を鳴らす。
  keyboard.addEventListener('click', (event) => {
    const note = noteAt(event.target);
    if (event.detail !== 0 || note === undefined) return;
    const source = Symbol();
    startManual(source, Number(note));
    setTimeout(() => stopManual(source), 180);
  });

  const metaCleared = new Set();
  window.addEventListener('keydown', (event) => {
    const note = noteByCode.get(event.code);
    if (note === undefined || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    if (manualNotes.has(event.code)) return;
    // Command を離したときに止めた鍵は、押し続けていればキーリピートで戻す。
    if (!event.repeat || metaCleared.delete(event.code)) startManual(event.code, note);
  });

  window.addEventListener('keyup', (event) => {
    const held = manualNotes.get(event.code);
    if (held && !held.voice) held.tapped = true;
    stopManual(event.code);
    metaCleared.delete(event.code);
    // macOS では Command を押している間、ほかのキーの keyup が届かないことがある。
    if (event.key === 'Meta') {
      for (const code of noteByCode.keys()) {
        if (manualNotes.has(code)) metaCleared.add(code);
        stopManual(code);
      }
    }
  });

  function stopEverything() {
    generation += 1;
    stopPlayback();
    for (const group of buses.keys()) silence(group);
    manualNotes.clear();
    metaCleared.clear();
    for (const id of pointers.keys()) {
      if (keyboard.hasPointerCapture(id)) keyboard.releasePointerCapture(id);
    }
    pointers.clear();
    drawKeys();
  }

  window.addEventListener('blur', stopEverything);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopEverything();
  });
})();
