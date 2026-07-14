/*
 * VOX DRIVE — drive a voxel Toyota 86 around a plane scattered with voxel trees,
 * while AI cars discovered from the vox folder cruise on loops.
 *
 *   A: brake  S: accel  Space: handbrake (drift)
 *   Up/Down: shift  Left/Right: steer  Mouse drag: camera
 */
import * as THREE from 'three';
import { GLTFLoader } from '../lib/GLTFLoader.js';
import { mergeGeometries } from '../lib/BufferGeometryUtils.js';
import { VOX } from './vox.js';
import { AUDIO } from './audio.js';

(function () {
  'use strict';

  // マップ選択: デフォルトは自動生成の街 + 森 + 峠。
  //   ?map=nihonbashi.gltf … 日本橋マップを読む
  //   ?map=maps/sample.glb … 別の glTF/GLB マップを読む
  //   ?map=city            … デフォルトと同じ自動生成マップ
  const mapParam = new URLSearchParams(location.search).get('map');
  const MAP_GLTF = mapParam === null || ['', 'city', 'procedural', 'none', '0'].includes(mapParam)
    ? ''
    : mapParam;
  let mapRoot = null;              // set when a custom map is loaded (ground raycasts)

  let BOUND_X_MIN = -290;          // playable area (m); extends east into the forest
  let BOUND_X_MAX = 710;
  let BOUND_Z = 290;
  const VOXEL_SCALE = 0.06;        // 1 voxel = 6 cm -> cars ~4.8 m long
  const TREE_SCALE = 0.08;

  // Cars are modeled along MagicaVoxel Y, which maps onto the three.js Z
  // axis; their nose points to -Z there, matching our forward (+Z at yaw 0)
  // without any extra yaw.
  const MODEL_YAW = 0;
  // Rest the tyres exactly on the ground; the tiny extra sink only closes
  // the light gap at glancing angles (the contact shadow does the rest).
  const CAR_SINK = 0.02;

  // デモ画面の状態。読み込み後はまずデモ(自動運転のドリフト回遊)になり、
  // ユーザーが何か操作するとゲーム開始。
  let demoActive = false;
  let startGame = function () {};   // init 内で本体を差し込む
  let gameSpawn = null;             // デモ解除時に戻る通常スポーン {x,z,heading}

  // ------------------------------------------------------------- input ----
  const keys = {};
  let shiftUp = false, shiftDown = false;
  window.addEventListener('keydown', (e) => {
    AUDIO.unlock();
    if (demoActive) { startGame(); return; }   // 何かキーでゲーム開始
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

  // 分割数を持たせ、あとでドリフトコースの丘だけ頂点を持ち上げる(街の坂道)。
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(2400, 1400, 240, 140),
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
  const CITY_EDGE = ROAD_LEN / 2;      // outer ring joins every formerly dead-ended road
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
  // 起伏に沿った矩形: 各コーナーの高さを hFn(worldX, worldZ)+lift で決める。
  QuadBatch.prototype.addSloped = function (cx, cz, w, l, yaw, hFn, lift) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const base = this.pos.length / 3;
    for (const [x, z] of [[-w / 2, -l / 2], [w / 2, -l / 2], [w / 2, l / 2], [-w / 2, l / 2]]) {
      const wx = cx + x * c + z * s, wz = cz - x * s + z * c;
      this.pos.push(wx, hFn(wx, wz) + lift, wz);
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

  // Clip diagonal roads at the outer ring so their two ends also join the circuit.
  for (const d of DIAGS) {
    const dirx = Math.sin(d.yaw), dirz = Math.cos(d.yaw);
    const hits = [];
    for (const x of [-CITY_EDGE, CITY_EDGE]) {
      const t = (x - d.cx) / dirx, z = d.cz + t * dirz;
      if (Math.abs(z) <= CITY_EDGE + 0.01) hits.push(t);
    }
    for (const z of [-CITY_EDGE, CITY_EDGE]) {
      const t = (z - d.cz) / dirz, x = d.cx + t * dirx;
      if (Math.abs(x) <= CITY_EDGE + 0.01) hits.push(t);
    }
    hits.sort((a, b) => a - b);
    d.t0 = hits[0];
    d.t1 = hits[hits.length - 1];
  }

  const asphalt = new QuadBatch(0x3d3d42);
  const paint = new QuadBatch(0xe8e8e2);
  const patches = new QuadBatch(0x3d3d42);
  const driftShoulder = new QuadBatch(0x34363a);
  const PERIMETER_ROAD = { w: 8, four: false };

  // Lane markings for one road, in the road's local frame (length along z).
  function addMarkings(cx, cz, yaw, road, roadLength = ROAD_LEN) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const at = (off, w, l, zc) => paint.add(cx + off * c + zc * s, cz - off * s + zc * c, w, l, yaw, 0.06);
    const edge = road.four ? 6.2 : 3.5;
    at(edge, 0.15, roadLength, 0);      // 外側線(実線)
    at(-edge, 0.15, roadLength, 0);
    if (road.four) {
      at(0, 0.15, roadLength, 0);       // 中央線(実線)
      for (let z = -roadLength / 2; z < roadLength / 2; z += 8) {  // 車線境界線(破線)
        at(3.1, 0.15, 4, z + 2);
        at(-3.1, 0.15, 4, z + 2);
      }
    } else {
      for (let z = -roadLength / 2; z < roadLength / 2; z += 10) { // 中央線(破線)
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
    const midT = (d.t0 + d.t1) / 2, len = d.t1 - d.t0;
    const mx = d.cx + Math.sin(d.yaw) * midT;
    const mz = d.cz + Math.cos(d.yaw) * midT;
    asphalt.add(mx, mz, d.w, len, d.yaw, 0.03);
    addMarkings(mx, mz, d.yaw, d, len);
  }

  // Continuous outer ring: every grid-road endpoint now meets this circuit.
  for (const z of [-CITY_EDGE, CITY_EDGE]) {
    asphalt.add(0, z, PERIMETER_ROAD.w, ROAD_LEN + PERIMETER_ROAD.w, Math.PI / 2, 0.03);
    addMarkings(0, z, Math.PI / 2, PERIMETER_ROAD, ROAD_LEN + PERIMETER_ROAD.w);
  }
  for (const x of [-CITY_EDGE, CITY_EDGE]) {
    asphalt.add(x, 0, PERIMETER_ROAD.w, ROAD_LEN + PERIMETER_ROAD.w, 0, 0.03);
    addMarkings(x, 0, 0, PERIMETER_ROAD, ROAD_LEN + PERIMETER_ROAD.w);
  }

  // Plain asphalt patches hide the markings inside every intersection.
  const signals = [];                 // signalized grid intersections
  for (const v of V_ROADS) {
    for (const h of H_ROADS) {
      patches.add(v.pos, h.pos, v.w, h.w, 0, 0.09);
      signals.push({ x: v.pos, z: h.pos, vw: v.w, hw: h.w });
    }
  }
  // Join both ends of every vertical/horizontal road to the outer ring.
  for (const v of V_ROADS) {
    for (const z of [-CITY_EDGE, CITY_EDGE]) {
      patches.add(v.pos, z, v.w, PERIMETER_ROAD.w, 0, 0.09);
      signals.push({ x: v.pos, z, vw: v.w, hw: PERIMETER_ROAD.w });
    }
  }
  for (const h of H_ROADS) {
    for (const x of [-CITY_EDGE, CITY_EDGE]) {
      patches.add(x, h.pos, PERIMETER_ROAD.w, h.w, 0, 0.09);
      signals.push({ x, z: h.pos, vw: PERIMETER_ROAD.w, hw: h.w });
    }
  }
  for (const x of [-CITY_EDGE, CITY_EDGE]) {
    for (const z of [-CITY_EDGE, CITY_EDGE]) {
      patches.add(x, z, 10, 10, 0, 0.095);
      signals.push({ x, z, vw: PERIMETER_ROAD.w, hw: PERIMETER_ROAD.w });
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
    for (const t of [d.t0, d.t1]) {
      patches.add(d.cx + dirx * t, d.cz + dirz * t, 12, 12, d.yaw, 0.095);
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
    // Multiple harmonics create frequent linked bends without self-intersection.
    const r = 150
      + 34 * Math.sin(3 * th)
      + 24 * Math.sin(7 * th + 1.3)
      + 14 * Math.sin(13 * th + 0.45);
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

  // ----- drift course (街の南): 短い直線とヘアピンが連続する峠コース -----
  // 左右2ブロックの密な蛇行レイアウト。約80mごとに180°ターンが来る。
  const DRIFT_C = { x: -30, z: 460 };
  const DRIFT_TOP_Z = 372;
  const driftConnectorCandidates = V_ROADS.map((r) => r.pos)
    .filter((px) => px >= DRIFT_C.x - 150 && px <= DRIFT_C.x + 120);
  const DRIFT_CONNECTOR_X = driftConnectorCandidates.length
    ? driftConnectorCandidates.reduce((a, b) => (Math.abs(b - DRIFT_C.x) < Math.abs(a - DRIFT_C.x) ? b : a))
    : DRIFT_C.x;

  function driftLoop() {
    const pts = [];
    const R = 12, rows = 8, gap = 2 * R;
    const zTop = DRIFT_TOP_Z, zBottom = zTop + (rows - 1) * gap;
    const leftOuter = -150, leftInner = -70;
    const rightInner = 10, rightOuter = 90;
    const arc = (ccx, ccz, a0, a1, steps = 8) => {
      for (let i = 1; i <= steps; i++) {
        const a = a0 + (a1 - a0) * (i / steps);
        pts.push({ x: ccx + Math.cos(a) * R, z: ccz + Math.sin(a) * R });
      }
    };

    // 左ブロック: 内側上端から連続Uターンで登る。
    pts.push({ x: leftInner, z: zTop });
    for (let r = 0; r < rows; r++) {
      const z = zTop + r * gap;
      const towardOuter = r % 2 === 0;
      pts.push({ x: towardOuter ? leftOuter : leftInner, z });
      if (r < rows - 1) {
        if (towardOuter) arc(leftOuter, z + R, -Math.PI / 2, -Math.PI * 3 / 2);
        else arc(leftInner, z + R, -Math.PI / 2, Math.PI / 2);
      }
    }

    // 頂上の短い連絡区間で右ブロックへ渡る。
    pts.push({ x: rightInner, z: zBottom });

    // 右ブロック: 頂上から連続Uターンで下る。
    for (let r = 0; r < rows; r++) {
      const z = zBottom - r * gap;
      const towardOuter = r % 2 === 0;
      pts.push({ x: towardOuter ? rightOuter : rightInner, z });
      if (r < rows - 1) {
        if (towardOuter) arc(rightOuter, z - R, Math.PI / 2, -Math.PI / 2);
        else arc(rightInner, z - R, Math.PI / 2, Math.PI * 3 / 2);
      }
    }
    return pts;
  }
  const driftLoopPts = driftLoop();

  // 前半は標高24mまで登り、後半は同じ距離を下る峠型プロフィール。
  const DRIFT_PEAK_HEIGHT = 24;
  const driftProfile = (() => {
    const cumulative = [0];
    let total = 0;
    for (let i = 0; i < driftLoopPts.length; i++) {
      const p = driftLoopPts[i], q = driftLoopPts[(i + 1) % driftLoopPts.length];
      total += Math.hypot(q.x - p.x, q.z - p.z);
      cumulative.push(total);
    }
    return { cumulative, total };
  })();

  // 道路に近い区間の標高を合成して、道路と周囲の地表を同じ峠形状にする。
  // sample を渡した場合は、地表の路盤処理用に道路までの距離も返す。
  function courseHeightAt(x, z, sample) {
    if (sample) sample.roadDistance = Infinity;
    if (z <= 350 || z >= 620 || x <= -280 || x >= 215) return 0;
    let closestD2 = Infinity, weightedHeight = 0, weightSum = 0;
    for (let i = 0; i < driftLoopPts.length; i++) {
      const p = driftLoopPts[i], q = driftLoopPts[(i + 1) % driftLoopPts.length];
      const dx = q.x - p.x, dz = q.z - p.z;
      const len2 = dx * dx + dz * dz;
      const t = len2 > 0 ? clamp(((x - p.x) * dx + (z - p.z) * dz) / len2, 0, 1) : 0;
      const px = p.x + dx * t, pz = p.z + dz * t;
      const d2 = (x - px) ** 2 + (z - pz) ** 2;
      const progress = (driftProfile.cumulative[i] + Math.sqrt(len2) * t) / driftProfile.total;
      const height = DRIFT_PEAK_HEIGHT * Math.sin(Math.PI * progress);
      const weight = 1 / Math.pow(d2 + 9, 2);
      weightedHeight += height * weight;
      weightSum += weight;
      if (d2 < closestD2) closestD2 = d2;
    }
    if (sample) {
      const connectorZ = clamp(z, 330, DRIFT_TOP_Z);
      const connectorD2 = (x - DRIFT_CONNECTOR_X) ** 2 + (z - connectorZ) ** 2;
      sample.roadDistance = Math.sqrt(Math.min(closestD2, connectorD2));
    }
    const distance = Math.sqrt(closestD2);
    const edgeT = clamp((distance - 10) / 100, 0, 1);
    const terrainFade = 1 - edgeT * edgeT * (3 - 2 * edgeT);
    const northT = clamp((z - 350) / (DRIFT_TOP_Z - 350), 0, 1);
    const northGate = northT * northT * (3 - 2 * northT);
    const southT = clamp((620 - z) / 80, 0, 1);
    const southGate = southT * southT * (3 - 2 * southT);
    const xGate = clamp(Math.min((x + 280) / 55, (215 - x) / 55), 0, 1);
    return (weightedHeight / weightSum) * terrainFade * northGate * southGate * xGate;
  }

  // 峠の起伏に沿っ…8681 tokens truncated…const info = await loadGltfMap(MAP_GLTF);
      // 開始位置は「道路の上」: 中心付近を放射状にレイキャストして、
      // 一番よく出てくる高さ(=道路・地表)の中で中心に近い地点を選ぶ。
      // ビルの屋上は高さがバラバラなので最頻値には選ばれない。
      function findRoadSpawn() {
        const samples = [];
        for (let r = 0; r <= 260; r += 12) {
          const n = Math.max(1, Math.round(r / 7));
          for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 2;
            const x = Math.cos(a) * r, z = Math.sin(a) * r;
            samples.push({ x, z, y: groundHeightAt(x, 500, z), r });
          }
        }
        const counts = new Map();
        for (const s of samples) {
          const b = Math.round(s.y / 2);
          counts.set(b, (counts.get(b) || 0) + 1);
        }
        let mode = 0, best = -1;
        for (const [b, n] of counts) if (n > best) { best = n; mode = b; }
        const road = samples
          .filter((s) => Math.abs(s.y - mode * 2) <= 1.5)
          .sort((a, b) => a.r - b.r)[0];
        return road || { x: 0, z: 0, y: groundHeightAt(0, 500, 0) };
      }

      if (info.spawn) {
        const sp = info.spawn.getWorldPosition(new THREE.Vector3());
        const f = new THREE.Vector3(0, 0, 1).applyQuaternion(info.spawn.getWorldQuaternion(new THREE.Quaternion()));
        player.pos.set(sp.x, 0, sp.z);
        player.heading = Math.atan2(f.x, f.z);
        player.pos.y = groundHeightAt(player.pos.x, 500, player.pos.z);
      } else {
        const qs = new URLSearchParams(location.search);
        if (qs.get('sx') !== null || qs.get('sz') !== null) {
          player.pos.set(parseFloat(qs.get('sx')) || 0, 0, parseFloat(qs.get('sz')) || 0);
          player.pos.y = groundHeightAt(player.pos.x, 500, player.pos.z);
        } else {
          const road = findRoadSpawn();
          player.pos.set(road.x, road.y, road.z);
        }
        player.heading = 0;
      }
      const sourceMeshes = cpuMeshes.length ? cpuMeshes : [toyota86];
      const meshPool = Array.from({ length: 4 }, (_, i) => sourceMeshes[i % sourceMeshes.length].clone());
      Object.keys(info.loops).slice(0, 4).forEach((nm, i) => {
        const wps = info.loops[nm].sort((a, b) => a.i - b.i).map((w) => ({ x: w.p.x, z: w.p.z }));
        if (wps.length < 2) return;
        const g = makeCarGroup(meshPool[i]);
        aiCars.push({
          group: g.group, tilt: g.tilt,
          pos: new THREE.Vector3(wps[0].x, groundHeightAt(wps[0].x, 500, wps[0].z), wps[0].z),
          heading: 0, v: 0, base: 9 + i * 1.5,
          wps, idx: 1, radius: carRadiusFor(false),
        });
      });
      initFx();

      // デモ用のドーナツ状ルート(スポーン地点=道路の上を中心に周回ドリフト)
      const demoDonut = [];
      const cx = player.pos.x, cz = player.pos.z, R = 24;
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        demoDonut.push({ x: cx + Math.cos(a) * R, z: cz + Math.sin(a) * R });
      }
      enterDemo(demoDonut);

      document.getElementById('loading').remove();
      window.__voxDrive = { player, aiCars, start: () => startGame(), inDemo: () => demoActive };
      requestAnimationFrame(tick);
      return;
    }

    // spawn in the left lane of a central vertical road, heading +Z
    const spawnRoad = V_ROADS[Math.floor(V_ROADS.length / 2)];
    player.pos.set(spawnRoad.pos + LANE_OFF, 0, 30);
    player.heading = 0;
    // ゲーム開始時(デモ解除時)に戻す通常スポーン
    gameSpawn = { x: spawnRoad.pos + LANE_OFF, z: 30, heading: 0 };

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

    // 発見した全車種を使用。ジオメトリは車種ごとに1つだけ持ち、
    // シャドウマップ描画は省く(接地影は残る)。

    // グリッドと外周環状道路に複数の周回コースを用意する。
    const vLast = V_ROADS.length - 1, hLast = H_ROADS.length - 1;
    const loopDefs = [
      rectLoop(V_ROADS[0].pos, V_ROADS[vLast].pos, H_ROADS[0].pos, H_ROADS[hLast].pos, false),
      rectLoop(V_ROADS[1].pos, V_ROADS[Math.min(2, vLast)].pos, H_ROADS[1].pos, H_ROADS[Math.min(2, hLast)].pos, true),
      rectLoop(V_ROADS[Math.min(2, vLast)].pos, V_ROADS[vLast].pos, H_ROADS[0].pos, H_ROADS[Math.min(2, hLast)].pos, true),
      rectLoop(V_ROADS[0].pos, V_ROADS[Math.min(2, vLast)].pos, H_ROADS[Math.min(1, hLast)].pos, H_ROADS[hLast].pos, false),
      rectLoop(-CITY_EDGE, CITY_EDGE, -CITY_EDGE, CITY_EDGE, true),
      routeWps(forestLoop, 5),
    ];

    // ルートの周長に沿って startFrac の位置へ配置(車どうしが重ならないよう分散)
    function placeOnLoop(wps, mesh, startFrac, base, bike) {
      const seg = [];
      let total = 0;
      for (let i = 0; i < wps.length; i++) {
        const a = wps[i], b = wps[(i + 1) % wps.length];
        const d = Math.hypot(b.x - a.x, b.z - a.z);
        seg.push(d); total += d;
      }
      let dist = startFrac * total, s = 0;
      while (dist > seg[s]) { dist -= seg[s]; s = (s + 1) % wps.length; }
      const a = wps[s], b = wps[(s + 1) % wps.length];
      const t = seg[s] ? dist / seg[s] : 0;
      const px = a.x + (b.x - a.x) * t, pz = a.z + (b.z - a.z) * t;
      const g = makeCarGroup(mesh, false, bike);
      aiCars.push({
        group: g.group, tilt: g.tilt,
        pos: new THREE.Vector3(px, 0, pz),
        heading: Math.atan2(b.x - a.x, b.z - a.z), v: 0, base,
        wps, idx: (s + 1) % wps.length, radius: carRadiusFor(bike),
      });
    }

    // CPU 車をグリッドの5コースへ散らす(デモは別コースなので全ループを使う)
    cpuMeshes.forEach((mesh, i) => {
      const bike = /\/kabu\d*\.vox$/.test(cpuCars[i].url);   // スーパーカブはバイク
      const loop = loopDefs[i % loopDefs.length];
      const frac = (i * 0.37) % 1;         // ルート上に散らす
      placeOnLoop(loop, mesh, frac, 7 + (i % 5), bike);   // 25〜40 km/h でばらつき
    });

    const buildingMeshes = BUILDING_VOX.length
      ? await Promise.all(BUILDING_VOX.map((u) => VOX.load(u, { scale: VOXEL_SCALE })))
      : null;
    placeBuildings(buildingMeshes);
    scatterTrees([tree1, tree2], mulberry32(20260711));
    initFx();

    // ドリフトコースにも CPU 車を2台流す(グリッドの車を奪わないよう clone)
    // CPU アセットが少ない場合も、初期ロード済みの車を代替に使う。
    placeOnLoop(driftLoopPts, (cpuMeshes[13] || cpuMeshes[0] || toyota86).clone(), 0.0, 8, false);
    placeOnLoop(driftLoopPts, (cpuMeshes[22] || cpuMeshes[1] || toyota86).clone(), 0.5, 7, false);

    // デモは新しいドリフトコースを走ってヘアピンをドリフトで見せる
    const ds = driftLoopPts[0], dn = driftLoopPts[1];
    player.pos.set(ds.x, courseHeightAt(ds.x, ds.z), ds.z);
    player.heading = Math.atan2(dn.x - ds.x, dn.z - ds.z);
    enterDemo(driftLoopPts);
    document.getElementById('loading').remove();
    window.__voxDrive = { player, aiCars, start: () => startGame(), inDemo: () => demoActive };
    requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------- demo -----
  // デモ開始: 自動運転ルートをセットしてデモ画面に入る。
  function enterDemo(route) {
    demoRoute = route && route.length >= 2 ? route : null;
    demoIdx = 1;
    demoActive = !!demoRoute;
    if (demoActive) {
      document.body.classList.add('demo');
      demoCam.nextChange = performance.now() + 6000;
      demoCam.until = 0;
    }
  }

  // ユーザー操作でデモを抜けてゲーム開始(startGame は先頭で let 宣言済み)。
  startGame = function () {
    if (!demoActive) return;
    demoActive = false;
    document.body.classList.remove('demo');
    player.vel.set(0, 0, 0);
    player.drifting = false;
    player.gear = 2;
    player.steer = 0;
    if (gameSpawn) {                 // デモの位置(コース上)から通常スポーンへ戻す
      player.pos.set(gameSpawn.x, courseHeightAt(gameSpawn.x, gameSpawn.z), gameSpawn.z);
      player.heading = gameSpawn.heading;
    }
    cam.yaw = 0; cam.pitch = 0.34; cam.dist = 10; cam.lastDrag = 0;
  };

  // ルートを追い、コーナーでは積極的にサイドブレーキでドリフトする自動運転。
  function demoAutopilot() {
    const wp = demoRoute[demoIdx];
    const dx = wp.x - player.pos.x, dz = wp.z - player.pos.z;
    if (dx * dx + dz * dz < 9 * 9) demoIdx = (demoIdx + 1) % demoRoute.length;
    let diff = Math.atan2(dx, dz) - player.heading;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const speed = player.vel.length();
    return {
      throttle: true,
      brake: false,
      handbrake: Math.abs(diff) > 0.35 && speed > 7,   // コーナーでドリフト
      steer: clamp(diff * 1.6, -1, 1),
    };
  }

  // ------------------------------------------------------------- update ---
  function updatePlayer(dt) {
    if (demoActive) player.gear = 3;   // デモは2速(~40km/h)でヘアピンをドリフト
    // gears
    if (shiftUp) { player.gear = Math.min(player.gear + 1, GEARS.length - 1); shiftUp = false; }
    if (shiftDown) { player.gear = Math.max(player.gear - 1, 0); shiftDown = false; }
    const gear = GEARS[player.gear];

    let throttle, brake, handbrake, input;
    if (demoActive) {
      const c = demoAutopilot();
      throttle = c.throttle; brake = c.brake; handbrake = c.handbrake; input = c.steer;
    } else {
      throttle = !!keys['s'];   // S = アクセル
      brake = !!keys['a'];      // A = ブレーキ
      handbrake = !!keys[' '];
      input = (keys['arrowleft'] ? 1 : 0) - (keys['arrowright'] ? 1 : 0);
    }

    // steering (less lock at speed, extra lock while sliding for counter-steer)
    const speedAlong = player.vel.x * Math.sin(player.heading) + player.vel.z * Math.cos(player.heading);
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

    // custom maps: collide with vertical structures, ride on the surface
    let slopePitch = 0;
    if (mapRoot) {
      collideWalls(dt);
      const gy = groundHeightAt(player.pos.x, player.pos.y, player.pos.z);
      player.pos.y += (gy - player.pos.y) * Math.min(1, dt * 9);
    } else {
      // 街モード: ドリフトコースの坂に乗る(平地では高さ 0 で従来どおり)
      const gy = courseHeightAt(player.pos.x, player.pos.z);
      player.pos.y += (gy - player.pos.y) * Math.min(1, dt * 9);
      const hx = Math.sin(player.heading) * 3, hz = Math.cos(player.heading) * 3;
      const hF = courseHeightAt(player.pos.x + hx, player.pos.z + hz);
      const hB = courseHeightAt(player.pos.x - hx, player.pos.z - hz);
      slopePitch = Math.atan2(hF - hB, 6);   // 登りで + / 下りで -
    }

    // visuals
    player.group.position.copy(player.pos);
    player.group.rotation.y = player.heading;
    const acc = (vF - vBefore) / Math.max(dt, 1e-4);
    player.accSmooth += (acc - player.accSmooth) * Math.min(1, dt * 5);
    // 車体は外側へロール(右に曲がると左へ, 左に曲がると右へ傾く)
    player.tilt.rotation.z = clamp(player.steer * vF * 0.010 + vS * 0.008, -0.09, 0.09);
    // 加速ピッチ + 坂の傾き(登りは車首上げ)
    player.tilt.rotation.x = clamp(player.accSmooth * 0.006 - slopePitch, -0.28, 0.28);

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
    if (throttle && player.gear !== 1) rpm = Math.max(rpm, 0.3);
    rpmEl.style.width = (rpm * 100).toFixed(1) + '%';
    rpmEl.classList.toggle('red', rpm > 0.93);
  }

  function updateAI(dt, sigStates) {
    for (const ai of aiCars) {
      const wp = ai.wps[ai.idx];
      const dx = wp.x - ai.pos.x, dz = wp.z - ai.pos.z;
      if (dx * dx + dz * dz < 6 * 6) ai.idx = (ai.idx + 1) % ai.wps.length;

      let diff = Math.atan2(dx, dz) - ai.heading;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      ai.heading += clamp(diff, -1.7 * dt, 1.7 * dt);

      // slow down for corners
      let target = ai.base * (1 - 0.72 * Math.min(1, Math.abs(diff) * 1.4));
      // obey the signals: brake to a halt at the stop line on red/yellow
      const stop = aiStopDistance(ai, sigStates);
      let rate = 1.6;
      if (stop < 22) {
        target = Math.min(target, Math.max(0, (stop - 1.5) * 0.7));
        rate = 3.5;
      }
      ai.v += (target - ai.v) * Math.min(1, dt * rate);
      ai.pos.x += Math.sin(ai.heading) * ai.v * dt;
      ai.pos.z += Math.cos(ai.heading) * ai.v * dt;
      if (mapRoot) {
        const gy = groundHeightAt(ai.pos.x, ai.pos.y, ai.pos.z);
        ai.pos.y += (gy - ai.pos.y) * Math.min(1, dt * 9);
      } else {
        const gy = courseHeightAt(ai.pos.x, ai.pos.z);   // 街の坂に乗る
        ai.pos.y += (gy - ai.pos.y) * Math.min(1, dt * 9);
      }

      ai.group.position.copy(ai.pos);
      ai.group.rotation.y = ai.heading;
      ai.tilt.rotation.z = clamp(diff * ai.v * 0.006, -0.04, 0.04);   // 外側へロール
    }
  }

  function updateCamera(dt) {
    if (demoActive) {
      // 20秒に1度、5秒ほどランダムな視点に切り替える
      const t = performance.now();
      if (t > demoCam.nextChange) {
        demoCam.until = t + 5000;
        demoCam.nextChange = t + 20000;
        demoCam.yaw = (Math.random() * 2 - 1) * Math.PI;
        demoCam.pitch = 0.14 + Math.random() * 0.85;
        demoCam.dist = 8 + Math.random() * 15;
      }
      const g = Math.min(1, dt * 2.5);
      if (t < demoCam.until) {
        cam.yaw += (demoCam.yaw - cam.yaw) * g;
        cam.pitch += (demoCam.pitch - cam.pitch) * g;
        cam.dist += (demoCam.dist - cam.dist) * g;
      } else {                       // 通常時は後方追従
        cam.yaw += (0 - cam.yaw) * Math.min(1, dt * 1.5);
        cam.pitch += (0.34 - cam.pitch) * Math.min(1, dt * 1.5);
        cam.dist += (11 - cam.dist) * Math.min(1, dt * 1.5);
      }
    } else if (!cam.dragging && performance.now() - cam.lastDrag > 1800) {
      // ease back behind the car when the mouse is idle
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
    const sigStates = updateSignals(now / 1000);
    updatePlayer(dt);
    updateAI(dt, sigStates);
    updateFx(dt);
    updateCamera(dt);
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }

  init().catch((err) => {
    const el = document.getElementById('loading');
    if (el) {
      const localHint = location.protocol === 'file:'
        ? '<br>ダウンロード版は <code>PLAY_VOX_DRIVE.bat</code> から起動してください。'
        : '';
      el.innerHTML = '<div class="err">読み込みに失敗しました。' + localHint
        + '<br><small>' + err.message + '</small></div>';
    }
    console.error(err);
  });
})();

