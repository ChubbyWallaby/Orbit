// three.js renderer for Orbit. Pure view: it draws what the React layer tells it to.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { constrainMoon, indexAt, MOON_MIRROR_OFFSET, SATELLITE_RADIUS, type Level, type Placement, type Ray, type TraceResult, type Vec } from './engine';

const NOISE = `
float h3(vec3 p){ p = fract(p*0.3183099+.1); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float n3(vec3 x){ vec3 i=floor(x), f=fract(x); f=f*f*(3.0-2.0*f);
  return mix(mix(mix(h3(i),h3(i+vec3(1,0,0)),f.x),mix(h3(i+vec3(0,1,0)),h3(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(h3(i+vec3(0,0,1)),h3(i+vec3(1,0,1)),f.x),mix(h3(i+vec3(0,1,1)),h3(i+vec3(1,1,1)),f.x),f.y),f.z); }
float fbm(vec3 p){ float v=0., a=.5; for(int i=0;i<5;i++){ v+=a*n3(p); p*=2.03; a*=.5; } return v; }`;

const SUN = new THREE.Vector3(-0.6, 0.55, 0.45).normalize();
const LASER = new THREE.Color(0xff4f6e);
const BEACON = 0x5cf2c0;
const MIRROR = 0xa9d8ff;
const hdr = (c: number, k: number) => new THREE.Color(c).multiplyScalar(k);

type Drag = 'moon' | 'satellite';
export type SceneCallbacks = { onDrag: (which: Drag, pos: Vec) => void };

/** Colour palettes (light band, dark band, accent, poles) and self-glow for each planet style. */
const PALETTES: Record<string, { c: [string, string, string, string]; halo: [number, number, number]; glow: number }> = {
  amber: { c: ['vec3(0.93,0.78,0.55)', 'vec3(0.62,0.27,0.12)', 'vec3(0.82,0.52,0.22)', 'vec3(0.32,0.14,0.08)'], halo: [1, 0.55, 0.25], glow: 0 },
  ice: { c: ['vec3(0.80,0.94,0.98)', 'vec3(0.22,0.50,0.66)', 'vec3(0.50,0.80,0.88)', 'vec3(0.10,0.22,0.34)'], halo: [0.5, 0.85, 1], glow: 0 },
  lava: { c: ['vec3(1.00,0.52,0.16)', 'vec3(0.18,0.05,0.04)', 'vec3(0.85,0.22,0.05)', 'vec3(0.08,0.02,0.02)'], halo: [1, 0.35, 0.12], glow: 0.55 },
  toxic: { c: ['vec3(0.86,0.95,0.45)', 'vec3(0.25,0.42,0.10)', 'vec3(0.60,0.80,0.22)', 'vec3(0.10,0.18,0.05)'], halo: [0.7, 1, 0.35], glow: 0.08 },
  violet: { c: ['vec3(0.88,0.75,0.98)', 'vec3(0.36,0.18,0.58)', 'vec3(0.62,0.42,0.86)', 'vec3(0.14,0.06,0.25)'], halo: [0.75, 0.5, 1], glow: 0 },
  blue: { c: ['vec3(0.62,0.80,0.92)', 'vec3(0.18,0.32,0.55)', 'vec3(0.40,0.60,0.78)', 'vec3(0.08,0.12,0.25)'], halo: [0.4, 0.7, 1], glow: 0 },
  rose: { c: ['vec3(0.98,0.78,0.80)', 'vec3(0.62,0.25,0.34)', 'vec3(0.86,0.50,0.58)', 'vec3(0.25,0.08,0.12)'], halo: [1, 0.55, 0.65], glow: 0 },
  jade: { c: ['vec3(0.70,0.95,0.84)', 'vec3(0.12,0.42,0.34)', 'vec3(0.38,0.74,0.60)', 'vec3(0.05,0.18,0.15)'], halo: [0.45, 1, 0.8], glow: 0 },
  sand: { c: ['vec3(0.95,0.88,0.70)', 'vec3(0.60,0.48,0.30)', 'vec3(0.82,0.70,0.48)', 'vec3(0.30,0.24,0.14)'], halo: [1, 0.85, 0.6], glow: 0 },
};

