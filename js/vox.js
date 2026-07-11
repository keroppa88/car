/*
 * Minimal MagicaVoxel (.vox) parser + three.js mesh builder.
 * Supports: SIZE/XYZI/RGBA chunks and the nTRN/nGRP/nSHP scene graph
 * (translation + rotation), which is enough for models exported from
 * recent MagicaVoxel versions (VOX 150/200).
 */
(function (global) {
  'use strict';

  function readDict(dv, pos) {
    const n = dv.getInt32(pos, true); pos += 4;
    const dict = {};
    for (let i = 0; i < n; i++) {
      const kl = dv.getInt32(pos, true); pos += 4;
      let k = '';
      for (let j = 0; j < kl; j++) k += String.fromCharCode(dv.getUint8(pos + j));
      pos += kl;
      const vl = dv.getInt32(pos, true); pos += 4;
      let v = '';
      for (let j = 0; j < vl; j++) v += String.fromCharCode(dv.getUint8(pos + j));
      pos += vl;
      dict[k] = v;
    }
    return [dict, pos];
  }

  // Decode MagicaVoxel packed rotation byte into a 3x3 matrix (row major).
  function decodeRotation(byte) {
    const r = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const i0 = byte & 3;
    const i1 = (byte >> 2) & 3;
    const i2 = 3 - i0 - i1;
    r[0][i0] = (byte & 16) ? -1 : 1;
    r[1][i1] = (byte & 32) ? -1 : 1;
    r[2][i2] = (byte & 64) ? -1 : 1;
    return r;
  }

  const IDENTITY = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

  function mulMat(a, b) {
    const o = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        o[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
    return o;
  }

  function mulVec(m, v) {
    return [
      m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
      m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
      m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ];
  }

  function parse(buffer) {
    const dv = new DataView(buffer);
    const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    if (magic !== 'VOX ') throw new Error('Not a VOX file');

    const models = [];
    const nodes = {};
    let palette = null;
    let pendingSize = null;

    // MAIN chunk header
    let pos = 8;
    const mainContent = dv.getInt32(pos + 4, true);
    const mainChildren = dv.getInt32(pos + 8, true);
    pos += 12 + mainContent;
    const end = pos + mainChildren;

    while (pos < end) {
      const id = String.fromCharCode(dv.getUint8(pos), dv.getUint8(pos + 1), dv.getUint8(pos + 2), dv.getUint8(pos + 3));
      const contentLen = dv.getInt32(pos + 4, true);
      const childLen = dv.getInt32(pos + 8, true);
      let p = pos + 12;

      if (id === 'SIZE') {
        pendingSize = {
          x: dv.getInt32(p, true),
          y: dv.getInt32(p + 4, true),
          z: dv.getInt32(p + 8, true),
        };
      } else if (id === 'XYZI') {
        const count = dv.getInt32(p, true);
        models.push({
          size: pendingSize || { x: 0, y: 0, z: 0 },
          voxels: new Uint8Array(buffer, p + 4, count * 4),
          count,
        });
      } else if (id === 'RGBA') {
        palette = new Uint8Array(buffer, p, 256 * 4);
      } else if (id === 'nTRN') {
        const nodeId = dv.getInt32(p, true); p += 4;
        let d; [d, p] = readDict(dv, p);
        const childId = dv.getInt32(p, true); p += 4;
        p += 8; // reserved + layer
        const numFrames = dv.getInt32(p, true); p += 4;
        let t = [0, 0, 0];
        let r = IDENTITY;
        if (numFrames > 0) {
          let f; [f, p] = readDict(dv, p);
          if (f._t) t = f._t.split(' ').map(Number);
          if (f._r) r = decodeRotation(parseInt(f._r, 10));
        }
        nodes[nodeId] = { type: 'trn', childId, t, r };
      } else if (id === 'nGRP') {
        const nodeId = dv.getInt32(p, true); p += 4;
        let d; [d, p] = readDict(dv, p);
        const n = dv.getInt32(p, true); p += 4;
        const children = [];
        for (let i = 0; i < n; i++) { children.push(dv.getInt32(p, true)); p += 4; }
        nodes[nodeId] = { type: 'grp', children };
      } else if (id === 'nSHP') {
        const nodeId = dv.getInt32(p, true); p += 4;
        let d; [d, p] = readDict(dv, p);
        const n = dv.getInt32(p, true); p += 4;
        const modelIds = [];
        for (let i = 0; i < n; i++) {
          modelIds.push(dv.getInt32(p, true)); p += 4;
          let ma; [ma, p] = readDict(dv, p);
        }
        nodes[nodeId] = { type: 'shp', modelIds };
      }

      pos += 12 + contentLen + childLen;
    }

    // Flatten scene graph into model instances (rotation + translation).
    const instances = [];
    function walk(nodeId, rot, trans) {
      const node = nodes[nodeId];
      if (!node) return;
      if (node.type === 'trn') {
        const r = mulMat(rot, node.r);
        const rt = mulVec(rot, node.t);
        walk(node.childId, r, [trans[0] + rt[0], trans[1] + rt[1], trans[2] + rt[2]]);
      } else if (node.type === 'grp') {
        for (const c of node.children) walk(c, rot, trans);
      } else if (node.type === 'shp') {
        for (const m of node.modelIds) {
          if (models[m] && models[m].count > 0) instances.push({ model: m, r: rot, t: trans });
        }
      }
    }
    if (nodes[0]) {
      walk(0, IDENTITY, [0, 0, 0]);
    } else {
      models.forEach((m, i) => { if (m.count > 0) instances.push({ model: i, r: IDENTITY, t: [0, 0, 0] }); });
    }

    return { models, palette, instances };
  }

  // Face table in MagicaVoxel space (z-up). `s` is a baked shading factor.
  const FACES = [
    { n: [1, 0, 0], c: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]], s: 0.80 },
    { n: [-1, 0, 0], c: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]], s: 0.80 },
    { n: [0, 1, 0], c: [[1, 1, 0], [0, 1, 0], [0, 1, 1], [1, 1, 1]], s: 0.88 },
    { n: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], s: 0.88 },
    { n: [0, 0, 1], c: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], s: 1.00 },
    { n: [0, 0, -1], c: [[0, 1, 0], [1, 1, 0], [1, 0, 0], [0, 0, 0]], s: 0.55 },
  ];

  const KEY_OFF = 512;
  function key(x, y, z) {
    return (x + KEY_OFF) | ((y + KEY_OFF) << 10) | ((z + KEY_OFF) << 20);
  }

  /*
   * Build a single merged THREE.Mesh from parsed vox data.
   * The mesh is converted to three.js Y-up, centered on X/Z and rests on y=0.
   */
  function buildMesh(data, opts) {
    opts = opts || {};
    const scale = opts.scale || 0.1;

    const vox = new Map(); // key -> palette index
    for (const inst of data.instances) {
      const model = data.models[inst.model];
      const px = Math.floor(model.size.x / 2);
      const py = Math.floor(model.size.y / 2);
      const pz = Math.floor(model.size.z / 2);
      const v = model.voxels;
      for (let i = 0; i < model.count; i++) {
        const lx = v[i * 4] - px, ly = v[i * 4 + 1] - py, lz = v[i * 4 + 2] - pz;
        const w = mulVec(inst.r, [lx, ly, lz]);
        vox.set(key(w[0] + inst.t[0], w[1] + inst.t[1], w[2] + inst.t[2]), v[i * 4 + 3]);
      }
    }

    // Palette (sRGB -> linear), MagicaVoxel color index i maps to palette[i-1].
    const pal = new Float32Array(256 * 3);
    const c = new THREE.Color();
    for (let i = 0; i < 256; i++) {
      if (data.palette) {
        c.setRGB(data.palette[i * 4] / 255, data.palette[i * 4 + 1] / 255, data.palette[i * 4 + 2] / 255);
      } else {
        c.setRGB(0.8, 0.8, 0.8);
      }
      c.convertSRGBToLinear();
      pal[i * 3] = c.r; pal[i * 3 + 1] = c.g; pal[i * 3 + 2] = c.b;
    }

    const positions = [];
    const normals = [];
    const colors = [];
    const indices = [];

    for (const [k, ci] of vox) {
      const x = (k & 1023) - KEY_OFF;
      const y = ((k >> 10) & 1023) - KEY_OFF;
      const z = ((k >> 20) & 1023) - KEY_OFF;
      const pi = (ci - 1) & 255;
      const r = pal[pi * 3], g = pal[pi * 3 + 1], b = pal[pi * 3 + 2];
      for (const f of FACES) {
        if (vox.has(key(x + f.n[0], y + f.n[1], z + f.n[2]))) continue;
        const base = positions.length / 3;
        for (const corner of f.c) {
          positions.push(x + corner[0], y + corner[1], z + corner[2]);
          normals.push(f.n[0], f.n[1], f.n[2]);
          colors.push(r * f.s, g * f.s, b * f.s);
        }
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);

    geo.rotateX(-Math.PI / 2);       // MagicaVoxel z-up -> three.js y-up
    geo.scale(scale, scale, scale);
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    geo.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
    geo.computeBoundingBox();
    geo.computeBoundingSphere();

    const mat = opts.material || new THREE.MeshLambertMaterial({ vertexColors: true });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  async function load(url, opts) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Failed to load ' + url + ' (' + res.status + ')');
    const buf = await res.arrayBuffer();
    return buildMesh(parse(buf), opts);
  }

  global.VOX = { parse, buildMesh, load };
})(this);
