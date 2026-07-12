/*
 * VOX DRIVE — drive a voxel Volvo around a plane scattered with voxel trees,
 * while two AI cars (180SX / VW) cruise on loops.
 *
 *   A: accel  S: brake  Space: handbrake (drift)
 *   Up/Down: shift  Left/Right: steer  Mouse drag: camera
 */
(function () {
  'use strict';

  const BOUND_X_MIN = -290;        // playable area (m); extends east into the forest
  const BOUND_X_MAX = 710;
  const BOUND_Z = 290;
  const VOXEL_SCALE = 0.06;        // 1 voxel = 6 cm -> cars ~4.8 m long
  const TREE_SCALE = 0.08;

  // Cars are modeled along MagicaVoxel Y, which maps onto the three.js Z
  // axis; their nose points to -Z there, matching our forward (+Z at yaw 0)
  // without any extra yaw.
  const MODEL_YAW = 0;
  // Rest the tyres exactly on the ground; the tiny extra sink only closes
  // the light gap at glancing angles (the contact shadow does the rest).
  const CAR_SINK = 0.02;

  // ------------------------------------------------------------- input ----
  const keys = {};
  let shiftUp = false, shiftDown = false;
  window.addEventListener('keydown', (e) => {
    AUDIO.unlock();
    const k = e.key;
    if (k.startsWith('Arrow') || k === ' ') e.preventDefault();
    if (!e.repeat) {
      if (k === 'ArrowUp') shiftUp = true;
      if (k === 'ArrowDown') shiftDown = true;
      if (k.toLowerCase() === 'm') AUDIO.toggle();
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
    tex.repeat.set(150, 88);         // square texels on the 2400x1400 ground
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

  // near=0.5 keeps enough depth precision at 300 m for the thin road layers
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.5, 1200);

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
    new THREE.PlaneGeometry(2400, 1400),
    new THREE.MeshLambertMaterial({ map: makeGroundTexture() })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.x = 250;           // covers the city and the forest suburb
  ground.receiveShadow = true;
  scene.add(ground);

  // ---------------------------------------------------------------- city ---
  // Procedural street grid: vertical/horizontal roads (occasionally one
  // diagonal), Japanese-style white lines, blocks with 2 or 4 buildings.
  //
  // Two road widths:
  //   4-lane (two each way, w=14): solid center line, dashed lane dividers,
  //                                solid edge lines
  //   2-lane (one each way,  w=8): dashed center line, solid edge lines
  const ROAD_LEN = 660;               // roads span the whole map
  const LANE_OFF = 1.75;              // AI keeps to the left lane (Japan)

  // のちに vox の建物を使う場合はここにファイルを追加(モデルの前面 = +Z)。
  // 空の間はプレースホルダーの箱を配置する。
  const BUILDING_VOX = [];

  const obstacles = [];               // {x,z,r} buildings + trees, for collision

  // Batches all flat rectangles of one color into a single mesh.
  function QuadBatch(color) {
    this.pos = [];
    this.idx = [];
    this.color = color;
  }
  QuadBatch.prototype.add = function (cx, cz, w, l, yaw, y) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const base = this.pos.length / 3;
    for (const [x, z] of [[-w / 2, -l / 2], [w / 2, -l / 2], [w / 2, l / 2], [-w / 2, l / 2]]) {
      this.pos.push(cx + x * c + z * s, y, cz - x * s + z * c);
    }
    this.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  };
  QuadBatch.prototype.build = function (receiveShadow) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setIndex(this.idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: this.color }));
    mesh.receiveShadow = !!receiveShadow;
    return mesh;
  };

  const cityRnd = mulberry32(424242);
  function genRoadLine() {
    const arr = [];
    let p = -250 + cityRnd() * 30;
    while (p < 260) {
      const four = cityRnd() < 0.4;
      arr.push({ pos: p, w: four ? 14 : 8, four });
      p += 95 + cityRnd() * 55;
    }
    if (!arr.some((r) => r.four)) { arr[1].four = true; arr[1].w = 14; }
    return arr;
  }
  const V_ROADS = genRoadLine();      // roads running along z, at x = pos
  const H_ROADS = genRoadLine();      // roads running along x, at z = pos
  // たまに斜めの道路(このシードでは1本、45°)
  const DIAGS = [];
  if (cityRnd() < 0.8) {
    DIAGS.push({ cx: -40 + cityRnd() * 80, cz: -40 + cityRnd() * 80, yaw: Math.PI / 4, w: 8, four: false });
  }

  const asphalt = new QuadBatch(0x3d3d42);
  const paint = new QuadBatch(0xe8e8e2);
  const patches = new QuadBatch(0x3d3d42);

  // Lane markings for one road, in the road's local frame (length along z).
  function addMarkings(cx, cz, yaw, road) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const at = (off, w, l, zc) => paint.add(cx + off * c + zc * s, cz - off * s + zc * c, w, l, yaw, 0.06);
    const edge = road.four ? 6.2 : 3.5;
    at(edge, 0.15, ROAD_LEN, 0);      // 外側線(実線)
    at(-edge, 0.15, ROAD_LEN, 0);
    if (road.four) {
      at(0, 0.15, ROAD_LEN, 0);       // 中央線(実線)
      for (let z = -ROAD_LEN / 2; z < ROAD_LEN / 2; z += 8) {  // 車線境界線(破線)
        at(3.1, 0.15, 4, z + 2);
        at(-3.1, 0.15, 4, z + 2);
      }
    } else {
      for (let z = -ROAD_LEN / 2; z < ROAD_LEN / 2; z += 10) { // 中央線(破線)
        at(0, 0.15, 5, z + 2.5);
      }
    }
  }

  for (const r of V_ROADS) {
    asphalt.add(r.pos, 0, r.w, ROAD_LEN, 0, 0.03);
    addMarkings(r.pos, 0, 0, r);
  }
  for (const r of H_ROADS) {
    asphalt.add(0, r.pos, r.w, ROAD_LEN, Math.PI / 2, 0.03);
    addMarkings(0, r.pos, Math.PI / 2, r);
  }
  for (const d of DIAGS) {
    asphalt.add(d.cx, d.cz, d.w, ROAD_LEN * 1.35, d.yaw, 0.03);
    addMarkings(d.cx, d.cz, d.yaw, d);
  }

  // Plain asphalt patches hide the markings inside every intersection.
  for (const v of V_ROADS) {
    for (const h of H_ROADS) {
      patches.add(v.pos, h.pos, v.w, h.w, 0, 0.09);
    }
  }
  for (const d of DIAGS) {
    const dirx = Math.sin(d.yaw), dirz = Math.cos(d.yaw);
    for (const v of V_ROADS) {
      const t = (v.pos - d.cx) / dirx;
      const z = d.cz + t * dirz;
      if (Math.abs(z) < 320) patches.add(v.pos, z, d.w, v.w / Math.abs(dirz) + d.w, d.yaw, 0.095);
    }
    for (const h of H_ROADS) {
      const t = (h.pos - d.cz) / dirz;
      const x = d.cx + t * dirx;
      if (Math.abs(x) < 320) patches.add(x, h.pos, d.w, h.w / Math.abs(dirx) + d.w, d.yaw, 0.095);
    }
  }

  // ----- forest course (suburb, east of the city) -----
  // A meandering 2-lane loop through dense woods, reached by a short
  // connector from the east end of a city road.
  const forestLoop = [];              // closed polyline
  const FOREST_C = { x: 480, z: 0 };
  const FOREST_N = 220;
  for (let i = 0; i < FOREST_N; i++) {
    const th = (i / FOREST_N) * Math.PI * 2;
    const r = 150 + 45 * Math.sin(3 * th) + 25 * Math.sin(7 * th + 1.3);
    forestLoop.push({ x: FOREST_C.x + Math.cos(th) * r, z: FOREST_C.z + Math.sin(th) * r });
  }
  const connector = [];               // straight link: city edge -> loop start
  {
    const a = { x: 322, z: H_ROADS[Math.floor(H_ROADS.length / 2)].pos };
    const b = forestLoop[Math.floor(FOREST_N / 2)];   // west point of the loop
    for (let i = 0; i <= 8; i++) connector.push({ x: a.x + (b.x - a.x) * i / 8, z: a.z + (b.z - a.z) * i / 8 });
  }

  function paveRoute(pts, closed) {
    const n = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      const dx = q.x - p.x, dz = q.z - p.z;
      const len = Math.hypot(dx, dz);
      const yaw = Math.atan2(dx, dz);
      const mx = (p.x + q.x) / 2, mz = (p.z + q.z) / 2;
      const c = Math.cos(yaw), s = Math.sin(yaw);
      asphalt.add(mx, mz, 8, len + 3, yaw, 0.03);
      paint.add(mx + 3.5 * c, mz - 3.5 * s, 0.15, len + 1, yaw, 0.06);   // 外側線
      paint.add(mx - 3.5 * c, mz + 3.5 * s, 0.15, len + 1, yaw, 0.06);
      if (i % 2 === 0) paint.add(mx, mz, 0.15, len, yaw, 0.06);          // 中央線(破線)
    }
  }
  paveRoute(forestLoop, true);
  paveRoute(connector, false);
  patches.add(connector[0].x, connector[0].z, 10, 10, 0, 0.095);          // junction mouths
  patches.add(connector[8].x, connector[8].z, 11, 11, Math.PI / 4, 0.095);

  scene.add(asphalt.build(true));
  scene.add(paint.build(false));
  scene.add(patches.build(true));

  function distToDiag(x, z, d) {
    return Math.abs((x - d.cx) * Math.cos(d.yaw) - (z - d.cz) * Math.sin(d.yaw));
  }
  function onAnyRoad(x, z, margin) {
    for (const r of V_ROADS) if (Math.abs(x - r.pos) < r.w / 2 + margin && Math.abs(z) < ROAD_LEN / 2) return true;
    for (const r of H_ROADS) if (Math.abs(z - r.pos) < r.w / 2 + margin && Math.abs(x) < ROAD_LEN / 2) return true;
    for (const d of DIAGS) if (distToDiag(x, z, d) < d.w / 2 + margin) return true;
    const rr = (4 + margin + 3) * (4 + margin + 3);   // route samples are ~5 m apart
    for (const p of forestLoop) if ((p.x - x) * (p.x - x) + (p.z - z) * (p.z - z) < rr) return true;
    for (const p of connector) if ((p.x - x) * (p.x - x) + (p.z - z) * (p.z - z) < rr) return true;
    return false;
  }

  // ----- blocks: 2 or 4 buildings each, fronts facing the road -----
  const BUILDING_COLORS = [0xb8b0a4, 0x9aa4ad, 0xc4b49a, 0xa8b89e, 0xbfa3a0, 0x93a0b5];
  function placeBuildings(voxMeshes) {
    const boxGeoCache = [];
    for (let i = 0; i + 1 < V_ROADS.length; i++) {
      for (let j = 0; j + 1 < H_ROADS.length; j++) {
        const x1 = V_ROADS[i].pos + V_ROADS[i].w / 2 + 2;
        const x2 = V_ROADS[i + 1].pos - V_ROADS[i + 1].w / 2 - 2;
        const z1 = H_ROADS[j].pos + H_ROADS[j].w / 2 + 2;
        const z2 = H_ROADS[j + 1].pos - H_ROADS[j + 1].w / 2 - 2;
        const bw = x2 - x1, bd = z2 - z1;
        if (bw < 24 || bd < 24) continue;

        const count = cityRnd() < 0.5 ? 2 : 4;
        let sides = [0, 1, 2, 3];                    // +Z, -Z, +X, -X edge of block
        if (count === 2) {
          const first = Math.floor(cityRnd() * 4);
          sides = [first, first ^ 1];                // opposite pair
        }
        for (const side of sides) {
          const w = 8 + cityRnd() * 6;               // frontage
          const d2 = 8 + cityRnd() * 5;              // depth
          const h = 6 + cityRnd() * 12;
          const cx0 = (x1 + x2) / 2, cz0 = (z1 + z2) / 2;
          const jw = (side < 2 ? bw : bd) / 2 - w / 2 - 2;
          const jit = (cityRnd() * 2 - 1) * Math.max(0, jw);
          let x, z, yaw;
          if (side === 0) { x = cx0 + jit; z = z2 - d2 / 2 - 1.5; yaw = 0; }
          else if (side === 1) { x = cx0 + jit; z = z1 + d2 / 2 + 1.5; yaw = Math.PI; }
          else if (side === 2) { x = x2 - d2 / 2 - 1.5; z = cz0 + jit; yaw = Math.PI / 2; }
          else { x = x1 + d2 / 2 + 1.5; z = cz0 + jit; yaw = -Math.PI / 2; }

          let bad = false;
          for (const dg of DIAGS) if (distToDiag(x, z, dg) < dg.w / 2 + (w + d2) / 2) bad = true;
          for (const o of obstacles) {
            const rr = o.r + (w + d2) / 4;
            if ((o.x - x) * (o.x - x) + (o.z - z) * (o.z - z) < rr * rr) bad = true;
          }
          if (bad) continue;

          let mesh;
          // vox の建物があっても箱と混ぜて配置する
          if (voxMeshes && voxMeshes.length && cityRnd() < 0.6) {
            mesh = voxMeshes[Math.floor(cityRnd() * voxMeshes.length)].clone();
          } else {
            const geo = new THREE.BoxGeometry(w, h, d2);
            boxGeoCache.push(geo);
            mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
              color: BUILDING_COLORS[Math.floor(cityRnd() * BUILDING_COLORS.length)],
            }));
            mesh.position.y = h / 2;
            mesh.castShadow = true;
            mesh.receiveShadow = true;
          }
          const holder = new THREE.Group();
          holder.add(mesh);
          holder.position.set(x, 0, z);
          holder.rotation.y = yaw;                   // front (+Z) faces the road
          scene.add(holder);
          obstacles.push({ x, z, r: (w + d2) / 4 });
        }
      }
    }
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
        m.position.set(rx + sx * side, 0.11 + (skidIdx % 8) * 0.0012, rz + sz * side);
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

  const aiCars = []; // { group, tilt, pos, heading, v, base, wps, idx, radius }

  // ------------------------------------------------------------- camera ---
  const cam = { yaw: 0, pitch: 0.34, dist: 10, dragging: false, lastDrag: 0 };
  renderer.domElement.addEventListener('pointerdown', (e) => {
    AUDIO.unlock();
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
    blob.position.y = 0.12;          // above the road surface + markings
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
    // Instancing keeps draw calls low, but one huge InstancedMesh defeats
    // frustum culling — so the forest is split into sectors around the loop.
    const SECTORS = 12;
    const cityLists = meshes.map(() => []);
    const sectorLists = [];
    for (let i = 0; i < SECTORS; i++) sectorLists.push(meshes.map(() => []));

    function tryPlace(lists, x, z, roadMargin, spacing) {
      if (onAnyRoad(x, z, roadMargin)) return false;
      for (const o of obstacles) {
        const rr = o.r + spacing;
        if ((o.x - x) * (o.x - x) + (o.z - z) * (o.z - z) < rr * rr) return false;
      }
      const s = 0.75 + rnd() * 0.6;
      lists[Math.floor(rnd() * meshes.length)].push({ x, z, s, rot: rnd() * Math.PI * 2 });
      obstacles.push({ x, z, r: 0.9 * s });
      return true;
    }

    // sparse trees around the city
    let placed = 0, attempts = 0;
    while (placed < 60 && attempts++ < 6000) {
      const x = -310 + rnd() * 620;
      const z = (rnd() * 2 - 1) * 310;
      if (tryPlace(cityLists, x, z, 3, 4)) placed++;
    }
    // dense woods hugging the forest course
    placed = 0; attempts = 0;
    while (placed < 220 && attempts++ < 20000) {
      const p = forestLoop[Math.floor(rnd() * forestLoop.length)];
      const ang = rnd() * Math.PI * 2;
      const d = 7 + rnd() * 55;
      const x = p.x + Math.cos(ang) * d;
      const z = p.z + Math.sin(ang) * d;
      if (x < 330 || x > BOUND_X_MAX || Math.abs(z) > BOUND_Z) continue;
      const sector = Math.floor(((Math.atan2(z - FOREST_C.z, x - FOREST_C.x) + Math.PI) / (Math.PI * 2)) * SECTORS) % SECTORS;
      if (tryPlace(sectorLists[sector], x, z, 2.5, 2.5)) placed++;
    }

    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    function buildInstanced(mesh, list) {
      if (!list.length) return;
      const inst = new THREE.InstancedMesh(mesh.geometry, mesh.material, list.length);
      list.forEach((p, i) => {
        q.setFromAxisAngle(up, p.rot);
        m4.compose(new THREE.Vector3(p.x, 0, p.z), q, new THREE.Vector3(p.s, p.s, p.s));
        inst.setMatrixAt(i, m4);
      });
      inst.computeBoundingSphere();
      inst.castShadow = true;
      inst.receiveShadow = true;
      scene.add(inst);
    }
    meshes.forEach((mesh, t) => {
      buildInstanced(mesh, cityLists[t]);
      for (const lists of sectorLists) buildInstanced(mesh, lists[t]);
    });
  }

  // Waypoints for a rectangular circuit over the grid, shifted into the
  // left lane of each leg (left-hand traffic).
  function rectLoop(xa, xb, za, zb, cw) {
    const cs = cw
      ? [[xa, za], [xb, za], [xb, zb], [xa, zb]]
      : [[xa, za], [xa, zb], [xb, zb], [xb, za]];
    const wps = [];
    for (let i = 0; i < 4; i++) {
      const p = cs[i], prev = cs[(i + 3) % 4], next = cs[(i + 1) % 4];
      const din = { x: Math.sign(p[0] - prev[0]), z: Math.sign(p[1] - prev[1]) };
      const dout = { x: Math.sign(next[0] - p[0]), z: Math.sign(next[1] - p[1]) };
      const leftIn = { x: din.z, z: -din.x };
      const leftOut = { x: dout.z, z: -dout.x };
      const vLeft = din.x === 0 ? leftIn : leftOut;   // left of the vertical leg
      const hLeft = din.x === 0 ? leftOut : leftIn;   // left of the horizontal leg
      wps.push({ x: p[0] + vLeft.x * LANE_OFF, z: p[1] + hLeft.z * LANE_OFF });
    }
    return wps;
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
    // spawn in the left lane of a central vertical road, heading +Z
    const spawnRoad = V_ROADS[Math.floor(V_ROADS.length / 2)];
    player.pos.set(spawnRoad.pos + LANE_OFF, 0, 30);
    player.heading = 0;

    // waypoints along a sampled route, shifted into the left lane
    function routeWps(pts, step) {
      const wps = [];
      for (let i = 0; i < pts.length; i += step) {
        const p = pts[i], q = pts[(i + step) % pts.length];
        const dx = q.x - p.x, dz = q.z - p.z;
        const l = Math.hypot(dx, dz) || 1;
        wps.push({ x: p.x + (dz / l) * LANE_OFF, z: p.z - (dx / l) * LANE_OFF });
      }
      return wps;
    }

    const vLast = V_ROADS.length - 1, hLast = H_ROADS.length - 1;
    const loops = [
      { wps: rectLoop(V_ROADS[1].pos, V_ROADS[Math.min(2, vLast)].pos, H_ROADS[1].pos, H_ROADS[Math.min(2, hLast)].pos, true), base: 8 },
      { wps: rectLoop(V_ROADS[0].pos, V_ROADS[vLast].pos, H_ROADS[0].pos, H_ROADS[hLast].pos, false), base: 11 },
      { wps: routeWps(forestLoop, 5), base: 12 },
      { wps: rectLoop(V_ROADS[Math.min(2, vLast)].pos, V_ROADS[vLast].pos, H_ROADS[0].pos, H_ROADS[Math.min(2, hLast)].pos, true), base: 9 },
    ];
    const aiMeshes = [nissan, vw, nissan.clone(), vw.clone()];
    loops.forEach((loop, i) => {
      const g = makeCarGroup(aiMeshes[i]);
      const start = loop.wps[0];
      aiCars.push({
        group: g.group, tilt: g.tilt,
        pos: new THREE.Vector3(start.x, 0, start.z),
        heading: 0, v: 0, base: loop.base,
        wps: loop.wps, idx: 1, radius: 1.5,
      });
    });

    const buildingMeshes = BUILDING_VOX.length
      ? await Promise.all(BUILDING_VOX.map((u) => VOX.load(u, { scale: VOXEL_SCALE })))
      : null;
    placeBuildings(buildingMeshes);
    scatterTrees([tree1, tree2], mulberry32(20260711));
    initFx();

    document.getElementById('loading').remove();
    window.__voxDrive = { player, aiCars };   // debug / test hook
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
    if (player.pos.x < BOUND_X_MIN || player.pos.x > BOUND_X_MAX) {
      player.pos.x = clamp(player.pos.x, BOUND_X_MIN, BOUND_X_MAX);
      player.vel.x *= -0.3;
    }
    if (Math.abs(player.pos.z) > BOUND_Z) { player.pos.z = clamp(player.pos.z, -BOUND_Z, BOUND_Z); player.vel.z *= -0.3; }

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
    for (const o of obstacles) collideCircle(o.x, o.z, o.r);
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

    // sound
    AUDIO.update(dt, {
      gear: player.gear,
      rpm: gear.vmax !== 0 ? clamp(Math.abs(vF / gear.vmax), 0, 1) : 0,
      throttle,
      slip: Math.abs(vS),
      drifting: player.drifting,
      brakeSkid: brake && Math.abs(vF) > 6,
      speed: Math.abs(vF),
    });

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
      const wp = ai.wps[ai.idx];
      const dx = wp.x - ai.pos.x, dz = wp.z - ai.pos.z;
      if (dx * dx + dz * dz < 6 * 6) ai.idx = (ai.idx + 1) % ai.wps.length;

      let diff = Math.atan2(dx, dz) - ai.heading;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      ai.heading += clamp(diff, -1.7 * dt, 1.7 * dt);

      // slow down for corners
      const target = ai.base * (1 - 0.72 * Math.min(1, Math.abs(diff) * 1.4));
      ai.v += (target - ai.v) * Math.min(1, dt * 1.6);
      ai.pos.x += Math.sin(ai.heading) * ai.v * dt;
      ai.pos.z += Math.cos(ai.heading) * ai.v * dt;

      ai.group.position.copy(ai.pos);
      ai.group.rotation.y = ai.heading;
      ai.tilt.rotation.z = clamp(-diff * ai.v * 0.006, -0.04, 0.04);
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