function planetMaterial(style: string, seed: number) {
  const pal = PALETTES[style] ?? PALETTES.amber;
  const [light, dark, accent, poles] = pal.c;
  return new THREE.ShaderMaterial({
    uniforms: { uSun: { value: SUN }, uT: { value: 0 }, uSeed: { value: seed }, uGlow: { value: pal.glow } },
    vertexShader: `varying vec3 vN; varying vec3 vP; varying vec3 vW;
      void main(){ vP = position; vN = normalize(mat3(modelMatrix)*normal); vec4 w = modelMatrix*vec4(position,1.); vW = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`,
    fragmentShader: NOISE + `uniform vec3 uSun; uniform float uT; uniform float uSeed; uniform float uGlow; varying vec3 vN; varying vec3 vP; varying vec3 vW;
      void main(){
        vec3 p = normalize(vP); float lat = p.y;
        float warp = fbm(vec3(p.x*3.0 + uT*0.03 + uSeed, p.y*9.0, p.z*3.0)) * 0.9;
        float b = sin(lat*(18.0+uSeed*0.4) + warp*4.0) * 0.5 + 0.5;
        float b2 = sin(lat*57.0 + warp*7.0) * 0.5 + 0.5;
        vec3 c = mix(${dark}, ${light}, b); c = mix(c, ${accent}, b2*0.45);
        c = mix(c, ${poles}, smoothstep(0.75,1.0,abs(lat))*0.6);
        float diff = clamp(dot(vN, uSun), 0.0, 1.0);
        vec3 V = normalize(cameraPosition - vW);
        float rim = pow(1.0 - clamp(dot(vN, V),0.,1.), 3.0);
        // molten cracks glow on the night side of lava worlds
        float cracks = smoothstep(0.62, 0.7, fbm(p*6.0 + uSeed)) * uGlow;
        vec3 col = c*(0.05+0.82*diff) + ${light}*rim*0.22*(0.3+diff) + vec3(1.0,0.4,0.1)*cracks*(1.2-diff);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
}

function haloMaterial(color: THREE.Color) {
  return new THREE.ShaderMaterial({
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide,
    uniforms: { uSun: { value: SUN }, uC: { value: color } },
    vertexShader: `varying vec3 vN; varying vec3 vW; void main(){ vN = normalize(mat3(modelMatrix)*normal); vec4 w = modelMatrix*vec4(position,1.); vW=w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`,
    fragmentShader: `uniform vec3 uSun; uniform vec3 uC; varying vec3 vN; varying vec3 vW; void main(){
      vec3 V = normalize(cameraPosition - vW); float f = pow(clamp(1.0 - abs(dot(vN, V)), 0., 1.), 2.2);
      float l = 0.35 + 0.65*clamp(dot(-vN, uSun)*0.5+0.6, 0., 1.);
      gl_FragColor = vec4(uC*f*0.45*l, f); }`,
  });
}

function craterTexture() {
  const c = document.createElement('canvas'); c.width = 512; c.height = 256;
  const g = c.getContext('2d')!; g.fillStyle = '#8d8a86'; g.fillRect(0, 0, 512, 256);
  for (let i = 0; i < 1400; i++) { g.fillStyle = `rgba(${Math.random() < 0.5 ? '255,255,255' : '0,0,0'},${Math.random() * 0.06})`; g.fillRect(Math.random() * 512, Math.random() * 256, 3 + Math.random() * 16, 2 + Math.random() * 8); }
  for (let i = 0; i < 70; i++) {
    const x = Math.random() * 512, y = 20 + Math.random() * 216, r = 2 + Math.pow(Math.random(), 3) * 24;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fillStyle = 'rgba(40,38,36,0.35)'; g.fill();
    g.beginPath(); g.arc(x - r * 0.15, y - r * 0.15, r * 0.8, 0, Math.PI * 2); g.fillStyle = 'rgba(200,196,190,0.18)'; g.fill();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

function mirrorPanel(length: number) {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.0, length), new THREE.MeshPhysicalMaterial({ color: 0xd8ecff, metalness: 0.9, roughness: 0.06, clearcoat: 1, emissive: 0x3a6c99, emissiveIntensity: 0.55 })));
  g.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(0.12, 1.02, length + 0.02)), new THREE.LineBasicMaterial({ color: hdr(MIRROR, 2.2), toneMapped: false })));
  return g;
}

/** Two crossed ribbons per segment (12 indices each, so draw ranges map to point indices). */
function beamGeometry(pts: (Vec & { jump?: boolean })[]) {
  const w = 0.11, pos: number[] = [], idx: number[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    // a wormhole jump draws nothing: collapse the segment to a point
    const b = pts[i + 1].jump ? a : pts[i + 1];
    let dx = b.x - a.x, dz = b.z - a.z; const l = Math.hypot(dx, dz);
    if (l < 1e-6) { dx = 1; dz = 0; } else { dx /= l; dz /= l; }
    const ww = l < 1e-6 ? 0 : w;
    for (const o of [[-dz * ww, 0, dx * ww], [0, ww, 0]]) {
      const base = pos.length / 3;
      pos.push(a.x - o[0], -o[1], a.z - o[2], a.x + o[0], o[1], a.z + o[2], b.x - o[0], -o[1], b.z - o[2], b.x + o[0], o[1], b.z + o[2]);
      idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
  return g;
}

export class OrbitScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(48, 1, 0.1, 2000);
  private controls: OrbitControls;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private level: Level | null = null;
  private levelGroup = new THREE.Group();
  private animated: { tick: (t: number, dt: number) => void }[] = [];
  private moon = new THREE.Group();
  private moonMirror = new THREE.Group();
  private moonPick = new THREE.Mesh();
  private sat = new THREE.Group();
  private satMirror = new THREE.Group();
  private satPick = new THREE.Mesh();
  private ghost: THREE.Mesh;
  private grid!: THREE.LineSegments;
  private gridPos!: Float32Array;
  private gridCol!: Float32Array;
  private preview = new THREE.Group();
  private beams = new THREE.Group();
  private sparks: THREE.Mesh[] = [];
  private beamMat = new THREE.MeshBasicMaterial({ color: LASER.clone().multiplyScalar(2.6), toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  private previewMat = new THREE.LineDashedMaterial({ color: LASER.clone().multiplyScalar(1.4), dashSize: 0.45, gapSize: 0.35, transparent: true, opacity: 0.85, toneMapped: false });
  private flash: THREE.Mesh;
  private flashT = -1;
  private firing: { rays: Ray[]; meshes: THREE.Mesh[]; t0: number; dur: number; length: number; done: () => void } | null = null;
  private dragging: Drag | null = null;
  private dragOffset = new THREE.Vector2();
  private ray = new THREE.Raycaster();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private clock = new THREE.Clock();
  private raf = 0;
  private won = false;
  private moonPos: Vec = { x: 0, z: 0 };
  private satellitePos: Vec | null = null;
  private reduceMotion = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  locked = false;

  constructor(private host: HTMLElement, private cb: SceneCallbacks) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    host.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    Object.assign(this.controls, { enableDamping: true, dampingFactor: 0.08, maxPolarAngle: 1.38, minDistance: 16, maxDistance: 120, enablePan: false });
    this.controls.target.set(-1, -1, -1);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.75, 0.45, 0.62);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.buildSky();
    const sun = new THREE.DirectionalLight(0xfff1dd, 2.6); sun.position.copy(SUN).multiplyScalar(50);
    this.scene.add(sun, new THREE.AmbientLight(0x6070a0, 0.35), this.levelGroup);

    this.flash = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshBasicMaterial({ color: hdr(0xffffff, 3), toneMapped: false, transparent: true, opacity: 0 }));
    this.ghost = new THREE.Mesh(new THREE.RingGeometry(2.8, 3, 96), new THREE.MeshBasicMaterial({ color: hdr(MIRROR, 1.3), toneMapped: false, transparent: true, opacity: 0.7, side: THREE.DoubleSide }));
    this.ghost.rotation.x = -Math.PI / 2; this.ghost.visible = false;
    this.scene.add(this.flash, this.ghost, this.preview, this.beams);

    this.moon.visible = false;
    this.scene.add(this.moon, this.sat);
    this.sat.visible = false;

    const el = this.renderer.domElement;
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointercancel', this.onUp);
    addEventListener('resize', this.resize);
    this.resize();
    this.raf = requestAnimationFrame(this.tick);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    removeEventListener('resize', this.resize);
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private resize = () => {
    const w = this.host.clientWidth || innerWidth, h = this.host.clientHeight || innerHeight;
    this.renderer.setSize(w, h); this.composer.setSize(w, h); this.bloom.setSize(w, h);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  };

  frame() {
    const a = this.camera.aspect;
    const d = a < 0.8 ? 92 : a < 1.2 ? 66 : 50;
    this.camera.position.set(-6, d * 0.8, d * 0.62);
    this.controls.target.set(-1, -1, -1);
    this.controls.update();
  }

  private buildSky() {
    this.scene.add(new THREE.Mesh(new THREE.SphereGeometry(900, 48, 32), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      vertexShader: `varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
      fragmentShader: NOISE + `varying vec3 vD; void main(){
        float n = fbm(vD*2.2 + vec3(3.1,0.,1.7)); float m = fbm(vD*4.5 - vec3(1.,2.,0.));
        vec3 c = vec3(0.012,0.014,0.03);
        c += vec3(0.16,0.04,0.12) * smoothstep(0.45,0.85,n) * 0.9;
        c += vec3(0.03,0.09,0.16) * smoothstep(0.5,0.9,m) * 0.8;
        gl_FragColor = vec4(c,1.); }`,
    })));
    const N = 5000, pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const u = Math.random() * 2 - 1, t = Math.random() * Math.PI * 2, r = 380 + Math.random() * 400, s = Math.sqrt(1 - u * u);
      pos.set([r * s * Math.cos(t), r * u, r * s * Math.sin(t)], i * 3);
      const k = Math.random(), b = 0.6 + Math.random() * 0.9;
      col.set(k < 0.15 ? [b, 0.75 * b, 0.6 * b] : k < 0.3 ? [0.7 * b, 0.82 * b, b] : [b, b, b], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const sc = document.createElement('canvas'); sc.width = sc.height = 32; const sg = sc.getContext('2d')!;
    const grd = sg.createRadialGradient(16, 16, 0, 16, 16, 16);
    grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.25, 'rgba(255,255,255,0.6)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    sg.fillStyle = grd; sg.fillRect(0, 0, 32, 32);
    this.scene.add(new THREE.Points(g, new THREE.PointsMaterial({ size: 3.2, map: new THREE.CanvasTexture(sc), vertexColors: true, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })));
  }

  private buildMoon(level: Level) {
    this.moon.clear();
    this.moonMirror = new THREE.Group();
    const r = level.moon.r;
    const tint = { grey: 0xffffff, ice: 0xcfe6ff, rust: 0xe08a62 }[level.moon.style ?? 'grey'] ?? 0xffffff;
    const tex = craterTexture();
    const ball = new THREE.Mesh(new THREE.SphereGeometry(r, 64, 48), new THREE.MeshStandardMaterial({ map: tex, bumpMap: tex, bumpScale: 0.04, roughness: level.moon.style === 'ice' ? 0.6 : 0.95, color: tint }));
    const grab = new THREE.Mesh(new THREE.TorusGeometry(r + 0.9, 0.035, 8, 96), new THREE.MeshBasicMaterial({ color: hdr(MIRROR, 1.4), transparent: true, opacity: 0.55, toneMapped: false }));
    grab.rotation.x = Math.PI / 2;
    this.moonPick = new THREE.Mesh(new THREE.SphereGeometry(r + 1.4, 16, 12), new THREE.MeshBasicMaterial({ visible: false }));
    const panel = mirrorPanel(level.mirrorHalf * 2); panel.position.x = r + MOON_MIRROR_OFFSET;
    this.moonMirror.add(panel);
    this.moon.add(ball, grab, this.moonPick, this.moonMirror);
    this.animated.push({ tick: (t, dt) => { ball.rotation.y += dt * 0.12; (grab.material as THREE.MeshBasicMaterial).opacity = this.locked ? 0.12 : 0.35 + Math.sin(t * 2.4) * 0.2; } });
  }

  private buildSatellite(level: Level) {
    this.sat.clear();
    this.satMirror = new THREE.Group();
    const body = new THREE.Mesh(new THREE.OctahedronGeometry(SATELLITE_RADIUS * 0.6, 0), new THREE.MeshStandardMaterial({ color: 0xc8d0e0, metalness: 0.8, roughness: 0.3, flatShading: true }));
    body.position.x = -0.45;
    const grab = new THREE.Mesh(new THREE.TorusGeometry(level.mirrorHalf + 0.4, 0.03, 8, 80), new THREE.MeshBasicMaterial({ color: hdr(MIRROR, 1.4), transparent: true, opacity: 0.5, toneMapped: false }));
    grab.rotation.x = Math.PI / 2;
    this.satPick = new THREE.Mesh(new THREE.SphereGeometry(level.mirrorHalf + 0.7, 16, 12), new THREE.MeshBasicMaterial({ visible: false }));
    this.satMirror.add(mirrorPanel(level.mirrorHalf * 2), body);
    this.sat.add(this.satMirror, grab, this.satPick);
    this.animated.push({ tick: (t) => { (grab.material as THREE.MeshBasicMaterial).opacity = this.locked ? 0.1 : 0.3 + Math.sin(t * 2.4 + 1) * 0.2; } });
  }

  private buildEmitter(level: Level) {
    const em = new THREE.Group(); em.position.set(level.emitter.x, 0, level.emitter.z); em.rotation.y = -level.emitter.dir;
    const metal = new THREE.MeshStandardMaterial({ color: 0xb8bfcc, metalness: 0.85, roughness: 0.35 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2a2f3c, metalness: 0.6, roughness: 0.5 });
    const style = level.emitter.style ?? 'station';
    if (style === 'dish') {
      // radio-telescope style dish on a truss, facing along the beam
      const dish = new THREE.Mesh(new THREE.SphereGeometry(1.5, 32, 16, 0, Math.PI * 2, 0, 0.9), new THREE.MeshStandardMaterial({ color: 0xdfe3ea, metalness: 0.5, roughness: 0.35, side: THREE.DoubleSide }));
      dish.rotation.z = Math.PI / 2; dish.position.x = -0.9;
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.3, 6), metal); mast.rotation.z = Math.PI / 2; mast.position.x = 0.15;
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.5, 0.8), dark); base.position.set(-1.2, -0.9, 0);
      em.add(dish, mast, base);
    } else if (style === 'crystal') {
      // alien crystal emitter: floating shard inside spinning rings
      const shard = new THREE.Mesh(new THREE.OctahedronGeometry(0.8, 0), new THREE.MeshPhysicalMaterial({ color: 0xffc2d1, metalness: 0.1, roughness: 0.1, emissive: 0x8a1830, emissiveIntensity: 0.8, flatShading: true }));
      shard.scale.set(1.5, 0.8, 0.8); shard.position.x = -0.3;
      const ringA = new THREE.Mesh(new THREE.TorusGeometry(1.2, 0.04, 8, 64), new THREE.MeshBasicMaterial({ color: hdr(0xff8aa5, 1.6), toneMapped: false }));
      const ringB = ringA.clone(); ringB.scale.setScalar(0.8);
      em.add(shard, ringA, ringB);
      this.animated.push({ tick: (t) => { ringA.rotation.x = t * 0.8; ringA.rotation.y = t * 0.5; ringB.rotation.y = -t; ringB.rotation.z = t * 0.6; shard.rotation.x = t * 0.4; } });
    } else {
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.7, 1.8, 24), metal); body.rotation.z = Math.PI / 2;
      const hub = new THREE.Mesh(new THREE.TorusGeometry(1.15, 0.12, 12, 48), dark); hub.rotation.y = Math.PI / 2;
      em.add(body, hub);
      for (const s of [-1, 1]) {
        const panel = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.04, 2.4), new THREE.MeshStandardMaterial({ color: 0x1b2a55, metalness: 0.4, roughness: 0.3, emissive: 0x0b1840, emissiveIntensity: 0.6 }));
        panel.position.set(-0.3, 0, s * 2.4); em.add(panel);
      }
    }
    const lens = new THREE.Mesh(new THREE.SphereGeometry(0.32, 20, 16), new THREE.MeshBasicMaterial({ color: hdr(0xff4f6e, 3), toneMapped: false })); lens.position.x = 1;
    em.add(lens);
    return em;
  }

  private buildBlackHole(grp: THREE.Group, r: number) {
    const hole = new THREE.Mesh(new THREE.SphereGeometry(r, 48, 32), new THREE.MeshBasicMaterial({ color: 0x000000 }));
    const lens = new THREE.Mesh(new THREE.SphereGeometry(r * 1.9, 48, 32), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.BackSide,
      vertexShader: `varying vec3 vN; varying vec3 vW; void main(){ vN = normalize(mat3(modelMatrix)*normal); vec4 w = modelMatrix*vec4(position,1.); vW=w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`,
      fragmentShader: `varying vec3 vN; varying vec3 vW; void main(){ vec3 V = normalize(cameraPosition - vW);
        float f = pow(clamp(1.0 - abs(dot(vN, V)), 0., 1.), 5.0); gl_FragColor = vec4(vec3(1.0,0.75,0.45)*f*1.4, f); }`,
    }));
    const disk = new THREE.Mesh(new THREE.RingGeometry(r * 1.3, r * 3.4, 128, 1), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      uniforms: { uT: { value: 0 }, uIn: { value: r * 1.3 }, uOut: { value: r * 3.4 } },
      vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
      fragmentShader: NOISE + `uniform float uT; uniform float uIn; uniform float uOut; varying vec3 vP; void main(){
        float rr = length(vP.xy); float t = (rr-uIn)/(uOut-uIn); float a = atan(vP.y, vP.x);
        float n = fbm(vec3(cos(a)*2.0 + uT*0.0, sin(a)*2.0, rr*3.0 - uT*0.8));
        float glow = pow(1.0 - t, 2.2) * (0.5 + n);
        vec3 c = mix(vec3(1.0,0.35,0.1), vec3(1.0,0.9,0.7), pow(1.0-t, 3.0)) * glow * 2.2;
        gl_FragColor = vec4(c, glow * smoothstep(0.0, 0.08, t)); }`,
    }));
    disk.rotation.x = -Math.PI / 2 + 0.25;
    grp.add(hole, lens, disk);
    const mat = disk.material as THREE.ShaderMaterial;
    this.animated.push({ tick: (t) => { mat.uniforms.uT.value = t; disk.rotation.z = t * 0.4; } });
  }

  setLevel(level: Level) {
    this.level = level;
    this.levelGroup.clear();
    this.animated = [];
    this.buildMoon(level);
    this.buildSatellite(level);
    this.moon.visible = true;
    this.moonPos = { x: NaN, z: NaN }; // force the next setPlacement to refresh the grid
    const g = this.levelGroup;

    level.bodies.forEach((b, i) => {
      const grp = new THREE.Group(); grp.position.set(b.x, 0, b.z);
      if (b.kind === 'blackhole') { this.buildBlackHole(grp, b.r); g.add(grp); return; }
      const style = b.style ?? (b.kind === 'giant' ? 'amber' : 'blue');
      const mat = planetMaterial(style, i * 3.7 + b.r);
      const ball = new THREE.Mesh(new THREE.SphereGeometry(b.r, 96, 64), mat); ball.rotation.z = 0.12;
      const halo = (PALETTES[style] ?? PALETTES.amber).halo;
      grp.add(ball, new THREE.Mesh(new THREE.SphereGeometry(b.r * 1.12, 64, 48), haloMaterial(new THREE.Color(...halo))));
      if (b.kind === 'giant' && b.ring !== false) {
        const ring = new THREE.Mesh(new THREE.RingGeometry(b.r * 1.3, b.r * 2.15, 160, 1), new THREE.ShaderMaterial({
          transparent: true, side: THREE.DoubleSide, depthWrite: false,
          uniforms: { uIn: { value: b.r * 1.3 }, uOut: { value: b.r * 2.15 } },
          vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
          fragmentShader: NOISE + `uniform float uIn; uniform float uOut; varying vec3 vP; void main(){
            float r = length(vP.xy); float t = (r-uIn)/(uOut-uIn);
            float bands = n3(vec3(r*6.0,0.,0.))*0.7 + n3(vec3(r*23.0,1.,0.))*0.5;
            float a = smoothstep(0.0,0.06,t)*smoothstep(1.0,0.85,t)*(0.25+bands*0.55);
            a *= 1.0 - smoothstep(0.42,0.47,t)*smoothstep(0.53,0.48,t)*0.85;
            gl_FragColor = vec4(mix(vec3(0.85,0.68,0.5), vec3(0.6,0.45,0.35), t)*0.6, a*0.65); }`,
        }));
        ring.rotation.x = -Math.PI / 2 + 0.42; ring.rotation.y = 0.25; grp.add(ring);
      }
      g.add(grp);
      this.animated.push({ tick: (t, dt) => { ball.rotation.y += dt * 0.05; mat.uniforms.uT.value = t; } });
    });

    // emitter
    g.add(this.buildEmitter(level));

    // beacon
    const bc = new THREE.Group(); bc.position.set(level.target.x, 0, level.target.z);
    const coreMat = new THREE.MeshBasicMaterial({ color: hdr(BEACON, 1.6), toneMapped: false });
    const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.55, 0), coreMat);
    const ringA = new THREE.Mesh(new THREE.TorusGeometry(level.target.r * 0.85, 0.05, 8, 64), new THREE.MeshBasicMaterial({ color: hdr(BEACON, 1.2), toneMapped: false }));
    const ringB = ringA.clone(); ringB.scale.setScalar(0.8);
    const light = new THREE.PointLight(BEACON, 4, 14, 2);
    bc.add(core, ringA, ringB, light); g.add(bc);
    this.animated.push({ tick: (t, dt) => {
      core.rotation.y += dt * 1.2; core.position.y = Math.sin(t * 1.6) * 0.12;
      ringA.rotation.x = t * 0.9; ringA.rotation.y = t * 0.5; ringB.rotation.y = -t * 1.1; ringB.rotation.z = t * 0.4;
      light.intensity = 3 + Math.sin(t * 3) * 1.2 + (this.won ? 10 : 0);
      coreMat.color.copy(hdr(BEACON, this.won ? 4 : 1.6));
    } });

    // beam splitters
    for (const sp of level.splitters ?? []) {
      const grp = new THREE.Group(); grp.position.set(sp.x, 0, sp.z); grp.rotation.y = (-sp.angle * Math.PI) / 180;
      const L = sp.half * 2;
      const crystal = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.3, L), new THREE.MeshPhysicalMaterial({ color: 0xe9d8ff, metalness: 0.1, roughness: 0.05, transmission: 0.6, transparent: true, opacity: 0.55, emissive: 0x6a3cc0, emissiveIntensity: 0.6 }));
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(0.18, 1.32, L + 0.02)), new THREE.LineBasicMaterial({ color: hdr(0xc9a2ff, 2.2), toneMapped: false }));
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.25, 0.4, 8), new THREE.MeshStandardMaterial({ color: 0x9aa3b5, metalness: 0.8, roughness: 0.3 })); base.position.y = -0.85;
      grp.add(crystal, edges, base); g.add(grp);
      this.animated.push({ tick: (t) => { (edges.material as THREE.LineBasicMaterial).color.copy(hdr(0xc9a2ff, 1.8 + Math.sin(t * 2) * 0.5)); } });
    }

    // wormholes
    for (const w of level.wormholes ?? []) {
      for (const [m, hue] of [[w.a, 0x7bf6ff], [w.b, 0xff8bf0]] as const) {
        const grp = new THREE.Group(); grp.position.set(m.x, 0, m.z);
        const swirl = new THREE.Mesh(new THREE.CircleGeometry(w.r * 1.25, 64), new THREE.ShaderMaterial({
          transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
          uniforms: { uT: { value: 0 }, uC: { value: new THREE.Color(hue) } },
          vertexShader: `varying vec2 vU; void main(){ vU = uv - 0.5; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
          fragmentShader: `uniform float uT; uniform vec3 uC; varying vec2 vU; void main(){
            float r = length(vU)*2.0; float a = atan(vU.y, vU.x);
            float s = sin(a*3.0 + r*10.0 - uT*3.0)*0.5+0.5;
            float core = smoothstep(0.35, 0.0, r);
            float rim = smoothstep(1.0, 0.75, r) * smoothstep(0.2, 0.7, r);
            vec3 c = uC * (rim * (0.4 + 0.8*s)) * 1.8 + vec3(0.02,0.0,0.05) * core;
            gl_FragColor = vec4(c, rim*0.9 + core*0.8); }`,
        }));
        swirl.rotation.x = -Math.PI / 2;
        const ring = new THREE.Mesh(new THREE.TorusGeometry(w.r * 1.25, 0.05, 8, 64), new THREE.MeshBasicMaterial({ color: hdr(hue, 1.6), toneMapped: false }));
        ring.rotation.x = Math.PI / 2;
        grp.add(swirl, ring); g.add(grp);
        const mat = swirl.material as THREE.ShaderMaterial;
        this.animated.push({ tick: (t) => { mat.uniforms.uT.value = t; ring.rotation.z = t * 0.6; } });
      }
      // faint link between the mouths
      const link = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(w.a.x, -0.6, w.a.z), new THREE.Vector3(w.b.x, -0.6, w.b.z)]), new THREE.LineDashedMaterial({ color: 0x8a7bd0, dashSize: 0.3, gapSize: 0.6, transparent: true, opacity: 0.35 }));
      link.computeLineDistances(); g.add(link);
    }

    // rocks
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x6d6358, roughness: 1, flatShading: true });
    const rocks: THREE.Mesh[] = [];
    level.rocks.forEach((R, i) => {
      const geo = new THREE.IcosahedronGeometry(R.r, 1); const p = geo.attributes.position;
      for (let k = 0; k < p.count; k++) { const v = new THREE.Vector3().fromBufferAttribute(p, k); v.multiplyScalar(0.9 + Math.sin(k * 12.9898 + i * 7.1) * 0.2); p.setXYZ(k, v.x, v.y, v.z); }
      geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, rockMat); m.position.set(R.x, 0, R.z); rocks.push(m); g.add(m);
      for (let d = 0; d < 5; d++) {
        const a = Math.random() * Math.PI * 2, rr = R.r + 0.4 + Math.random() * 1.2;
        const dust = new THREE.Mesh(new THREE.IcosahedronGeometry(0.1 + Math.random() * 0.18, 0), rockMat);
        dust.position.set(R.x + Math.cos(a) * rr, (Math.random() - 0.5) * 1.4, R.z + Math.sin(a) * rr); rocks.push(dust); g.add(dust);
      }
    });
    this.animated.push({ tick: (_t, dt) => { for (const r of rocks) { r.rotation.x += dt * 0.2; r.rotation.y += dt * 0.13; } } });

    this.buildGrid(level);
  }

  private buildGrid(level: Level) {
    const LINES = 46, SEG = 140, count = LINES * 2 * SEG * 2;
    this.gridPos = new Float32Array(count * 3); this.gridCol = new Float32Array(count * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.gridPos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.gridCol, 3));
    this.grid = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.grid.userData = { LINES, SEG };
    this.levelGroup.add(this.grid);
    this.updateGrid(level.moon.start);
  }

  private updateGrid(moon: Vec) {
    const level = this.level!; const { LINES, SEG } = this.grid.userData; const GX = level.bounds.x, GZ = level.bounds.z;
    const masses = [...level.bodies.map((b) => ({ x: b.x, z: b.z, m: b.m })), { x: moon.x, z: moon.z, m: level.moon.m }];
    let i = 0;
    const put = (x: number, z: number) => {
      let d = 0; for (const B of masses) { const dx = x - B.x, dz = z - B.z; d += 15 * B.m / Math.sqrt(dx * dx + dz * dz + 5); }
      const y = -1.4 - d;
      this.gridPos[i * 3] = x; this.gridPos[i * 3 + 1] = y; this.gridPos[i * 3 + 2] = z;
      const edge = Math.max(Math.abs(x) / GX, Math.abs(z) / GZ), f = Math.max(0, 1 - edge * edge) * 0.2, deep = Math.min(1, d / 5);
      this.gridCol[i * 3] = f * (0.35 + 0.5 * deep); this.gridCol[i * 3 + 1] = f * (0.42 + 0.1 * deep); this.gridCol[i * 3 + 2] = f * (0.85 - 0.2 * deep);
      i++;
    };
    for (let l = 0; l < LINES; l++) {
      const zl = -GZ + (2 * GZ * l) / (LINES - 1), xl = -GX + (2 * GX * l) / (LINES - 1);
      for (let s = 0; s < SEG; s++) {
        put(-GX + (2 * GX * s) / SEG, zl); put(-GX + (2 * GX * (s + 1)) / SEG, zl);
        put(xl, -GZ + (2 * GZ * s) / SEG); put(xl, -GZ + (2 * GZ * (s + 1)) / SEG);
      }
    }
    const geo = this.grid.geometry;
    geo.attributes.position.needsUpdate = true; geo.attributes.color.needsUpdate = true; geo.computeBoundingSphere();
  }

  setPlacement(p: Placement) {
    const movedMoon = p.moon.x !== this.moonPos.x || p.moon.z !== this.moonPos.z;
    this.moonPos = { ...p.moon };
    this.moon.position.set(p.moon.x, 0, p.moon.z);
    this.moonMirror.rotation.y = (-p.angle * Math.PI) / 180;
    if (p.satellite) {
      this.sat.visible = true; this.satellitePos = { x: p.satellite.x, z: p.satellite.z };
      this.sat.position.set(p.satellite.x, 0, p.satellite.z);
      this.satMirror.rotation.y = (-p.satellite.angle * Math.PI) / 180;
    } else { this.sat.visible = false; this.satellitePos = null; }
    if (movedMoon && this.level) this.updateGrid(p.moon);
  }

  /** Draws the dashed aiming line for every ray up to light-travel distance `limit`. */
  setPreview(res: TraceResult | null, limit: number) {
    for (const c of [...this.preview.children]) { this.preview.remove(c); (c as THREE.Line).geometry.dispose(); }
    if (!res) return;
    for (const ray of res.rays) {
      const last = indexAt(ray, limit);
      if (last < 1) continue;
      let run: THREE.Vector3[] = [];
      const flush = () => {
        if (run.length > 1) {
          const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(run), this.previewMat);
          line.computeLineDistances(); this.preview.add(line);
        }
        run = [];
      };
      for (let i = 0; i <= last; i++) {
        const p = ray.pts[i];
        if (p.jump) flush();
        run.push(new THREE.Vector3(p.x, 0, p.z));
      }
      flush();
    }
  }

  setGhost(g: { x: number; z: number; radius: number } | null) {
    this.ghost.visible = !!g;
    if (g) { this.ghost.position.set(g.x, 0.05, g.z); this.ghost.scale.setScalar(g.radius / 3); }
  }

  setWon(won: boolean) { this.won = won; }

  clearBeam() {
    for (const c of [...this.beams.children]) { this.beams.remove(c); (c as THREE.Mesh).geometry?.dispose(); }
    this.sparks = [];
  }

  showBeam(res: TraceResult) {
    this.clearBeam();
    for (const ray of res.rays) this.beams.add(new THREE.Mesh(beamGeometry(ray.pts), this.beamMat));
  }

  fire(res: TraceResult): Promise<void> {
    this.clearBeam();
    const meshes = res.rays.map((ray) => {
      const m = new THREE.Mesh(beamGeometry(ray.pts), this.beamMat);
      m.geometry.setDrawRange(0, 0); this.beams.add(m);
      const spark = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 12), new THREE.MeshBasicMaterial({ color: hdr(0xffd0d8, 4), toneMapped: false }));
      spark.visible = false; this.beams.add(spark); this.sparks.push(spark);
      return m;
    });
    const length = Math.max(...res.rays.map((r) => r.dist[r.dist.length - 1]));
    return new Promise((done) => {
      this.firing = { rays: res.rays, meshes, t0: performance.now(), length, dur: this.reduceMotion ? 200 : Math.min(3000, 500 + length * 28), done: () => {
        for (const ray of res.rays) {
          const last = ray.pts[ray.pts.length - 1];
          if (ray.result === 'lost') continue;
          this.flashAt(last, ray.result === 'hit' ? BEACON : ray.result === 'rock' ? 0xff9a6e : 0xff4f6e);
        }
        done();
      } };
    });
  }

  private flashAt(p: Vec, color: number) {
    (this.flash.material as THREE.MeshBasicMaterial).color.copy(hdr(color, 3));
    this.flash.position.set(p.x, 0, p.z); this.flashT = performance.now();
  }

  // ---- dragging ----
  private toRay(e: PointerEvent) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
  }
  private pickAt(): Drag | null {
    if (this.sat.visible && this.ray.intersectObject(this.satPick).length) return 'satellite';
    if (this.ray.intersectObject(this.moonPick).length) return 'moon';
    return null;
  }
  private onDown = (e: PointerEvent) => {
    if (this.locked || this.firing) return;
    this.toRay(e);
    const which = this.pickAt();
    if (!which) return;
    this.dragging = which; this.controls.enabled = false;
    this.renderer.domElement.setPointerCapture(e.pointerId);
    const hit = new THREE.Vector3();
    const cur = which === 'moon' ? this.moonPos : this.satellitePos!;
    if (this.ray.ray.intersectPlane(this.plane, hit)) this.dragOffset.set(cur.x - hit.x, cur.z - hit.z);
  };
  private onMove = (e: PointerEvent) => {
    this.toRay(e);
    if (!this.dragging) {
      this.renderer.domElement.style.cursor = !this.locked && this.pickAt() ? 'move' : 'grab';
      return;
    }
    const hit = new THREE.Vector3();
    if (!this.level || !this.ray.ray.intersectPlane(this.plane, hit)) return;
    const raw = { x: hit.x + this.dragOffset.x, z: hit.z + this.dragOffset.y };
    const radius = this.dragging === 'moon' ? this.level.moon.r : SATELLITE_RADIUS;
    let pos = constrainMoon(this.level, raw, radius);
    // keep moon and satellite apart
    const other = this.dragging === 'moon' ? this.satellitePos : this.moonPos;
    if (other) {
      const min = this.level.moon.r + 1.7, dx = pos.x - other.x, dz = pos.z - other.z, d = Math.hypot(dx, dz) || 1;
      if (d < min) pos = constrainMoon(this.level, { x: other.x + (dx / d) * min, z: other.z + (dz / d) * min }, radius);
    }
    this.cb.onDrag(this.dragging, { x: Math.round(pos.x * 100) / 100, z: Math.round(pos.z * 100) / 100 });
  };
  private onUp = () => { if (this.dragging) { this.dragging = null; this.controls.enabled = true; } };

  private tick = (now: number) => {
    const dt = Math.min(this.clock.getDelta(), 0.05), t = this.clock.elapsedTime * (this.reduceMotion ? 0.15 : 1);
    for (const a of this.animated) a.tick(t, this.reduceMotion ? dt * 0.15 : dt);
    this.ghost.rotation.z = t * 0.3;
    if (this.firing) {
      const F = this.firing, k = Math.max(0, Math.min(1, (now - F.t0) / F.dur)), d = k * F.length;
      F.rays.forEach((ray, i) => {
        const at = indexAt(ray, d), spark = this.sparks[i];
        F.meshes[i].geometry.setDrawRange(0, Math.max(0, at) * 12);
        const done = at >= ray.pts.length - 1;
        spark.visible = at >= 0 && !done && k < 1;
        if (spark.visible) { const P = ray.pts[at]; spark.position.set(P.x, 0, P.z); spark.scale.setScalar(1 + Math.sin(now * 0.04) * 0.25); }
      });
      if (k >= 1) { for (const sp of this.sparks) sp.visible = false; this.firing = null; F.done(); }
    }
    if (this.flashT > 0) {
      const k = Math.max(0, (now - this.flashT) / 700);
      const m = this.flash.material as THREE.MeshBasicMaterial;
      if (k >= 1) { m.opacity = 0; this.flashT = -1; } else { m.opacity = (1 - k) * 0.9; this.flash.scale.setScalar(0.4 + k * 3); }
    }
    if (this.beams.children.length && !this.firing) this.beamMat.color.copy(LASER).multiplyScalar(2.2 + Math.sin(t * 9) * 0.35);
    this.controls.update();
    this.composer.render();
    this.raf = requestAnimationFrame(this.tick);
  };
}
