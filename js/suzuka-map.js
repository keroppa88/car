import * as THREE from 'three';

// Twice the previous overall course size (0.75 -> 1.5).
const COURSE_SCALE = 1.5;
const HORIZONTAL_SCALE = 10.388305115;
// With COURSE_SCALE=1.5, 7.056 * 1.5 = 10.584 m in world space.
// This is 1.5x the immediately previous width and 2.94x the original 3.6 m road.
export const SUZUKA_TRACK_WIDTH = 3.2 * 1.47 * 1.5;
const EDGE_LINE_WIDTH = 0.10;
const SHOULDER_WIDTH = 30.0;
const SHOULDER_MAX_HEIGHT = 7.0;
const TRACK_HEIGHT_OFFSET = 0.1451;
const SAMPLES_PER_SECTION = 48;

// Centre-line trace follows the supplied numbered Suzuka reference (1-17).
// Extra samples around the hairpin and Spoon reproduce the bends in the image.
const CONTROL_POINTS = [
  [45.9, .12, -21.4], [47.4, .12, -14.1], [36.4, .12, -15.0],
  [32.2, .12, -11.3], [24.6, .12, -13.3], [17.6, .12, -8.9],
  [6.6, .20, -13.8], [2.3, .15, 4.6],
  // 8-9: follow the marked red hook instead of cutting across diagonally.
  [2.4, .15, 7.0], [3.5, .12, 8.1], [1.0, .10, 10.0], [-2.5, .10, 10.8],
  [-15.3, .10, 4.1],
  // 11: compact U-turn; the exit follows the marked red diagonal and then
  // straightens vertically, without the yellow inward detour.
  [-18.9, .10, 1.5], [-21.3, .10, -.5], [-23.1, .10, -1.0],
  [-24.1, .10, -.1], [-22.5, .25, 3.0], [-20.2, .75, 6.5],
  [-18.8, 1.30, 8.5], [-18.8, 1.80, 11.7], [-23.0, 2.20, 16.5],
  [-32.0, 2.80, 20.0], [-42.0, 3.40, 18.0], [-47.5, 3.80, 23.0],
  [-43.0, 4.00, 26.0], [-34.0, 4.10, 25.0], [-24.0, 4.20, 21.0],
  [-14.0, 4.20, 15.0], [-4.1, 4.20, 7.3], [-3.4, 1.20, -7.8],
  // 15-16: right-angle right, then an immediate right-angle left.
  // The short link between the two corners is half its previous length.
  [-3.1, .30, -11.6], [-3.0, .30, -13.2], [-2.8, .30, -13.4],
  [-0.6, .30, -13.4], [-0.4, .30, -13.6], [-0.4, .30, -16.6],
  // 17: one continuous right-hander onto the home straight.  Z approaches
  // the straight monotonically so there is no opposite-direction flick.
  [1.5, .30, -18.5], [4.0, .30, -20.0], [7.5, .25, -21.0],
  [12.0, .20, -21.4], [18.0, .17, -21.5], [26.0, .15, -21.5], [36.0, .12, -21.45],
].map(([x, y, z]) => new THREE.Vector3(x, y, z));

function sampleClosedTrack() {
  // Centripetal interpolation prevents unevenly spaced right-angle controls
  // from overshooting into a loop. Even arc-length sampling keeps the road
  // strip triangles short and regular through tight bends.
  const curve = new THREE.CatmullRomCurve3(CONTROL_POINTS, true, 'centripetal');
  const samples = curve.getSpacedPoints(CONTROL_POINTS.length * SAMPLES_PER_SECTION);
  samples.pop();
  for (const p of samples) {
    p.x *= HORIZONTAL_SCALE; p.z *= HORIZONTAL_SCALE; p.y = Math.max(0, p.y - TRACK_HEIGHT_OFFSET);
  }
  return samples;
}

function trackSide(samples, index) {
  const count = samples.length, previous = samples[(index - 1 + count) % count], following = samples[(index + 1) % count];
  const tangent = new THREE.Vector3(following.x - previous.x, 0, following.z - previous.z).normalize();
  return new THREE.Vector3(-tangent.z, 0, tangent.x);
}

