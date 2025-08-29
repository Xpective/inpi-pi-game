// three-scene.js — Three.js Pi-Pyramid Visualizer
import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";

let renderer, scene, camera, animHandle;
let sphere, instancedPegs;
let initialized = false;

const PI_DIGITS = (
  "3141592653589793238462643383279502884197169399375105820974944592" +
  "3078164062862089986280348253421170679"
);

// Simple xorshift PRNG aus hex-Seed
function makePRNG(hex) {
  let x = parseInt(hex.slice(0, 8), 16) || 123456789;
  let y = parseInt(hex.slice(8, 16), 16) || 362436069;
  let z = parseInt(hex.slice(16, 24), 16) || 521288629;
  let w = parseInt(hex.slice(24, 32), 16) || 88675123;
  return function() {
    const t = x ^ (x << 11);
    x = y; y = z; z = w;
    w = (w ^ (w >>> 19)) ^ (t ^ (t >>> 8));
    return (w >>> 0) / 0xFFFFFFFF;
  };
}

// Baue Pi-Pyramiden-Geometrie als InstancedMesh (performant)
function buildPyramid({ visibleRows }) {
  if (instancedPegs) scene.remove(instancedPegs);

  const pegGeo = new THREE.BoxGeometry(0.28, 0.06, 0.28);
  const pegMat = new THREE.MeshStandardMaterial({
    color: 0x88ccff,
    metalness: 0.3,
    roughness: 0.35,
    emissive: new THREE.Color(0x0d1b2a),
    emissiveIntensity: 0.15
  });

  let count = 0;
  for (let r = 0; r < visibleRows; r++) {
    const digit = Number(PI_DIGITS[r % PI_DIGITS.length]);
    count += Math.max(1, digit);
  }

  instancedPegs = new THREE.InstancedMesh(pegGeo, pegMat, count);
  const m = new THREE.Matrix4();
  let i = 0;

  const X_SPACING = 0.35;
  const Y_SPACING = 0.35;

  for (let r = 0; r < visibleRows; r++) {
    const n = Math.max(1, Number(PI_DIGITS[r % PI_DIGITS.length]));
    const rowWidth = (n - 1) * X_SPACING;
    for (let c = 0; c < n; c++) {
      const x = -rowWidth / 2 + c * X_SPACING;
      const y = -r * Y_SPACING;
      m.makeTranslation(x, y, 0);
      instancedPegs.setMatrixAt(i++, m);
    }
  }
  instancedPegs.instanceMatrix.needsUpdate = true;
  scene.add(instancedPegs);
}

// Kugel (Token)
function buildToken() {
  if (sphere) scene.remove(sphere);
  const geo = new THREE.SphereGeometry(0.14, 24, 24);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffd166,
    metalness: 0.6,
    roughness: 0.25,
    emissive: new THREE.Color(0x1f1100),
    emissiveIntensity: 0.25
  });
  sphere = new THREE.Mesh(geo, mat);
  sphere.position.set(0, 0.25, 0.12);
  scene.add(sphere);
}

function glowWinPulse(won) {
  if (!instancedPegs || !won) return;
  const mat = instancedPegs.material;
  let t = 0;
  const id = setInterval(() => {
    t += 0.05;
    const s = 0.15 + Math.sin(t * 6) * 0.12;
    mat.emissiveIntensity = THREE.MathUtils.clamp(s, 0.1, 0.4);
    if (t > 2.4) { clearInterval(id); mat.emissiveIntensity = 0.15; }
  }, 16);
}

function setupLights() {
  const hemi = new THREE.HemisphereLight(0xffffff, 0x111111, 0.8);
  hemi.position.set(0, 1, 0);
  scene.add(hemi);

  const dir = new THREE.DirectionalLight(0xffffff, 0.6);
  dir.position.set(2, 3, 2);
  scene.add(dir);
}

function setupRenderer() {
  const stage = document.getElementById("stage");
  if (!stage) return;

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(stage.clientWidth, stage.clientHeight);
  stage.innerHTML = "";
  stage.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(45, stage.clientWidth / stage.clientHeight, 0.1, 100);
  camera.position.set(0, 2.4, 6.0);
  camera.lookAt(0, -2.2, 0);

  setupLights();

  window.addEventListener("resize", () => {
    renderer.setSize(stage.clientWidth, stage.clientHeight);
    camera.aspect = stage.clientWidth / stage.clientHeight;
    camera.updateProjectionMatrix();
  });

  initialized = true;
}

function computePath({ seed, rows }) {
  const rnd = makePRNG(seed);
  const X_SPACING = 0.35;
  const Y_SPACING = 0.35;

  const path = [];
  for (let r = 0; r < rows; r++) {
    const n = Math.max(1, Number(PI_DIGITS[r % PI_DIGITS.length]));
    const col = Math.floor(rnd() * n);
    const rowWidth = (n - 1) * X_SPACING;
    const targetX = -rowWidth / 2 + col * X_SPACING;
    const targetY = -r * Y_SPACING;
    path.push({ x: targetX, y: targetY });
  }
  return path;
}

function animatePath(path, won) {
  if (!sphere) return;
  let idx = 0;
  const speed = 0.06;

  const loop = () => {
    animHandle = requestAnimationFrame(loop);
    if (idx >= path.length) return;

    const p = path[idx];
    sphere.position.x = THREE.MathUtils.lerp(sphere.position.x, p.x, speed);
    sphere.position.y = THREE.MathUtils.lerp(sphere.position.y, p.y + 0.25, speed);
    sphere.rotation.y += 0.02;

    if (Math.abs(sphere.position.x - p.x) < 0.01 && Math.abs(sphere.position.y - (p.y + 0.25)) < 0.01) {
      idx++;
    }
    renderer.render(scene, camera);

    if (idx === path.length) glowWinPulse(won);
  };
  loop();
}

export function runPiRoll({ seed, rows=400, visibleRows=400, won=false }) {
  try {
    const vr = Math.min(visibleRows, 400);
    const rr = Math.min(rows, 400);

    if (!initialized) setupRenderer();
    else {
      cancelAnimationFrame(animHandle);
      while (scene.children.length) scene.remove(scene.children[0]);
      setupLights();
    }

    buildPyramid({ visibleRows: vr });
    buildToken();

    const path = computePath({ seed, rows: rr });
    animatePath(path.slice(0, vr), won);
  } catch (e) {
    console.error("Three scene error:", e);
  }
}