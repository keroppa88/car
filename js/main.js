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
import { AUDIO } from './audio.js?v=20260715-1';

(function () {
  'use strict';

  // マップ選択: デフォルトは自動生成の街 + 森 + 峠。
  //   ?map=nihonbashi.gltf … 日本橋マップを読む
  //   ?map=maps/sample.glb … 別の glTF/GLB マップを読む
  //   ?map=city            … デフォルトと同じ自動生成マップ
  const pageQuery = new URLSearchParams(location.search);
  const mapParam = pageQuery.get('map');
  const carParam = (pageQuery.get('car') || 'toyota86').toLowerCase();
  const PLAYER_CAR_KEY = carParam === 'volvo240' ? 'volvo240' : 'toyota86';
  const MAP_GLTF = mapParam === null || ['', 'city', 'procedural', 'none', '0'].includes(mapParam)
    ? ''
    : mapParam;
  const NIHONBASHI_MODE = MAP_GLTF.toLowerCase().endsWith('nihonbashi.gltf');
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
  let gameSpawn = null;             // デモ解除時に戻る通常スポーン {x,y?,z,heading}

  // 緊急指令(ミッション)の状態。ワンダーランドのみ。init 内で有効化する。
  let missionScenarios = [];        // [{ car:'nissan180sx3.vox', msg:'...' }]
  let missionCpuCars = [];          // 読み込み済み CPU 車 [{url, mesh}]
  let missionRingWps = null;        // 犯人が回遊する外周ルート
  let missionEnabled = false;
  const mission = { phase: 'off', queue: [], active: null, nextAt: 0 };  // off/waiting/active/done

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
  sun.shadow.mapSize.set(512, 512);
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

  // 峠の起伏に沿ってコースを舗装する。
  function paveCourse(pts) {
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      const dx = q.x - p.x, dz = q.z - p.z, len = Math.hypot(dx, dz);
      if (len < 0.01) continue;
      const yaw = Math.atan2(dx, dz), c = Math.cos(yaw), s = Math.sin(yaw);
      // 長い平面を避け、曲面状の地表へ追従するよう最大4mに細分化する。
      const steps = Math.max(1, Math.ceil(len / 4));
      for (let k = 0; k < steps; k++) {
        const t0 = k / steps, t1 = (k + 1) / steps;
        const ax = p.x + dx * t0, az = p.z + dz * t0;
        const bx = p.x + dx * t1, bz = p.z + dz * t1;
        const mx = (ax + bx) / 2, mz = (az + bz) / 2, sl = len / steps;
        driftShoulder.addSloped(mx, mz, 11, sl + 0.8, yaw, courseHeightAt, 0.0);
        asphalt.addSloped(mx, mz, 9, sl + 0.6, yaw, courseHeightAt, 0.06);
        paint.addSloped(mx + 4.3 * c, mz - 4.3 * s, 0.16, sl + 0.4, yaw, courseHeightAt, 0.09);
        paint.addSloped(mx - 4.3 * c, mz + 4.3 * s, 0.16, sl + 0.4, yaw, courseHeightAt, 0.09);
        if (k % 2 === 0) paint.addSloped(mx, mz, 0.16, sl * 0.6, yaw, courseHeightAt, 0.09);  // 中央破線
      }
    }
  }

  if (!MAP_GLTF) {
    BOUND_X_MIN = -350;              // 西側の外周道路まで走行可能にする
    BOUND_Z = 620;                   // 南のドリフトコースまで走れるように拡張
    paveCourse(driftLoopPts);
    // グリッド道路とドリフトコースをつなぐ短い連絡路
    {
      const z0 = 330, z1 = DRIFT_TOP_Z, steps = 7;
      for (let k = 0; k < steps; k++) {
        const mz = z0 + (z1 - z0) * (k + 0.5) / steps;
        driftShoulder.addSloped(DRIFT_CONNECTOR_X, mz, 11, (z1 - z0) / steps + 0.8, 0, courseHeightAt, 0.0);
        asphalt.addSloped(DRIFT_CONNECTOR_X, mz, 9, (z1 - z0) / steps + 0.4, 0, courseHeightAt, 0.06);
      }
      patches.addSloped(DRIFT_CONNECTOR_X, z1, 12, 12, 0, courseHeightAt, 0.07);
    }
    scene.add(driftShoulder.build(true));
    scene.add(asphalt.build(true));
    scene.add(paint.build(false));
    scene.add(patches.build(true));

    // 地面を峠へ持ち上げ、道路付近は路盤として少し掘り下げる。
    // 粗い地表三角形が道路面を横切って突き抜けるのを防ぐ。
    const gpos = ground.geometry.attributes.position;
    const terrainSample = { roadDistance: Infinity };
    for (let i = 0; i < gpos.count; i++) {
      const wx = gpos.getX(i) + ground.position.x;   // ローカル->ワールド X
      const wz = -gpos.getY(i);                       // ローカル Y -> ワールド Z
      const height = courseHeightAt(wx, wz, terrainSample);
      const cutT = 1 - clamp((terrainSample.roadDistance - 12) / 12, 0, 1);
      const roadbedCut = 0.55 * cutT * cutT * (3 - 2 * cutT);
      gpos.setZ(i, height - roadbedCut);               // ローカル Z -> ワールド Y
    }
    gpos.needsUpdate = true;
    ground.geometry.computeVertexNormals();
  } else {
    signals.length = 0;              // カスタムマップに自動生成の信号は無い
    ground.position.y = -0.08;       // マップ自身の地面の下に敷く保険
  }

  // ----- traffic signals -----
  // Two-phase controller shared by every grid intersection:
  //   NS (vertical roads): green 8 s -> yellow 3 s -> red 11 s
  //   EW (horizontal roads): the opposite — red while NS is green/yellow.
  const SIG_CYCLE = 22;
  function signalState(axis, timeSec) {
    const local = axis === 0 ? timeSec % SIG_CYCLE : (timeSec + 11) % SIG_CYCLE;
    if (local < 8) return 'g';
    if (local < 11) return 'y';
    return 'r';
  }

  const LAMP_BRIGHT = {
    g: new THREE.MeshBasicMaterial({ color: 0x00c878 }),
    y: new THREE.MeshBasicMaterial({ color: 0xffc400 }),
    r: new THREE.MeshBasicMaterial({ color: 0xff4438 }),
  };
  const LAMP_DIM = {};
  for (const k of ['g', 'y', 'r']) {
    LAMP_DIM[k] = new THREE.MeshBasicMaterial({
      color: new THREE.Color(LAMP_BRIGHT[k].color).multiplyScalar(0.13),
    });
  }
  const lampMeshes = [];              // {mesh, color, axis}
  {
    const poleGeo = new THREE.CylinderGeometry(0.09, 0.09, 5.6, 6);
    const poleMat = new THREE.MeshLambertMaterial({ color: 0x555a5e });
    const boxGeo = new THREE.BoxGeometry(2.0, 0.66, 0.24);
    const boxMat = new THREE.MeshLambertMaterial({ color: 0x2c2f33 });
    const lampGeo = new THREE.CircleGeometry(0.22, 12);
    for (const s of signals) {
      const g = new THREE.Group();
      g.position.set(s.x + s.vw / 2 + 1.2, 0, s.z + s.hw / 2 + 1.2);
      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.position.y = 2.8;
      g.add(pole);
      // one horizontal 青黄赤 box per axis, lamps on both faces
      [{ axis: 0, y: 5.2, yaw: 0 }, { axis: 1, y: 4.3, yaw: Math.PI / 2 }].forEach((cfg) => {
        const holder = new THREE.Group();
        holder.position.y = cfg.y;
        holder.rotation.y = cfg.yaw;
        holder.add(new THREE.Mesh(boxGeo, boxMat));
        [['g', -0.63], ['y', 0], ['r', 0.63]].forEach(([color, lx]) => {
          for (const face of [1, -1]) {
            const lamp = new THREE.Mesh(lampGeo, LAMP_DIM[color]);
            lamp.position.set(lx, 0, 0.13 * face);
            if (face < 0) lamp.rotation.y = Math.PI;
            holder.add(lamp);
            lampMeshes.push({ mesh: lamp, color, axis: cfg.axis });
          }
        });
        g.add(holder);
      });
      scene.add(g);
    }
  }

  const sigWinEl = document.getElementById('signal');
  const sigLampEls = { g: document.getElementById('sig-g'), y: document.getElementById('sig-y'), r: document.getElementById('sig-r') };
  let lastSigStates = ['', ''];

  function updateSignals(timeSec) {
    const states = [signalState(0, timeSec), signalState(1, timeSec)];
    if (states[0] !== lastSigStates[0] || states[1] !== lastSigStates[1]) {
      lastSigStates = states;
      for (const l of lampMeshes) {
        l.mesh.material = states[l.axis] === l.color ? LAMP_BRIGHT[l.color] : LAMP_DIM[l.color];
      }
    }

    // HUD window: show the player's own signal when nearing an intersection
    const fx = Math.sin(player.heading), fz = Math.cos(player.heading);
    let best = null;
    for (const s of signals) {
      const dx = s.x - player.pos.x, dz = s.z - player.pos.z;
      const ahead = dx * fx + dz * fz;
      const lat = Math.abs(dx * fz - dz * fx);
      if (lat > 10 || ahead < -6 || ahead > 55) continue;
      if (!best || ahead < best.ahead) best = { ahead };
    }
    if (best) {
      const axis = Math.abs(fx) > Math.abs(fz) ? 1 : 0;
      const st = states[axis];
      sigWinEl.style.display = 'flex';
      for (const k of ['g', 'y', 'r']) sigLampEls[k].classList.toggle('on', st === k);
    } else {
      sigWinEl.style.display = 'none';
    }
    return states;
  }

  // Distance to the stop line of a red/yellow signal ahead of an AI car,
  // or Infinity when the way is clear.
  function aiStopDistance(ai, states) {
    const fx = Math.sin(ai.heading), fz = Math.cos(ai.heading);
    const axis = Math.abs(fx) > Math.abs(fz) ? 1 : 0;
    if (states[axis] === 'g') return Infinity;
    let stop = Infinity;
    for (const s of signals) {
      const dx = s.x - ai.pos.x, dz = s.z - ai.pos.z;
      const ahead = dx * fx + dz * fz;
      const lat = Math.abs(dx * fz - dz * fx);
      if (lat > 8 || ahead < 0 || ahead > 32) continue;
      const crossHalf = axis === 0 ? s.hw / 2 : s.vw / 2;
      const line = ahead - crossHalf - 3;
      if (line < -1) continue;                        // already in the box: clear it
      if (states[axis] === 'y' && line < 3) continue; // yellow, too late to stop
      stop = Math.min(stop, line);
    }
    return stop;
  }

  function distToDiag(x, z, d) {
    return Math.abs((x - d.cx) * Math.cos(d.yaw) - (z - d.cz) * Math.sin(d.yaw));
  }
  function onAnyRoad(x, z, margin) {
    for (const r of V_ROADS) if (Math.abs(x - r.pos) < r.w / 2 + margin && Math.abs(z) < ROAD_LEN / 2) return true;
    for (const r of H_ROADS) if (Math.abs(z - r.pos) < r.w / 2 + margin && Math.abs(x) < ROAD_LEN / 2) return true;
    if (Math.abs(Math.abs(x) - CITY_EDGE) < PERIMETER_ROAD.w / 2 + margin && Math.abs(z) <= CITY_EDGE + margin) return true;
    if (Math.abs(Math.abs(z) - CITY_EDGE) < PERIMETER_ROAD.w / 2 + margin && Math.abs(x) <= CITY_EDGE + margin) return true;
    for (const d of DIAGS) {
      const t = (x - d.cx) * Math.sin(d.yaw) + (z - d.cz) * Math.cos(d.yaw);
      if (t >= d.t0 - margin && t <= d.t1 + margin && distToDiag(x, z, d) < d.w / 2 + margin) return true;
    }
    const rr = (4 + margin + 3) * (4 + margin + 3);   // route samples are ~5 m apart
    for (const p of forestLoop) if ((p.x - x) * (p.x - x) + (p.z - z) * (p.z - z) < rr) return true;
    for (const p of connector) if ((p.x - x) * (p.x - x) + (p.z - z) * (p.z - z) < rr) return true;
    return false;
  }

  // ----- dense blocks: roughly 9–25 buildings each, fronts facing roads -----
  const BUILDING_COLORS = [0xb8b0a4, 0x9aa4ad, 0xc4b49a, 0xa8b89e, 0xbfa3a0, 0x93a0b5];
  function placeBuildings(voxMeshes) {
    // Placeholder boxes are instanced by color so hundreds of buildings stay cheap.
    const boxLists = BUILDING_COLORS.map(() => []);
    for (let i = 0; i + 1 < V_ROADS.length; i++) {
      for (let j = 0; j + 1 < H_ROADS.length; j++) {
        const x1 = V_ROADS[i].pos + V_ROADS[i].w / 2 + 2;
        const x2 = V_ROADS[i + 1].pos - V_ROADS[i + 1].w / 2 - 2;
        const z1 = H_ROADS[j].pos + H_ROADS[j].w / 2 + 2;
        const z2 = H_ROADS[j + 1].pos - H_ROADS[j + 1].w / 2 - 2;
        const bw = x2 - x1, bd = z2 - z1;
        if (bw < 24 || bd < 24) continue;

        const cols = clamp(Math.floor(bw / 22), 3, 5);
        const rows = clamp(Math.floor(bd / 22), 3, 5);
        const cellW = bw / cols, cellD = bd / rows;
        for (let row = 0; row < rows; row++) {
          for (let col = 0; col < cols; col++) {
            if (cityRnd() < 0.08) continue;           // occasional courtyard / parking lot
            const w = cellW * (0.56 + cityRnd() * 0.18);
            const d2 = cellD * (0.56 + cityRnd() * 0.18);
            const h = 7 + cityRnd() * 25;
            const jx = (cityRnd() * 2 - 1) * Math.max(0, (cellW - w) * 0.16);
            const jz = (cityRnd() * 2 - 1) * Math.max(0, (cellD - d2) * 0.16);
            const x = x1 + cellW * (col + 0.5) + jx;
            const z = z1 + cellD * (row + 0.5) + jz;

            // Point each front (+Z) toward the nearest surrounding road.
            const edgeDistances = [z2 - z, z - z1, x2 - x, x - x1];
            let side = 0;
            for (let k = 1; k < 4; k++) if (edgeDistances[k] < edgeDistances[side]) side = k;
            const yaw = [0, Math.PI, Math.PI / 2, -Math.PI / 2][side];

            let bad = false;
            for (const dg of DIAGS) {
              if (distToDiag(x, z, dg) < dg.w / 2 + Math.hypot(w, d2) / 2) bad = true;
            }
            if (bad) continue;

            // vox の建物があっても箱と混ぜて配置する
            if (voxMeshes && voxMeshes.length && cityRnd() < 0.6) {
              const mesh = voxMeshes[Math.floor(cityRnd() * voxMeshes.length)].clone();
              const holder = new THREE.Group();
              holder.add(mesh);
              holder.position.set(x, 0, z);
              holder.rotation.y = yaw;
              scene.add(holder);
            } else {
              const colorIndex = Math.floor(cityRnd() * BUILDING_COLORS.length);
              boxLists[colorIndex].push({ x, z, w, h, d: d2, yaw });
            }
            obstacles.push({ x, z, r: (w + d2) / 4 });
          }
        }
      }
    }

    const unitBox = new THREE.BoxGeometry(1, 1, 1);
    const matrix = new THREE.Matrix4();
    const rotation = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    boxLists.forEach((list, colorIndex) => {
      if (!list.length) return;
      const inst = new THREE.InstancedMesh(
        unitBox,
        new THREE.MeshLambertMaterial({ color: BUILDING_COLORS[colorIndex] }),
        list.length
      );
      list.forEach((b, index) => {
        rotation.setFromAxisAngle(up, b.yaw);
        matrix.compose(
          new THREE.Vector3(b.x, b.h / 2, b.z),
          rotation,
          new THREE.Vector3(b.w, b.h, b.d)
        );
        inst.setMatrixAt(index, matrix);
      });
      inst.instanceMatrix.needsUpdate = true;
      inst.computeBoundingSphere();
      inst.castShadow = true;
      inst.receiveShadow = true;
      scene.add(inst);
    });
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
        m.position.set(rx + sx * side, player.pos.y + 0.11 + (skidIdx % 8) * 0.0012, rz + sz * side);
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
      s.position.set(rx + sx * side + (Math.random() - 0.5) * 0.3, player.pos.y + 0.25, rz + sz * side + (Math.random() - 0.5) * 0.3);
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
  // 低いギアは素早く吹け上がり、5速に入れる頃には約70km/h。そこから
  // 6秒ほどで最高速の110km/hに達する(5速はvmax=32だが空気抵抗との
  // 釣り合いでちょうど110km/hで頭打ちになる)。
  const GEARS = [
    { name: 'R', vmax: -8.3, acc: 5.5 },   // ~30 km/h reverse
    { name: 'N', vmax: 0, acc: 0 },
    { name: '1', vmax: 6.1, acc: 10.0 },  // 22 km/h
    { name: '2', vmax: 11.1, acc: 8.0 },   // 40
    { name: '3', vmax: 15.3, acc: 7.0 },   // 55
    { name: '4', vmax: 19.4, acc: 6.0 },   // 70
    { name: '5', vmax: 32.0, acc: 14.0 },  // 実質110 km/h(最高速度)
  ];

  const player = {
    group: null,     // yaw
    tilt: null,      // roll / pitch (visual only)
    pos: new THREE.Vector3(0, 0, 0),
    vel: new THREE.Vector3(0, 0, 0),
    heading: 0,
    steer: 0,
    gear: 2,         // start in 1st
    radius: 1.05,    // 接地影の横幅の半分 ≒ 実車幅の半分(CAR_SHADOW.w / 2)
    accSmooth: 0,
    drifting: false,
  };

  const aiCars = []; // { group, tilt, pos, heading, v, base, wps, idx, radius }

  // デモ自動運転のルートと、切り替え式デモカメラの状態
  let demoRoute = null;
  let demoIdx = 1;
  const demoCam = { nextChange: 0, until: 0, yaw: 0, pitch: 0.3, dist: 12 };

  // ------------------------------------------------------------- camera ---
  const cam = { yaw: 0, pitch: 0.34, dist: 10, dragging: false, lastDrag: 0 };
  renderer.domElement.addEventListener('pointerdown', (e) => {
    AUDIO.unlock();
    if (demoActive) { startGame(); return; }   // クリックでもゲーム開始
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

  // Follow the map's road surface: cast a ray down from above the car —
  // 車の高さ(約2.7m)×1.2 の位置から — so the car rides on top of the road
  // slab instead of sinking into it, climbs bridges/slopes, and still never
  // pops up onto rooftops (the ray starts below them). Falls back to y=0.
  const RIDE_RAY = 2.7 * 1.2;
  const groundCaster = new THREE.Raycaster();
  const DOWN = new THREE.Vector3(0, -1, 0);
  const rayOrigin = new THREE.Vector3();
  function groundHeightAt(x, y, z) {
    if (!mapRoot) return 0;
    rayOrigin.set(x, y + RIDE_RAY, z);
    groundCaster.set(rayOrigin, DOWN);
    groundCaster.far = rayOrigin.y + 100;   // reach the ground from any height
    const hit = groundCaster.intersectObject(mapRoot, true)[0];
    return hit ? hit.point.y : 0;
  }

  // 垂直の構築物(建物・壁)との当たり判定: 車体の高さから進行方向へ短い
  // レイを3本飛ばし、ほぼ垂直な面に当たったら壁とみなして滑らせて止める。
  // 坂や橋のスロープ(面が上を向いている)は素通りするので登坂は妨げない。
  const wallCaster = new THREE.Raycaster();
  const wallDir = new THREE.Vector3();
  const wallOrigin = new THREE.Vector3();
  const wallNormal = new THREE.Vector3();
  function collideWalls(dt) {
    if (!mapRoot) return;
    const speed = player.vel.length();
    if (speed < 0.3) return;
    wallDir.copy(player.vel).multiplyScalar(1 / speed);
    const reach = 2.5 + speed * dt;
    wallCaster.far = reach;
    for (const side of [-0.85, 0, 0.85]) {
      wallOrigin.set(
        player.pos.x - wallDir.z * side,
        player.pos.y + 1.1,
        player.pos.z + wallDir.x * side
      );
      wallCaster.set(wallOrigin, wallDir);
      const hit = wallCaster.intersectObject(mapRoot, true)[0];
      if (!hit || !hit.face) continue;
      wallNormal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
      if (Math.abs(wallNormal.y) > 0.55) continue;          // 坂・地面は壁ではない
      if (wallNormal.dot(wallDir) > 0) wallNormal.negate(); // 面の向きを車側へ
      const into = player.vel.x * wallNormal.x + player.vel.z * wallNormal.z;
      if (into < 0) {
        player.vel.x -= wallNormal.x * into;                // 壁沿いに滑らせる
        player.vel.z -= wallNormal.z * into;
        player.vel.multiplyScalar(0.9);
      }
      const pen = Math.min(reach - hit.distance, 0.5);
      player.pos.x += wallNormal.x * pen;
      player.pos.z += wallNormal.z * pen;
    }
  }

  // --------------------------------------------------------------- init ---
  // Soft contact shadow that sits directly under a car at all times —
  // the directional shadow alone lands beside the body when the sun is low.
  // 車体の実サイズにほぼ合わせた接地影。幅=横, 奥行き=縦(進行方向)。
  const CAR_SHADOW = { w: 2.1, h: 4.6 };
  // kabu(スーパーカブ)はバイク。影はタイヤ一個分くらいの小さく細いものに。
  const BIKE_SHADOW = { w: 0.75, h: 2.0 };
  let blobTex = null;
  function makeBlobShadow(size) {
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
    const s = size || CAR_SHADOW;
    const blob = new THREE.Mesh(
      new THREE.PlaneGeometry(s.w, s.h),
      new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false })
    );
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 0.12;          // above the road surface + markings
    return blob;
  }

  function makeCarGroup(mesh, castShadow, bike) {
    const tilt = new THREE.Group();
    mesh.rotation.y = MODEL_YAW;
    mesh.position.y = -CAR_SINK;
    // 多数の CPU 車はシャドウマップ描画を省いて軽量化(接地影は残る)
    if (castShadow === false) mesh.castShadow = false;
    tilt.add(mesh);
    const group = new THREE.Group();
    group.add(tilt);
    group.add(makeBlobShadow(bike ? BIKE_SHADOW : CAR_SHADOW));
    scene.add(group);
    return { group, tilt };
  }

  // 当たり判定の半径は接地影の横幅の半分に合わせる(実車幅とほぼ一致)。
  const carRadiusFor = (bike) => (bike ? BIKE_SHADOW.w : CAR_SHADOW.w) / 2;

  // タイトル画面の選択に応じてユーザー車を切り替える。
  // Volvo 240 は追加済みの vox/volvo240.vox を使用する。
  const PLAYER_CAR_FILE = PLAYER_CAR_KEY === 'volvo240' ? 'volvo240.vox' : 'toyota86.vox';
  const PLAYER_CAR_VOX = 'vox/' + encodeURIComponent(PLAYER_CAR_FILE) + '?v=20260715-1';

  // vox/ 直下の .vox はすべて車両。選択中のプレイヤー車だけ CPU 車から除外する。
  // 樹木などのコースオブジェクトは vox/object/ に分離している。
  const RESERVED_VOX_FILES = new Set([
    PLAYER_CAR_FILE.toLowerCase(),
  ]);

  function cpuVoxUrls(fileNames) {
    return [...new Set(fileNames)]
      .map((name) => String(name).split(/[\\/]/).pop())
      .filter((name) => /\.vox$/i.test(name) && !RESERVED_VOX_FILES.has(name.toLowerCase()))
      .sort((a, b) => a.localeCompare(b, 'en'))
      .map((name) => 'vox/' + encodeURIComponent(name));
  }

  async function githubVoxFiles() {
    if (!location.hostname.endsWith('.github.io')) return [];
    const owner = location.hostname.slice(0, -'.github.io'.length);
    const firstPath = location.pathname.split('/').filter(Boolean)[0];
    const repo = firstPath || `${owner}.github.io`;
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/vox`,
      { cache: 'no-store' }
    );
    if (!response.ok) throw new Error(`GitHub contents API returned ${response.status}`);
    const entries = await response.json();
    if (!Array.isArray(entries)) throw new Error('GitHub contents API did not return a directory');
    return entries.filter((entry) => entry.type === 'file').map((entry) => entry.name);
  }

  async function localServerVoxFiles() {
    const response = await fetch('vox-files.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`vox-files.json returned ${response.status}`);
    const names = await response.json();
    if (!Array.isArray(names)) throw new Error('vox-files.json is not an array');
    return names;
  }

  async function directoryListingVoxFiles() {
    const response = await fetch('vox/', { cache: 'no-store' });
    if (!response.ok) throw new Error(`vox directory returned ${response.status}`);
    const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
    return Array.from(doc.querySelectorAll('a[href]')).map((link) => {
      const path = new URL(link.getAttribute('href'), response.url).pathname;
      try { return decodeURIComponent(path.split('/').filter(Boolean).pop() || ''); }
      catch (_) { return ''; }
    });
  }

  async function discoverCpuCarVox() {
    const sources = location.hostname.endsWith('.github.io')
      // GitHub Pages ではローカルサーバー用エンドポイントを使わない。
      ? [githubVoxFiles]
      // ダウンロード版は PLAY_*.bat の PowerShell サーバーを優先し、
      // python -m http.server のディレクトリ一覧にも対応する。
      : [localServerVoxFiles, directoryListingVoxFiles];
    for (const getFiles of sources) {
      try {
        const urls = cpuVoxUrls(await getFiles());
        if (urls.length) return urls;
      } catch (error) {
        console.warn('Could not inspect the vox folder with this source.', error);
      }
    }
    console.warn('No CPU vehicle files were discovered. The player car will be used as a fallback.');
    return [];
  }

  async function loadCpuCars(urls) {
    return (await Promise.all(urls.map(async (url) => {
      try {
        return { url, mesh: await VOX.load(url, { scale: VOXEL_SCALE }) };
      } catch (error) {
        console.warn(`CPU car skipped because it could not be loaded: ${url}`, error);
        return null;
      }
    }))).filter(Boolean);
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
      const meshIndex = Math.floor(rnd() * meshes.length);
      const s = 0.75 + rnd() * 0.6;
      lists[meshIndex].push({ x, z, s, rot: rnd() * Math.PI * 2 });
      obstacles.push({ x, z, r: 0.9 * s });
      return true;
    }

    // 建物のある四角区画は樹木を少なくし、建物から十分に離す。
    let placed = 0, attempts = 0;
    while (placed < 16 && attempts++ < 6000) {
      const x = -310 + rnd() * 620;
      const z = (rnd() * 2 - 1) * 310;
      if (tryPlace(cityLists, x, z, 4, 7)) placed++;
    }

    // 森林コース沿いは tree01 / tree02 だけを配置。
    placed = 0; attempts = 0;
    while (placed < 756 && attempts++ < 84000) {
      const pointIndex = Math.floor(rnd() * forestLoop.length);
      const p = forestLoop[pointIndex];
      const prev = forestLoop[(pointIndex + forestLoop.length - 1) % forestLoop.length];
      const next = forestLoop[(pointIndex + 1) % forestLoop.length];
      const tangentX = next.x - prev.x;
      const tangentZ = next.z - prev.z;
      const tangentLength = Math.hypot(tangentX, tangentZ) || 1;
      const tx = tangentX / tangentLength;
      const tz = tangentZ / tangentLength;
      const nx = -tz;
      const nz = tx;
      const side = rnd() < 0.5 ? -1 : 1;
      // 道路中心から9～27m。二乗分布で道路に近い側へ集中させる。
      const roadDistance = 9 + rnd() * rnd() * 18;
      const alongRoad = (rnd() * 2 - 1) * 10;
      const x = p.x + nx * side * roadDistance + tx * alongRoad;
      const z = p.z + nz * side * roadDistance + tz * alongRoad;
      if (x < 300 || x > BOUND_X_MAX || Math.abs(z) > BOUND_Z) continue;
      const sector = Math.floor(((Math.atan2(z - FOREST_C.z, x - FOREST_C.x) + Math.PI) / (Math.PI * 2)) * SECTORS) % SECTORS;
      if (tryPlace(sectorLists[sector], x, z, 2.5, 1.25)) placed++;
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

  // Converter exports (CAD/city scans) often arrive as thousands of tiny
  // meshes — merge them per material so the GPU sees a handful of draws.
  function mergeMapMeshes(root) {
    const groups = new Map();
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      if (!o.isMesh) return;
      const g = (o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone());
      g.applyMatrix4(o.matrixWorld);
      const key = o.material.uuid + '|' + Object.keys(g.attributes).sort().join(',');
      if (!groups.has(key)) groups.set(key, { mat: o.material, list: [] });
      groups.get(key).list.push(g);
    });
    const merged = new THREE.Group();
    merged.name = root.name;
    for (const { mat, list } of groups.values()) {
      const geo = mergeGeometries(list, false);
      if (!geo) continue;
      mat.side = THREE.DoubleSide;      // converted models often have flipped faces
      merged.add(new THREE.Mesh(geo, mat));
    }
    return merged;
  }

  // Load a glTF/GLB world. Conventions (see README):
  //   - meshes named col_*  -> round collider from their bounding box
  //   - empty named spawn   -> player start (its +Z = initial heading)
  //   - empties wp_<loop>_<n> -> AI waypoint loops, driven in index order
  // Raw converter exports are auto-adjusted: millimetre units are scaled
  // down, Z-up models are rotated upright, and the map is centred on the
  // origin. Override with URL params: &scale= &zup=0/1 &y=
  async function loadGltfMap(url) {
    const qs = new URLSearchParams(location.search);
    const gltf = await new GLTFLoader().loadAsync(url);
    let map = gltf.scene;
    map.updateMatrixWorld(true);

    let meshCount = 0;
    map.traverse((o) => { if (o.isMesh) meshCount++; });
    // hand-made maps keep their node names; giant converter dumps get merged
    if (meshCount > 200) map = mergeMapMeshes(map);

    const size = new THREE.Box3().setFromObject(map).getSize(new THREE.Vector3());
    const wrap = new THREE.Group();
    wrap.add(map);
    const pScale = parseFloat(qs.get('scale'));
    // mm 単位の地図は実寸(1/1000)だと街路が車に対して窮屈なので10倍で読む
    const scale = pScale || (Math.max(size.x, size.y, size.z) > 4000 ? 0.01 : 1);
    wrap.scale.setScalar(scale);
    const zupParam = qs.get('zup');
    const zup = zupParam !== null ? zupParam === '1' : size.z < size.y * 0.5;
    if (zup) wrap.rotation.x = -Math.PI / 2;
    scene.add(wrap);
    wrap.updateMatrixWorld(true);

    // centre the map on the origin (x/z) and rest its lowest surface —
    // the road/ground — on y=0. Optional height tweak via &y=
    const box = new THREE.Box3().setFromObject(wrap);
    const c = box.getCenter(new THREE.Vector3());
    wrap.position.x -= c.x;
    wrap.position.z -= c.z;
    wrap.position.y -= box.min.y;
    wrap.position.y += parseFloat(qs.get('y')) || 0;
    wrap.updateMatrixWorld(true);
    mapRoot = wrap;

    const out = { spawn: null, loops: {} };
    wrap.traverse((o) => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
      const name = o.name || '';
      if (o.isMesh && name.startsWith('col_')) {
        const b = new THREE.Box3().setFromObject(o);
        const cc = b.getCenter(new THREE.Vector3());
        const sz = b.getSize(new THREE.Vector3());
        obstacles.push({ x: cc.x, z: cc.z, r: Math.max(0.5, (sz.x + sz.z) / 4) });
      }
      if (name === 'spawn') out.spawn = o;
      const m = name.match(/^wp_(.+)_(\d+)$/);
      if (m) {
        (out.loops[m[1]] = out.loops[m[1]] || []).push({ i: +m[2], p: o.getWorldPosition(new THREE.Vector3()) });
      }
    });

    const fin = new THREE.Box3().setFromObject(wrap);
    BOUND_X_MIN = fin.min.x - 5;
    BOUND_X_MAX = fin.max.x + 5;
    BOUND_Z = Math.max(Math.abs(fin.min.z), Math.abs(fin.max.z)) + 5;
    return out;
  }

  async function init() {
    const [playerCarMesh, tree1, tree2] = await Promise.all([
      VOX.load(PLAYER_CAR_VOX, { scale: VOXEL_SCALE }),
      VOX.load('vox/object/tree01.vox', { scale: TREE_SCALE }),
      VOX.load('vox/object/tree02.vox', { scale: TREE_SCALE }),
    ]);
    // 日本橋ではCPU車を配置しないため、車種検索とVOX読み込みも省略する。
    const discoveredCpuVox = NIHONBASHI_MODE ? [] : await discoverCpuCarVox();
    const cpuCars = await loadCpuCars(
      NIHONBASHI_MODE ? [] : (MAP_GLTF ? discoveredCpuVox.slice(0, 4) : discoveredCpuVox)
    );
    const cpuMeshes = cpuCars.map((car) => car.mesh);

    const p = makeCarGroup(playerCarMesh);
    player.group = p.group;
    player.tilt = p.tilt;

    if (MAP_GLTF) {
      const info = await loadGltfMap(MAP_GLTF);
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

      // 日本橋だけ: 元の開始位置から車長1台分後退し、左へ90度向ける。
      if (NIHONBASHI_MODE) {
        const originalHeading = player.heading;
        const carLength = 4.8;
        player.pos.x -= Math.sin(originalHeading) * carLength;
        player.pos.z -= Math.cos(originalHeading) * carLength;
        player.heading += Math.PI / 2;
        player.pos.y = groundHeightAt(player.pos.x, 500, player.pos.z);
        gameSpawn = {
          x: player.pos.x,
          y: player.pos.y,
          z: player.pos.z,
          heading: player.heading,
        };
      }

      const sourceMeshes = cpuMeshes.length ? cpuMeshes : [playerCarMesh];
      const meshPool = Array.from({ length: 4 }, (_, i) => sourceMeshes[i % sourceMeshes.length].clone());
      const customLoopNames = NIHONBASHI_MODE ? [] : Object.keys(info.loops).slice(0, 4);
      customLoopNames.forEach((nm, i) => {
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
    placeOnLoop(driftLoopPts, (cpuMeshes[13] || cpuMeshes[0] || playerCarMesh).clone(), 0.0, 8, false);
    placeOnLoop(driftLoopPts, (cpuMeshes[22] || cpuMeshes[1] || playerCarMesh).clone(), 0.5, 7, false);

    // 緊急指令(ミッション)を有効化。犯人車両は外周環状(loopDefs[4])を高速回遊。
    missionCpuCars = cpuCars;
    missionRingWps = loopDefs[4];
    missionScenarios = await loadScenarios();
    missionEnabled = missionScenarios.length > 0 && missionCpuCars.length > 0;

    // ワンダーランドのデモ場所は、街・外周・森林・峠から毎回ランダム。
    // 同じコースが選ばれても開始地点をずらす。
    const demoCandidates = [...loopDefs, driftLoopPts].filter((route) => route && route.length >= 2);
    const pickedDemoRoute = demoCandidates[Math.floor(Math.random() * demoCandidates.length)];
    const demoStartIndex = Math.floor(Math.random() * pickedDemoRoute.length);
    const randomDemoRoute = pickedDemoRoute
      .slice(demoStartIndex)
      .concat(pickedDemoRoute.slice(0, demoStartIndex));
    const ds = randomDemoRoute[0], dn = randomDemoRoute[1];
    player.pos.set(ds.x, courseHeightAt(ds.x, ds.z), ds.z);
    player.heading = Math.atan2(dn.x - ds.x, dn.z - ds.z);
    enterDemo(randomDemoRoute);
    document.getElementById('loading').remove();
    window.__voxDrive = { player, aiCars, start: () => startGame(), inDemo: () => demoActive, mission };
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
      const spawnY = Number.isFinite(gameSpawn.y)
        ? gameSpawn.y
        : courseHeightAt(gameSpawn.x, gameSpawn.z);
      player.pos.set(gameSpawn.x, spawnY, gameSpawn.z);
      player.heading = gameSpawn.heading;
    }
    cam.yaw = 0; cam.pitch = 0.34; cam.dist = 10; cam.lastDrag = 0;

    // 緊急指令の開始: プレイ開始1分後に1件目、以降は解決の1分後に次の1件。
    if (missionEnabled && mission.phase === 'off') {
      mission.queue = missionScenarios.map((_, i) => i);
      for (let i = mission.queue.length - 1; i > 0; i--) {   // シャッフル
        const j = Math.floor(Math.random() * (i + 1));
        [mission.queue[i], mission.queue[j]] = [mission.queue[j], mission.queue[i]];
      }
      mission.phase = 'waiting';
      mission.nextAt = performance.now() + 60000;
    }
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

  // ------------------------------------------------------------ mission ---
  const missionPopupEl = document.getElementById('mission-popup');
  const missionObjEl = document.getElementById('mission-obj');
  let missionPopupTimer = 0;

  // ゲームシナリオ.txt を読む。失敗しても既定の5件で動くようにする。
  function parseScenarios(text) {
    const out = [];
    let car = null;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const mCar = line.match(/^車両[:：]\s*(.+)$/);
      const mMsg = line.match(/^指令[:：]\s*(.+)$/);
      if (mCar) car = mCar[1].trim();
      else if (mMsg && car) { out.push({ car, msg: mMsg[1].trim() }); car = null; }
    }
    return out;
  }
  async function loadScenarios() {
    try {
      const res = await fetch(encodeURIComponent('ゲームシナリオ') + '.txt', { cache: 'no-store' });
      if (res.ok) {
        const sc = parseScenarios(await res.text());
        if (sc.length) return sc;
      }
    } catch (_) { /* フォールバックへ */ }
    return [
      { car: 'nissan180sx3.vox', msg: '本部より緊急指令!管内で銀行強盗が発生した。逃亡中の白い日産180SXを追跡、確保せよ。' },
      { car: 'keitora03.vox', msg: '本部より緊急指令!管内で銅線ケーブルの盗難が発生した。逃亡している緑の軽トラを追跡、確保せよ。' },
      { car: 'nissan180sx2.vox', msg: '本部より緊急指令!管内で宝石店強盗が発生した。逃走中の赤い日産180SXを追跡、確保せよ。' },
      { car: 'nissan2.vox', msg: '本部より緊急指令!管内でひったくりが多発している。逃走中の青い日産セダンを追跡、確保せよ。' },
      { car: 'nissan3.vox', msg: '本部より緊急指令!管内で車上荒らしが発生した。逃走中の黄色い日産セダンを追跡、確保せよ。' },
    ];
  }

  function missionPopup(text, kind) {
    missionPopupEl.className = kind === 'caught' ? 'caught' : 'command';
    const head = kind === 'caught' ? 'CASE CLOSED' : '緊急指令 / EMERGENCY';
    missionPopupEl.innerHTML = '<span class="head"></span>';
    missionPopupEl.firstChild.textContent = head;
    missionPopupEl.appendChild(document.createTextNode(text));
    missionPopupEl.classList.add('show');
    clearTimeout(missionPopupTimer);
    missionPopupTimer = setTimeout(() => missionPopupEl.classList.remove('show'), kind === 'caught' ? 2800 : 6500);
  }
  function missionObjective(text) {
    if (text) { missionObjEl.textContent = '🚨 追跡中: ' + text; missionObjEl.classList.add('show'); }
    else missionObjEl.classList.remove('show');
  }
  function missionTargetLabel(msg) {
    const m = msg.match(/(?:逃亡中の|逃走中の|逃亡している)(.+?)を(?:追跡|確保)/);
    return m ? m[1] : '犯人車両';
  }
  function missionFindMesh(carFile) {
    const enc = encodeURIComponent(carFile);
    const hit = missionCpuCars.find((c) => c.url.endsWith(enc) || c.url.endsWith('/' + carFile));
    return (hit || missionCpuCars[0] || {}).mesh || null;
  }

  function missionIssue() {
    const idx = mission.queue.shift();
    const sc = missionScenarios[idx];
    const mesh = missionFindMesh(sc.car);
    if (!mesh || !missionRingWps) {              // 車両が無ければスキップして次へ
      mission.phase = mission.queue.length ? 'waiting' : 'done';
      mission.nextAt = performance.now() + 60000;
      return;
    }
    const wps = missionRingWps;
    const s = Math.floor(Math.random() * wps.length);
    const a = wps[s], b = wps[(s + 1) % wps.length];
    const g = makeCarGroup(mesh.clone(), false, false);
    const crim = {
      group: g.group, tilt: g.tilt,
      pos: new THREE.Vector3(a.x, 0, a.z),
      heading: Math.atan2(b.x - a.x, b.z - a.z), v: 0, base: 32,   // 32 m/s ≒ 115 km/h
      wps, idx: (s + 1) % wps.length, radius: carRadiusFor(false), criminal: true,
    };
    aiCars.push(crim);
    mission.active = crim;
    mission.phase = 'active';
    missionPopup(sc.msg, 'command');
    missionObjective(missionTargetLabel(sc.msg));
  }
  function missionCapture() {
    const c = mission.active;
    if (c) {
      scene.remove(c.group);
      const i = aiCars.indexOf(c);
      if (i >= 0) aiCars.splice(i, 1);
    }
    mission.active = null;
    missionPopup('犯人確保!', 'caught');
    missionObjective('');
    if (mission.queue.length) { mission.phase = 'waiting'; mission.nextAt = performance.now() + 60000; }
    else mission.phase = 'done';
  }
  function updateMission() {
    if (!missionEnabled || demoActive) return;
    if (mission.phase === 'waiting' && performance.now() >= mission.nextAt) missionIssue();
    else if (mission.phase === 'active' && mission.active) {
      const c = mission.active;
      const dx = player.pos.x - c.pos.x, dz = player.pos.z - c.pos.z;
      const reach = player.radius + c.radius + 1.2;   // 体当たりで確保
      if (dx * dx + dz * dz < reach * reach) missionCapture();
    }
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
      const turn = ai.criminal ? 2.2 : 1.7;   // 犯人はキビキビ曲がる
      ai.heading += clamp(diff, -turn * dt, turn * dt);

      // slow down for corners(犯人は減速控えめ)
      let target = ai.base * (1 - (ai.criminal ? 0.45 : 0.72) * Math.min(1, Math.abs(diff) * 1.4));
      if (ai.criminal) {
        // 逃走車は信号無視。加速はユーザー車の約1.5倍(≈18 m/s^2)に制限。
        const dv = target - ai.v;
        ai.v += clamp(dv, -40 * dt, 18 * dt);
      } else {
        // obey the signals: brake to a halt at the stop line on red/yellow
        const stop = aiStopDistance(ai, sigStates);
        let rate = 1.6;
        if (stop < 22) {
          target = Math.min(target, Math.max(0, (stop - 1.5) * 0.7));
          rate = 3.5;
        }
        ai.v += (target - ai.v) * Math.min(1, dt * rate);
      }
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
    updateMission();
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
