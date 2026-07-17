/*
 * Procedural car audio built on the Web Audio API — no sound files.
 *
 * Engine: two detuned oscillators using a custom combustion-pulse waveform
 * (rich harmonics) + a sub-octave square, run through a throttle/rev-driven
 * lowpass and two FIXED formant resonances that give the engine a constant
 * "voice" (they don't slide with pitch). RPM-dependent lumpiness makes idle
 * chuggy and high revs smooth, plus band-limited combustion noise. Each gear
 * has its own frequency band; the pitch climbs through the band as the revs
 * rise. The 5th gear intentionally reuses the 4th-gear band so cruising never
 * becomes excessively high-pitched.
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
  //   4: 162.5-312.5
  //   5: 162.5-312.5 (4速と同じ音域)
  const FREQS = (() => {
    const widths = [55, 80, 110, 150];        // 1速〜4速の音域幅
    let lo = 40;
    const bands = [];
    for (const w of widths) {
      bands.push([lo, lo + w]);
      lo += w / 2;                            // 次のギアは真ん中の音から始まる
    }
    const driveBands = [...bands, [...bands[3]]]; // 5速は4速の音をそのまま使う
    return [bands[0], bands[0], ...driveBands];   // R と N は1速と同じ低い音域
  })();

  let ctx = null;
  let master, engGain, filt, osc1, osc2, oscSub;
  let engNoiseGain, engNoiseFilter, screechGain, bp1, bp2;
  let muted = false;
  let rpmSmooth = 0;
  let roughPhase = 0;
  let revN = 0;              // free-rev state for neutral

  function init() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);

    // ----- engine -----
    engGain = ctx.createGain();
    engGain.gain.value = 0;

    // 燃焼パルス列に近いリッチな倍音の波形(単純なのこぎりより自然な唸り)。
    const N = 30, wr = new Float32Array(N), wi = new Float32Array(N);
    for (let n = 1; n < N; n++) {
      let a = 1 / n;
      if (n > 6) a *= Math.pow(0.82, n - 6);   // 高次倍音はさらに減衰
      if (n % 2 === 1) a *= 1.12;               // 奇数倍音をやや強調(荒々しさ)
      wi[n] = a;
    }
    const engWave = ctx.createPeriodicWave(wr, wi);

    filt = ctx.createBiquadFilter();            // スロットル/回転で開く明るさ制御
    filt.type = 'lowpass';
    filt.frequency.value = 500;
    filt.Q.value = 0.8;

    // 固定フォルマント(回転で動かない共鳴)= エンジン固有の「声色」。
    const formant1 = ctx.createBiquadFilter();
    formant1.type = 'peaking';
    formant1.frequency.value = 480; formant1.Q.value = 1.4; formant1.gain.value = 6;
    const formant2 = ctx.createBiquadFilter();
    formant2.type = 'peaking';
    formant2.frequency.value = 1300; formant2.Q.value = 1.1; formant2.gain.value = 4.5;

    osc1 = ctx.createOscillator();
    osc1.setPeriodicWave(engWave);
    osc2 = ctx.createOscillator();
    osc2.setPeriodicWave(engWave);
    osc2.detune.value = 11;              // slight detune = engine roughness
    oscSub = ctx.createOscillator();
    oscSub.type = 'square';
    const subGain = ctx.createGain();
    subGain.gain.value = 0.4;

    osc1.connect(filt);
    osc2.connect(filt);
    oscSub.connect(subGain);
    subGain.connect(filt);
    filt.connect(formant1);
    formant1.connect(formant2);
    formant2.connect(engGain);
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

    // 4速・5速では燃焼のザラつきとして、この帯域ノイズを強める。
    engNoiseFilter = ctx.createBiquadFilter();
    engNoiseFilter.type = 'bandpass';
    engNoiseFilter.frequency.value = 260;
    engNoiseFilter.Q.value = 0.7;
    engNoiseGain = ctx.createGain();
    engNoiseGain.gain.value = 0;
    noise.connect(engNoiseFilter);
    engNoiseFilter.connect(engNoiseGain);
    engNoiseGain.connect(master);

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

    // 燃焼のムラ(ドコドコ感)は全ギア共通。アイドル(低回転)ほど脈動が強く、
    // 高回転ほど滑らかな唸りになる。エンジンらしさの肝。
    const rough = 0.3 + 0.55 * (1 - rpmSmooth);
    roughPhase += dt * (16 + rpmSmooth * 42);   // 約2.5Hz(アイドル)〜9Hz(高回転)
    const wobble = rough * (
      Math.sin(roughPhase) * 0.012 +
      Math.sin(roughPhase * 0.37 + 0.9) * 0.006
    );
    const roughFreq = freq * (1 + wobble);
    osc1.frequency.setTargetAtTime(roughFreq, t, 0.02);
    osc2.frequency.setTargetAtTime(roughFreq * (1 - wobble * 0.4), t, 0.02);
    oscSub.frequency.setTargetAtTime(roughFreq / 2, t, 0.02);

    // 明るさ(倍音)はスロットルと回転で開く: 踏むと硬く鋭く、離すと丸く。
    const bright = 320 + roughFreq * 4 + rpmSmooth * 900 + (s.throttle ? 1500 : 0);
    filt.frequency.setTargetAtTime(bright, t, 0.04);

    // 音量に脈動(ドコドコ)を乗せる。
    const vol = 0.05 + 0.10 * rpmSmooth + (s.throttle ? 0.05 : 0);
    const pulse = 1 + rough * (Math.sin(roughPhase) * 0.13 + Math.sin(roughPhase * 0.5) * 0.06);
    engGain.gain.setTargetAtTime(Math.max(0, vol * pulse), t, 0.03);

    // 燃焼ノイズ(全ギア。踏むと増え、回転で明るくなる)。
    const engineNoise = 0.006 + rpmSmooth * 0.02 + (s.throttle ? 0.018 : 0.004);
    engNoiseGain.gain.setTargetAtTime(engineNoise, t, 0.035);
    engNoiseFilter.frequency.setTargetAtTime(200 + roughFreq * 2, t, 0.05);

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