function trackOffset(samples, index, distance, miterLimit = 1.7) {
  if (Math.abs(distance) < 1e-6) return new THREE.Vector3();
  const count = samples.length, p = samples[index];
  const previous = samples[(index - 1 + count) % count], following = samples[(index + 1) % count];
  const incoming = p.clone().sub(previous); incoming.y = 0; incoming.normalize();
  const outgoing = following.clone().sub(p); outgoing.y = 0; outgoing.normalize();
  const sideIn = new THREE.Vector3(-incoming.z, 0, incoming.x);
  const sideOut = new THREE.Vector3(-outgoing.z, 0, outgoing.x);
  const miter = sideIn.add(sideOut);
  if (miter.lengthSq() < 1e-8) return sideOut.multiplyScalar(distance);
  miter.normalize();
  const denominator = miter.dot(sideOut);
  if (Math.abs(denominator) < 1e-4) return sideOut.multiplyScalar(distance);
  const limit = Math.abs(distance) * miterLimit;
  const length = THREE.MathUtils.clamp(distance / denominator, -limit, limit);
  return miter.multiplyScalar(length);
}

function makeRibbon(samples, offset, width, lift, material, name) {
  const positions = [], uvs = [], indices = [], count = samples.length;
  for (let i = 0; i < count; i++) {
    const previous = samples[(i - 1 + count) % count], following = samples[(i + 1) % count];
    const tangent = following.clone().sub(previous).normalize(), side = trackSide(samples, i);
    const normal = side.clone().cross(tangent).normalize(); if (normal.y < 0) normal.negate();
    const center = samples[i].clone().addScaledVector(normal, lift);
    const left = center.clone().add(trackOffset(samples, i, offset - width * .5));
    const right = center.clone().add(trackOffset(samples, i, offset + width * .5));
    positions.push(left.x,left.y,left.z,right.x,right.y,right.z); uvs.push(0,i*.25,1,i*.25);
  }
  for (let i = 0; i < count; i++) {
    const next = (i+1)%count, left=i*2, right=left+1, nextLeft=next*2, nextRight=nextLeft+1;
    indices.push(left,nextRight,right,left,nextLeft,nextRight);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs,2));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry,material); mesh.name=name; mesh.receiveShadow=true; return mesh;
}

function isTunnelOpening(p,q) {
  const x=(p.x+q.x)*.5,y=(p.y+q.y)*.5,z=(p.z+q.z)*.5;
  return y>1.8 && Math.hypot(x+60,z-102)<55;
}

