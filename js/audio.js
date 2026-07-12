/*
 * Procedural car audio built on the Web Audio API — no sound files.
 *
 * Engine: two detuned sawtooth oscillators + a sub-octave square through a
 * lowpass filter. Each gear has its own frequency band; the pitch climbs
 * through the band as the revs rise, and every higher gear's band sits
 * above the previous one (1st is intentionally very low).
 *
 * Tyre screech: looped white noise through two parallel bandpass filters
 * with an LFO wobble — used both for drifting and for hard braking.
 */
function audioModule() {
  // [min Hz, max Hz] per gear index: R, N, 1, 2, 3, 4, 5.
  // 回転数を上げると音階が上がり、ギアを上げると音域ごと上がる。
  // 隣接ギアは「前のギアの真ん中の回転域の音階 = 次のギアの低い回転域の音階」
  // となるよう連鎖させる (fLow[n+1] = fMid[n])。
  //   1: 40-95  (かなり低く)   mid 67.5
  //   2: 67.5-147.5            mid 107.5
  //   3: 107.5-217.5           mid 162.5
  //   4: 162.5-312.5           mid 237.5
  //   5: 237.5-437.5
  const FREQS = (() => {
    const widths = [55, 80, 110, 150, 200];   // 1速〜5速の音域幅
    let lo = 40;
    const bands = [];
    for (const w of widths) {
      bands.push([lo, lo + w]);
      lo += w / 2;                            // 次のギアは真ん中の音から始まる
    }
    return [bands[0], bands[0], ...bands];    // R と N は1速と同じ低い音域
  })();

  let ctx = null;
  let master, engGain, filt, osc1, osc2, oscSub, screechGain, bp1, bp2;
  let muted = false;
  let rpmSmooth = 0;
  let revN = 0;              // free-rev state for neutral

  function init() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);

    // ----- engine -----
    engGain = ctx.createGain();
    engGain.gain.value = 0;
    filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 400;
    filt.Q.value = 1.5;

    osc1 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    osc2 = ctx.createOscillator();
    osc2.type = 'sawtooth';
    osc2.detune.value = 16;              // slight detune = engine roughness
    oscSub = ctx.createOscillator();
    oscSub.type = 'square';
    const subGain = ctx.createGain();
    subGain.gain.value = 0.45;

    osc1.connect(filt);
    osc2.connect(filt);
    oscSub.connect(subGain);
    subGain.connect(filt);
    filt.connect(engGain);
    engGain.connect(master);
    osc1.start(); osc2.start(); oscSub.start();

    // ----- tyre screech -----
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;

    bp1 = ctx.createBiquadFilter();
    bp1.type = 'bandpass';
    bp1.frequency.value = 800;
    bp1.Q.value = 6;
    bp2 = ctx.createBiquadFilter();
    bp2.type = 'bandpass';
    bp2.frequency.value = 1500;
    bp2.Q.value = 9;
    screechGain = ctx.createGain();
    screechGain.gain.value = 0;

    noise.connect(bp1);
    noise.connect(bp2);
    bp1.connect(screechGain);
    bp2.connect(screechGain);
    screechGain.connect(master);
    noise.start();

    // wobble so the screech "sings" instead of hissing statically
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 9;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 70;
    lfo.connect(lfoGain);
    lfoGain.connect(bp1.frequency);
    lfo.start();
  }

  // Browsers block audio until a user gesture — call this from input handlers.
  function unlock() {
    if (!ctx) {
      try { init(); } catch (e) { console.warn('WebAudio unavailable:', e); return; }
    }
    if (ctx.state === 'suspended') ctx.resume();
  }

  function toggle() {
    muted = !muted;
    if (ctx) master.gain.setTargetAtTime(muted ? 0 : 0.9, ctx.currentTime, 0.03);
    return !muted;
  }

  /*
   * s: { gear, rpm (0..1 within the gear), throttle, slip (|lateral m/s|),
   *      drifting, brakeSkid, speed (|forward m/s|) }
   */
  function update(dt, s) {
    if (!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    const f = FREQS[s.gear] || FREQS[2];

    let rpm;
    if (s.gear === 1) {
      // neutral: nothing drives the wheels, so rev with the pedal
      revN += ((s.throttle ? 1 : 0) - revN) * Math.min(1, dt * (s.throttle ? 1.8 : 2.6));
      rpm = revN;
    } else {
      rpm = Math.min(1, s.rpm + (s.throttle ? 0.06 : 0));
    }
    rpmSmooth += (rpm - rpmSmooth) * Math.min(1, dt * 4);

    const freq = f[0] + (f[1] - f[0]) * rpmSmooth;
    osc1.frequency.setTargetAtTime(freq, t, 0.04);
    osc2.frequency.setTargetAtTime(freq, t, 0.04);
    oscSub.frequency.setTargetAtTime(freq / 2, t, 0.04);
    filt.frequency.setTargetAtTime(250 + freq * 3.5, t, 0.05);

    const vol = 0.05 + 0.09 * rpmSmooth + (s.throttle ? 0.05 : 0);
    engGain.gain.setTargetAtTime(vol, t, 0.08);

    // screech: whichever is stronger — drifting or locked-up braking
    const drift = s.drifting ? Math.min(1, Math.max(0, s.slip - 1.5) / 5) : 0;
    const brake = s.brakeSkid ? Math.min(1, s.speed / 22) : 0;
    screechGain.gain.setTargetAtTime(Math.max(drift, brake) * 0.4, t, 0.06);
    bp1.frequency.setTargetAtTime(700 + s.slip * 25 + (brake > drift ? 150 : 0), t, 0.1);
  }

  return {
    unlock, toggle, update,
    bands: FREQS,
    _debug() {
      return ctx ? {
        state: ctx.state,
        freq: osc1.frequency.value,
        engVol: engGain.gain.value,
        screech: screechGain.gain.value,
      } : null;
    },
  };
}

export const AUDIO = audioModule();
