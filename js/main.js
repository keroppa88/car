/*
 * VOX DRIVE — drive a voxel Volvo around a plane scattered with voxel trees,
 * while two AI cars (180SX / VW) cruise on loops.
 *
 *   A: accel  S: brake  Space: handbrake (drift)
 *   Up/Down: shift  Left/Right: steer  Mouse drag: camera
 */
(function () {
  'use strict';

  const WORLD_BOUND = 290;         // playable half-size (m)
  const VOXEL_SCALE = 0.06;        // 1 voxel = 6 cm -> cars ~4.8 m long
  const TREE_SCALE = 0.08;

  // Cars are modeled along MagicaVoxel Y, which maps onto the three.js Z
  // axis; their nose points to -Z there, matching our forward (+Z at yaw 0)
  // without any extra yaw.
  const MODEL_YAW = 0;
  // The wheels only touch the ground with a few voxels (they are rounded),
  // which reads as "hovering" — sink the cars a little into the grass.
  const CAR_SINK = 0.14;

  // ------------------------------------------------------------- input ----
  const keys = {};
  let shiftUp = false, shiftDown = false;
  window.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k.startsWith('Arrow') || k === ' ') e.preventDefault();
    if (!e.repeat) {
      if (k === 'ArrowUp') shiftUp = true;
      if (k === 'ArrowDown') shiftDown = true;
    }
    keys[k.toLowerCase()] = true;
  });
  window.addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; });

  // ------------------------------------------------------------ helpers ---
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  // Deterministic PRNG so trees land in the same place every run.
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeGroundTexture() {
    const size = 256;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#79a054';
    ctx.fillRect(0, 0, size, size);
    const img = ctx.getImageData(0, 0, size, size);
    const rnd = mulberry32(1234);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (rnd() - 0.5) * 26;
      img.data[i] += n;
      img.data[i + 1] += n;
      img.data[i + 2] += n * 0.7;
    }
    ctx.putImageData(img, 0, 0);
    // sparse darker grass tufts
    ctx.fillStyle = 'rgba(60,90,40,0.5)';
    for (let i = 0; i < 350; i++) {
      ctx.fillRect(Math.floor(rnd() * size), Math.floor(rnd() * size), 2, 2);
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(90, 90);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  // ------------------------------------------------------------- scene ----
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const SKY = 0x8ecbef;
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(SKY, 130, 480);

  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1200);

  const hemi = new THREE.HemisphereLight(0xdff3ff, 0x5a7a45, 0.95);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff3d8, 1.15);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -55;
  sun.shadow.camera.right = 55;
  sun.shadow.camera.top = 55;
  sun.shadow.camera.bottom = -55;
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 220;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.05;
  scene.add(sun);
  scene.add(sun.target);
  const SUN_DIR = new THREE.Vector3(28, 90, 18).normalize();

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(1400, 1400),
    new THREE.MeshLambertMaterial({ map: makeGroundTexture() })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Dirt rings marking the AI cruise loops.
  const AI_LOOPS = [
    { r: 45, dir: 1, speed: 8.5 },
    { r: 75, dir: -1, speed: 11.5 },
  ];
  for (const loop of AI_LOOPS) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(loop.r - 2.4, loop.r + 2.4, 96),
      new THREE.MeshLambertMaterial({ color: 0x96795a })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    ring.receiveShadow = true;
    scene.add(ring);
  }

  // --------------------------------------------------------------- HUD ----
  const speedEl = document.getElementById('speed');
  const rpmEl = document.getElementById('rpm-fill');
  const gearEls = Array.from(document.querySelectorAll('#gears span'));
  const driftEl = document.getElementById('drift');

  // ------------------------------------------------------- tyre effects ---
  const SKID_MAX = 460;
  const SMOKE_MAX = 70;
  const skidPool = [];
  const smokePool = [];
  let skidIdx = 0, smokeIdx = 0, smokeTimer = 0;
  const lastSkid = { x: 1e9, z: 1e9 };

  function makeSmokeTexture() {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const ctx = cv.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 4, 32, 32, 30);
    g.addColorStop(0, 'rgba(235,235,230,0.85)');
    g.addColorStop(1, 'rgba(235,235,230,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(cv);
  }

  function initFx() {
    const skidGeo = new THREE.PlaneGeometry(0.3, 0.68);
    for (let i = 0; i < SKID_MAX; i++) {
      const m = new THREE.Mesh(skidGeo, new THREE.MeshBasicMaterial({ color: 0x181410, transparent: true, opacity: 0, depthWrite: false }));
      m.rotation.order = 'YXZ';
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      scene.add(m);
      skidPool.push(m);
    }
    const tex = makeSmokeTexture();
    for (let i = 0; i < SMOKE_MAX; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false }));
      s.visible = false;
      s.userData = { life: 0, max: 1, vx: 0, vy: 0, vz: 0 };
      scene.add(s);
      smokePool.push(s);
    }
  }

  function emitTyreFx(fx, fz, sx, sz, dt) {
    const rx = player.pos.x - fx * 1.5;   // rear axle
    const rz = player.pos.z - fz * 1.5;

    // skid marks: one pair every ~0.5 m of travel
    const dsx = rx - lastSkid.x, dsz = rz - lastSkid.z;
    if (dsx * dsx + dsz * dsz > 0.5 * 0.5) {
      lastSkid.x = rx; lastSkid.z = rz;
      for (const side of [-0.75, 0.75]) {
        const m = skidPool[skidIdx];
        skidIdx = (skidIdx + 1) % SKID_MAX;
        m.position.set(rx + sx * side, 0.025 + (skidIdx % 8) * 0.0012, rz + sz * side);
        m.rotation.y = player.heading;
        m.material.opacity = 0.5;
        m.visible = true;
      }
    }

    // smoke: a puff every ~35 ms
    smokeTimer += dt;
    while (smokeTimer > 0.035) {
      smokeTimer -= 0.035;
      const s = smokePool[smokeIdx];
      smokeIdx = (smokeIdx + 1) % SMOKE_MAX;
      const side = Math.random() < 0.5 ? -0.75 : 0.75;
      s.position.set(rx + sx * side + (Math.random() - 0.5) * 0.3, 0.25, rz + sz * side + (Math.random() - 0.5) * 0.3);
      s.scale.setScalar(0.6);
      const d = s.userData;
      d.life = 0; d.max = 0.7 + Math.random() * 0.4;
      d.vx = (Math.random() - 0.5) * 1.2; d.vy = 1.0 + Math.random(); d.vz = (Math.random() - 0.5) * 1.2;
      s.visible = true;
    }
  }

  function updateFx(dt) {
    for (const m of skidPool) {
      if (!m.visible) continue;
      m.material.opacity -= dt * 0.075;
      if (m.material.opacity <= 0) m.visible = false;
    }
    for (const s of smokePool) {
      if (!s.visible) continue;
      const d = s.userData;
      d.life += dt;
      if (d.life >= d.max) { s.visible = false; continue; }
      s.position.x += d.vx * dt;
      s.position.y += d.vy * dt;
      s.position.z += d.vz * dt;
      s.scale.addScalar(dt * 1.7);
      s.material.opacity = 0.4 * (1 - d.life / d.max);
    }
  }

  // ------------------------------------------------------------- player ---
  const GEARS = [
    { name: 'R', vmax: -8.3, acc: 4.5 },   // ~30 km/h reverse
    { name: 'N', vmax: 0, acc: 0 },
    { name: '1', vmax: 6.9, acc: 8.5 },   // 25 km/h
    { name: '2', vmax: 12.5, acc: 6.4 },   // 45
    { name: '3', vmax: 19.4, acc: 5.0 },   // 70
    { name: '4', vmax: 26.4, acc: 3.8 },   // 95
    { name: '5', vmax: 33.4, acc: 2.8 },   // 120
  ];

  const player = {
    group: null,     // yaw
    tilt: null,      // roll / pitch (visual only)
    pos: new THREE.Vector3(0, 0, 0),
    vel: new THREE.Vector3(0, 0, 0),
    heading: 0,
    steer: 0,
    gear: 2,         // start in 1st
    radius: 1.5,
    accSmooth: 0,
    drifting: false,
  };

  const aiCars = []; // { group, loop, theta, radius }
  const trees = [];  // { x, z, r }

  // ------------------------------------------------------------- camera ---
  const cam = { yaw: 0, pitch: 0.34, dist: 10, dragging: false, lastDrag: 0 };
  renderer.domElement.addEventListener('pointerdown', (e) => {
    cam.dragging = true;
    renderer.domElement.setPointerCapture(e.pointerId);
  });
  window.addEventListener('pointerup', () => { cam.dragging = false; cam.lastDrag = performance.now(); });
  window.addEventListener('pointermove', (e) => {
    if (!cam.dragging) return;
    cam.yaw -= e.movementX * 0.005;
    cam.pitch = clamp(cam.pitch + e.movementY * 0.004, 0.08, 1.25);
    cam.lastDrag = performance.now();
  });
  window.addEventListener('wheel', (e) => {
    cam.dist = clamp(cam.dist * (1 + e.deltaY * 0.001), 5.5, 28);
  }, { passive: true });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // --------------------------------------------------------------- init ---
  // Soft contact shadow that sits directly under a car at all times —
  // the directional shadow alone lands beside the body when the sun is low.
  let blobTex = null;
  function makeBlobShadow() {
    if (!blobTex) {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 128;
      const ctx = cv.getContext('2d');
      const g = ctx.createRadialGradient(64, 64, 8, 64, 64, 62);
      g.addColorStop(0, 'rgba(0,0,0,0.55)');
      g.addColorStop(0.65, 'rgba(0,0,0,0.38)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 128, 128);
      blobTex = new THREE.CanvasTexture(cv);
    }
    const blob = new THREE.Mesh(
      new THREE.PlaneGeometry(3.1, 5.9),
      new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false })
    );
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 0.015;
    return blob;
  }

  function makeCarGroup(mesh) {
    const tilt = new THREE.Group();
    mesh.rotation.y = MODEL_YAW;
    mesh.position.y = -CAR_SINK;
    tilt.add(mesh);
    const group = new THREE.Group();
    group.add(tilt);
    group.add(makeBlobShadow());
    scene.add(group);
    return { group, tilt };
  }

  function scatterTrees(meshes, rnd) {
    const COUNT = 90;
    let attempts = 0;
    while (trees.length < COUNT && attempts++ < 4000) {
      const x = (rnd() * 2 - 1) * (WORLD_BOUND + 30);
      const z = (rnd() * 2 - 1) * (WORLD_BOUND + 30);
      const d = Math.hypot(x, z);
      if (d < 16) continue;                                  // spawn area
      let onLoop = false;
      for (const loop of AI_LOOPS) {
        if (Math.abs(d - loop.r) < 7) { onLoop = true; break; }
      }
      if (onLoop) continue;
      let near = false;
      for (const t of trees) {
        if ((t.x - x) * (t.x - x) + (t.z - z) * (t.z - z) < 12 * 12) { near = true; break; }
      }
      if (near) continue;

      const src = meshes[Math.floor(rnd() * meshes.length)];
      const tree = src.clone();
      const s = 0.75 + rnd() * 0.6;
      tree.scale.setScalar(s);
      tree.position.set(x, 0, z);
      tree.rotation.y = rnd() * Math.PI * 2;
      scene.add(tree);
      trees.push({ x, z, r: 0.9 * s });
    }
  }

  async function init() {
    const [volvo, nissan, vw, tree1, tree2] = await Promise.all([
      VOX.load('vox/volvo.vox', { scale: VOXEL_SCALE }),
      VOX.load('vox/nissan180sx2.vox', { scale: VOXEL_SCALE }),
      VOX.load('vox/vw01.vox', { scale: VOXEL_SCALE }),
      VOX.load('vox/tree01.vox', { scale: TREE_SCALE }),
      VOX.load('vox/tree02.vox', { scale: TREE_SCALE }),
    ]);

    const p = makeCarGroup(volvo);
    player.group = p.group;
    player.tilt = p.tilt;
    player.heading = Math.PI / 2;    // face +X down between the loops

    const aiMeshes = [nissan, vw];
    AI_LOOPS.forEach((loop, i) => {
      const g = makeCarGroup(aiMeshes[i]);
      aiCars.push({ group: g.group, tilt: g.tilt, loop, theta: Math.PI * (0.4 + i), radius: 1.5 });
    });

    scatterTrees([tree1, tree2], mulberry32(20260711));
    initFx();

    document.getElementById('loading').remove();
    window.__voxDrive = { player };   // debug / test hook
    requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------- update ---
  function updatePlayer(dt) {
    // gears
    if (shiftUp) { player.gear = Math.min(player.gear + 1, GEARS.length - 1); shiftUp = false; }
    if (shiftDown) { player.gear = Math.max(player.gear - 1, 0); shiftDown = false; }
    const gear = GEARS[player.gear];

    const throttle = !!keys['a'];
    const brake = !!keys['s'];
    const handbrake = !!keys[' '];

    // steering (less lock at speed, extra lock while sliding for counter-steer)
    const speedAlong = player.vel.x * Math.sin(player.heading) + player.vel.z * Math.cos(player.heading);
    const input = (keys['arrowleft'] ? 1 : 0) - (keys['arrowright'] ? 1 : 0);
    const lock = 0.55 / (1 + Math.abs(speedAlong) * (player.drifting ? 0.02 : 0.055));
    player.steer += (input * lock - player.steer) * Math.min(1, dt * 7);
    if (Math.abs(speedAlong) > 0.05) {
      const yawGain = player.drifting ? 1.6 : 1.0;
      player.heading += (speedAlong / 2.8) * Math.tan(player.steer) * yawGain * dt;
    }

    // decompose momentum against the (new) heading: the mismatch is wheel slip
    const fx = Math.sin(player.heading), fz = Math.cos(player.heading);
    const sx = -fz, sz = fx;
    let vF = player.vel.x * fx + player.vel.z * fz;   // along the car
    let vS = player.vel.x * sx + player.vel.z * sz;   // sideways slip
    const vBefore = vF;

    // drift state: handbrake at speed kicks the tail out, momentum keeps it out
    player.drifting = (handbrake && Math.abs(vF) > 4) || (player.drifting && Math.abs(vS) > 1.4);

    if (throttle && gear.acc > 0) {
      // torque tapers off as the gear approaches its top speed
      const t = vF / gear.vmax;                       // >0 when moving with the gear
      const factor = clamp(1 - Math.max(t, 0), 0, 1);
      vF += Math.sign(gear.vmax) * gear.acc * factor * dt;
    }
    if (brake) {
      const dec = 11 * dt;
      vF -= clamp(vF, -dec, dec);
    }
    if (handbrake) {
      const dec = 6 * dt;                             // locked rear wheels scrub speed
      vF -= clamp(vF, -dec, dec);
    }
    // rolling resistance + aero drag + engine braking when off throttle
    const drag = 0.25 + Math.abs(vF) * 0.012 + (throttle ? 0 : 0.9);
    vF -= clamp(vF, -drag * dt, drag * dt);
    // over-rev after a downshift: engine drags the car toward the gear's max
    if (gear.acc > 0 && Math.abs(vF) > Math.abs(gear.vmax) && Math.sign(vF) === Math.sign(gear.vmax)) {
      vF += (gear.vmax - vF) * Math.min(1, dt * 1.2);
    }

    // lateral tyre grip: strong normally, nearly gone while drifting
    vS *= Math.exp(-(player.drifting ? 1.1 : 7.0) * dt);
    vS -= clamp(vS, -2 * dt, 2 * dt);

    player.vel.set(fx * vF + sx * vS, 0, fz * vF + sz * vS);
    player.pos.x += player.vel.x * dt;
    player.pos.z += player.vel.z * dt;

    // world bounds
    if (Math.abs(player.pos.x) > WORLD_BOUND) { player.pos.x = clamp(player.pos.x, -WORLD_BOUND, WORLD_BOUND); player.vel.x *= -0.3; }
    if (Math.abs(player.pos.z) > WORLD_BOUND) { player.pos.z = clamp(player.pos.z, -WORLD_BOUND, WORLD_BOUND); player.vel.z *= -0.3; }

    // collisions: push out of the obstacle and reflect the velocity off it
    function collideCircle(cx, cz, r) {
      const dx = player.pos.x - cx, dz = player.pos.z - cz;
      const min = player.radius + r;
      const d2 = dx * dx + dz * dz;
      if (d2 >= min * min || d2 < 1e-6) return;
      const d = Math.sqrt(d2);
      const nx = dx / d, nz = dz / d;
      player.pos.x = cx + nx * min;
      player.pos.z = cz + nz * min;
      const dot = player.vel.x * nx + player.vel.z * nz;
      if (dot < 0) {
        player.vel.x -= 1.6 * dot * nx;
        player.vel.z -= 1.6 * dot * nz;
        player.vel.multiplyScalar(0.5);
      }
    }
    for (const t of trees) collideCircle(t.x, t.z, t.r);
    for (const ai of aiCars) collideCircle(ai.group.position.x, ai.group.position.z, ai.radius);

    // visuals
    player.group.position.copy(player.pos);
    player.group.rotation.y = player.heading;
    const acc = (vF - vBefore) / Math.max(dt, 1e-4);
    player.accSmooth += (acc - player.accSmooth) * Math.min(1, dt * 5);
    player.tilt.rotation.z = clamp(-player.steer * vF * 0.010 - vS * 0.008, -0.09, 0.09);
    player.tilt.rotation.x = clamp(player.accSmooth * 0.006, -0.05, 0.05);

    // tyre effects while sliding
    if (player.drifting && Math.abs(vS) > 1.6) {
      emitTyreFx(fx, fz, sx, sz, dt);
    }

    // HUD
    speedEl.textContent = Math.round(player.vel.length() * 3.6);
    gearEls.forEach((el, i) => el.classList.toggle('on', i === player.gear));
    driftEl.classList.toggle('on', player.drifting);
    let rpm = 0.12;
    if (player.gear !== 1) rpm = clamp(Math.abs(vF / gear.vmax), 0, 1);
    if (keys['a'] && player.gear !== 1) rpm = Math.max(rpm, 0.3);
    rpmEl.style.width = (rpm * 100).toFixed(1) + '%';
    rpmEl.classList.toggle('red', rpm > 0.93);
  }

  function updateAI(dt) {
    for (const ai of aiCars) {
      ai.theta += (ai.loop.speed / ai.loop.r) * ai.loop.dir * dt;
      const x = Math.cos(ai.theta) * ai.loop.r;
      const z = Math.sin(ai.theta) * ai.loop.r;
      // velocity direction = d(pos)/dtheta * dir
      const vx = -Math.sin(ai.theta) * ai.loop.dir;
      const vz = Math.cos(ai.theta) * ai.loop.dir;
      ai.group.position.set(x, 0, z);
      ai.group.rotation.y = Math.atan2(vx, vz);
      ai.tilt.rotation.z = 0.02 * ai.loop.dir;
    }
  }

  function updateCamera(dt) {
    // ease back behind the car when the mouse is idle
    if (!cam.dragging && performance.now() - cam.lastDrag > 1800) {
      cam.yaw += (0 - cam.yaw) * Math.min(1, dt * 1.2);
    }
    const target = new THREE.Vector3(player.pos.x, player.pos.y + 1.4, player.pos.z);
    const a = player.heading + Math.PI + cam.yaw;
    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    camera.position.set(
      target.x + Math.sin(a) * cp * cam.dist,
      Math.max(0.7, target.y + sp * cam.dist),
      target.z + Math.cos(a) * cp * cam.dist
    );
    camera.lookAt(target);

    // keep the shadow camera centered on the player
    sun.position.copy(player.pos).addScaledVector(SUN_DIR, 120);
    sun.target.position.copy(player.pos);
  }

  // --------------------------------------------------------------- loop ---
  let last = performance.now();
  function tick(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    updatePlayer(dt);
    updateAI(dt);
    updateFx(dt);
    updateCamera(dt);
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }

  init().catch((err) => {
    const el = document.getElementById('loading');
    if (el) {
      el.innerHTML = '<div class="err">読み込みに失敗しました。<br>ローカルサーバー経由で開いてください:<br><code>python3 -m http.server</code> → <code>http://localhost:8000</code><br><small>' + err.message + '</small></div>';
    }
    console.error(err);
  });
})();