function makeShoulders(samples,material) {
  const positions=[],indices=[];
  for (const sideSign of [-1,1]) for (let i=0;i<samples.length;i++) {
    const next=(i+1)%samples.length,p=samples[i],q=samples[next];
    if (Math.max(p.y,q.y)<=.02 || Math.max(p.y,q.y)>SHOULDER_MAX_HEIGHT || isTunnelOpening(p,q)) continue;
    const innerP=p.clone().add(trackOffset(samples,i,sideSign*SUZUKA_TRACK_WIDTH*.5));
    const innerQ=q.clone().add(trackOffset(samples,next,sideSign*SUZUKA_TRACK_WIDTH*.5));
    const outerP=p.clone().add(trackOffset(samples,i,sideSign*(SUZUKA_TRACK_WIDTH*.5+SHOULDER_WIDTH),1.25));
    const outerQ=q.clone().add(trackOffset(samples,next,sideSign*(SUZUKA_TRACK_WIDTH*.5+SHOULDER_WIDTH),1.25));
    outerP.y=-.08; outerQ.y=-.08; const base=positions.length/3;
    for (const v of [innerP,outerP,outerQ,innerQ]) positions.push(v.x,v.y,v.z);
    indices.push(base,base+1,base+2,base,base+2,base+3);
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  const mesh=new THREE.Mesh(geometry,material); mesh.name='DriveableShoulders'; mesh.receiveShadow=true; return mesh;
}

function addQuad(positions,indices,a,b,c,d) {
  const base=positions.length/3;
  for (const v of [a,b,c,d]) positions.push(v.x,v.y,v.z);
  indices.push(base,base+1,base+2,base,base+2,base+3);
}

function makeStructureMesh(positions,indices,material,name) {
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  const mesh=new THREE.Mesh(geometry,material); mesh.name=name;
  mesh.castShadow=mesh.receiveShadow=true; return mesh;
}

function nearCrossover(p,q,radius) {
  const x=(p.x+q.x)*.5,z=(p.z+q.z)*.5;
  return Math.hypot(x+60,z-102)<radius;
}

function makeBridgeSafetyWalls(samples,material) {
  const positions=[],indices=[],wallHeight=.9,edge=SUZUKA_TRACK_WIDTH*.5+.12;
  for (let i=0;i<samples.length;i++) {
    const next=(i+1)%samples.length,p=samples[i],q=samples[next];
    if (Math.min(p.y,q.y)<1.2 || !nearCrossover(p,q,88)) continue;
    const sideP=trackSide(samples,i),sideQ=trackSide(samples,next);
    for (const sign of [-1,1]) {
      const a=p.clone().addScaledVector(sideP,sign*edge); a.y+=.04;
      const b=q.clone().addScaledVector(sideQ,sign*edge); b.y+=.04;
      const c=b.clone(); c.y+=wallHeight;
      const d=a.clone(); d.y+=wallHeight;
      addQuad(positions,indices,a,b,c,d);
    }
  }
  return makeStructureMesh(positions,indices,material,'BridgeSafetyWalls');
}

function makeBridgeDeck(samples,material) {
  const positions=[],indices=[],edge=SUZUKA_TRACK_WIDTH*.5+.3,thickness=.38;
  for (let i=0;i<samples.length;i++) {
    const next=(i+1)%samples.length,p=samples[i],q=samples[next];
    if (Math.min(p.y,q.y)<1.8 || !nearCrossover(p,q,78)) continue;
    const sideP=trackSide(samples,i),sideQ=trackSide(samples,next);
    const pl=p.clone().addScaledVector(sideP,-edge),pr=p.clone().addScaledVector(sideP,edge);
    const ql=q.clone().addScaledVector(sideQ,-edge),qr=q.clone().addScaledVector(sideQ,edge);
    const bpl=pl.clone(),bpr=pr.clone(),bql=ql.clone(),bqr=qr.clone();
    for (const v of [bpl,bpr,bql,bqr]) v.y-=thickness;
    addQuad(positions,indices,bpl,bql,bqr,bpr);
    addQuad(positions,indices,pl,bpl,bql,ql);
    addQuad(positions,indices,pr,qr,bqr,bpr);
  }
  return makeStructureMesh(positions,indices,material,'BridgeDeck');
}

function nearestSampleIndex(samples,x,z) {
  let best=0,bestDistance=Infinity;
  for (let i=0;i<samples.length;i++) {
    const distance=(samples[i].x-x)**2+(samples[i].z-z)**2;
    if (distance<bestDistance) { best=i; bestDistance=distance; }
  }
  return best;
}

export function buildSuzukaMap(scene) {
  const asphalt=new THREE.MeshLambertMaterial({color:0x1b1d20,side:THREE.DoubleSide});
  const whitePaint=new THREE.MeshLambertMaterial({color:0xf5f5eb,side:THREE.DoubleSide});
  const grass=new THREE.MeshBasicMaterial({color:0x1a4713,side:THREE.DoubleSide});
  const concrete=new THREE.MeshLambertMaterial({color:0x777a7d,side:THREE.DoubleSide});

  const samples=sampleClosedTrack(),root=new THREE.Group(); root.name='SuzukaTrack'; root.scale.setScalar(COURSE_SCALE);
  root.add(makeShoulders(samples,grass));
  root.add(makeRibbon(samples,0,SUZUKA_TRACK_WIDTH,.008,asphalt,'Asphalt'));
  const edgeOffset=SUZUKA_TRACK_WIDTH*.5-EDGE_LINE_WIDTH*.5;
  root.add(makeRibbon(samples,-edgeOffset,EDGE_LINE_WIDTH,.018,whitePaint,'LeftEdge'));
  root.add(makeRibbon(samples,edgeOffset,EDGE_LINE_WIDTH,.018,whitePaint,'RightEdge'));
  root.add(makeBridgeDeck(samples,concrete));
  root.add(makeBridgeSafetyWalls(samples,concrete));

  const startIndex=nearestSampleIndex(samples,311.66155,-224.1023);
  const startCenter=samples[startIndex],startSide=trackSide(samples,startIndex);
  const startLine=new THREE.Mesh(new THREE.BoxGeometry(.32,.025,SUZUKA_TRACK_WIDTH-.04),whitePaint);
  startLine.name='StartFinishLine'; startLine.position.copy(startCenter); startLine.position.y+=.021;
  startLine.rotation.y=Math.atan2(startSide.x,startSide.z); root.add(startLine);
  const spawn=new THREE.Object3D();
  spawn.name='spawn'; spawn.position.copy(samples[startIndex]); const next=samples[(startIndex+1)%samples.length];
  spawn.rotation.y=Math.atan2(next.x-spawn.position.x,next.z-spawn.position.z); root.add(spawn);
  scene.add(root); root.updateMatrixWorld(true);
  const raceLoop=[];
  for (let i=0;i<samples.length;i+=18) {
    const p=samples[i].clone().addScaledVector(trackSide(samples,i),-SUZUKA_TRACK_WIDTH*.18).multiplyScalar(COURSE_SCALE);
    raceLoop.push({i:raceLoop.length,p});
  }
  return {root,spawn,loops:{race:raceLoop},demoRoute:raceLoop.map(({p})=>({x:p.x,z:p.z}))};
}
