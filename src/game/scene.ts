// three.js renderer for Orbit. Pure view: it draws what the React layer tells it to.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { constrainMoon, MOON_MIRROR_OFFSET, SATELLITE_RADIUS, type Level, type Placement, type TraceResult, type Vec } from './engine';

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

function planetMaterial(kind: 'giant' | 'planet', seed: number) {
  const palette = kind === 'giant'
    ? ['vec3(0.93,0.78,0.55)', 'vec3(0.62,0.27,0.12)', 'vec3(0.82,0.52,0.22)', 'vec3(0.32,0.14,0.08)']
    : ['vec3(0.62,0.80,0.92)', 'vec3(0.18,0.32,0.55)', 'vec3(0.40,0.60,0.78)', 'vec3(0.08,0.12,0.25)'];
  return new THREE.ShaderMaterial({
    uniforms: { uSun: { value: SUN }, uT: { value: 0 }, uSeed: { value: seed } },
    vertexShader: `varying vec3 vN; varying vec3 vP; varying vec3 vW;
      void main(){ vP = position; vN = normalize(mat3(modelMatrix)*normal); vec4 w = modelMatrix*vec4(position,1.); vW = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`,
    fragmentShader: NOISE + `uniform vec3 uSun; uniform float uT; uniform float uSeed; varying vec3 vN; varying vec3 vP; varying vec3 vW;
      void main(){
        vec3 p = normalize(vP); float lat = p.y;
        float warp = fbm(vec3(p.x*3.0 + uT*0.03 + uSeed, p.y*9.0, p.z*3.0)) * 0.9;
        float b = sin(lat*(18.0+uSeed*0.4) + warp*4.0) * 0.5 + 0.5;
        float b2 = sin(lat*57.0 + warp*7.0) * 0.5 + 0.5;
        vec3 c = mix(${palette[1]}, ${palette[0]}, b); c = mix(c, ${palette[2]}, b2*0.45);
        c = mix(c, ${palette[3]}, smoothstep(0.75,1.0,abs(lat))*0.6);
        float diff = clamp(dot(vN, uSun), 0.0, 1.0);
        vec3 V = normalize(cameraPosition - vW);
        float rim = pow(1.0 - clamp(dot(vN, V),0.,1.), 3.0);
        gl_FragColor = vec4(c*(0.05+0.82*diff) + ${palette[0]}*rim*0.22*(0.3+diff), 1.0);
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

function beamGeometry(pts: Vec[]) {
  const w = 0.11, pos: number[] = [], idx: number[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    let dx = b.x - a.x, dz = b.z - a.z; const l = Math.hypot(dx, dz); if (l < 1e-6) continue; dx /= l; dz /= l;
    for (const o of [[-dz * w, 0, dx * w], [0, w, 0]]) {
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
  private moonPick!: THREE.Mesh;
  private sat = new THREE.Group();
  private satMirror = new THREE.Group();
  private satPick!: THREE.Mesh;
  private ghost: THREE.Mesh;
  private grid!: THREE.LineSegments;
  private gridPos!: Float32Array;
  private gridCol!: Float32Array;
  private preview: THREE.Line | null = null;
  private beam: THREE.Mesh | null = null;
  private beamMat = new THREE.MeshBasicMaterial({ color: LASER.clone().multiplyScalar(2.6), toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  private previewMat = new THREE.LineDashedMaterial({ color: LASER.clone().multiplyScalar(1.4), dashSize: 0.45, gapSize: 0.35, transparent: true, opacity: 0.85, toneMapped: false });
  private spark: THREE.Mesh;
  private flash: THREE.Mesh;
  private flashT = -1;
  private firing: { pts: Vec[]; t0: number; dur: number; total: number; done: () => void } | null = null;
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

    this.spark = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 12), new THREE.MeshBasicMaterial({ color: hdr(0xffd0d8, 4), toneMapped: false }));
    this.spark.visible = false;
    this.flash = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshBasicMaterial({ color: hdr(0xffffff, 3), toneMapped: false, transparent: true, opacity: 0 }));
    this.ghost = new THREE.Mesh(new THREE.RingGeometry(2.8, 3, 96), new THREE.MeshBasicMaterial({ color: hdr(MIRROR, 1.3), toneMapped: false, transparent: true, opacity: 0.7, side: THREE.DoubleSide }));
    this.ghost.rotation.x = -Math.PI / 2; this.ghost.visible = false;
    this.scene.add(this.spark, this.flash, this.ghost);

    this.buildMoon();
    this.buildSatellite();

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

  private buildMoon() {
    const tex = craterTexture();
    const ball = new THREE.Mesh(new THREE.SphereGeometry(1.6, 64, 48), new THREE.MeshStandardMaterial({ map: tex, bumpMap: tex, bumpScale: 0.04, roughness: 0.95 }));
    const grab = new THREE.Mesh(new THREE.TorusGeometry(2.5, 0.035, 8, 96), new THREE.MeshBasicMaterial({ color: hdr(MIRROR, 1.4), transparent: true, opacity: 0.55, toneMapped: false }));
    grab.rotation.x = Math.PI / 2;
    this.moonPick = new THREE.Mesh(new THREE.SphereGeometry(3, 16, 12), new THREE.MeshBasicMaterial({ visible: false }));
    const panel = mirrorPanel(3); panel.position.x = 1.6 + MOON_MIRROR_OFFSET;
    this.moonMirror.add(panel);
    this.moon.add(ball, grab, this.moonPick, this.moonMirror);
    this.scene.add(this.moon);
    this.animated.push({ tick: (t, dt) => { ball.rotation.y += dt * 0.12; (grab.material as THREE.MeshBasicMaterial).opacity = this.locked ? 0.12 : 0.35 + Math.sin(t * 2.4) * 0.2; } });
  }

  private buildSatellite() {
    const body = new THREE.Mesh(new THREE.OctahedronGeometry(SATELLITE_RADIUS * 0.6, 0), new THREE.MeshStandardMaterial({ color: 0xc8d0e0, metalness: 0.8, roughness: 0.3, flatShading: true }));
    body.position.x = -0.45;
    const grab = new THREE.Mesh(new THREE.TorusGeometry(1.9, 0.03, 8, 80), new THREE.MeshBasicMaterial({ color: hdr(MIRROR, 1.4), transparent: true, opacity: 0.5, toneMapped: false }));
    grab.rotation.x = Math.PI / 2;
    this.satPick = new THREE.Mesh(new THREE.SphereGeometry(2.2, 16, 12), new THREE.MeshBasicMaterial({ visible: false }));
    this.satMirror.add(mirrorPanel(3), body);
    this.sat.add(this.satMirror, grab, this.satPick);
    this.sat.visible = false;
    this.scene.add(this.sat);
    this.animated.push({ tick: (t) => { (grab.material as THREE.MeshBasicMaterial).opacity = this.locked ? 0.1 : 0.3 + Math.sin(t * 2.4 + 1) * 0.2; } });
  }

  setLevel(level: Level) {
    this.level = level;
    this.levelGroup.clear();
    this.animated = this.animated.slice(0, 2); // keep moon + satellite animators
    const g = this.levelGroup;

    level.bodies.forEach((b, i) => {
      const grp = new THREE.Group(); grp.position.set(b.x, 0, b.z);
      const mat = planetMaterial(b.kind, i * 3.7 + b.r);
      const ball = new THREE.Mesh(new THREE.SphereGeometry(b.r, 96, 64), mat); ball.rotation.z = 0.12;
      grp.add(ball, new THREE.Mesh(new THREE.SphereGeometry(b.r * 1.12, 64, 48), haloMaterial(b.kind === 'giant' ? new THREE.Color(1, 0.55, 0.25) : new THREE.Color(0.4, 0.7, 1))));
      if (b.kind === 'giant') {
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
    const em = new THREE.Group(); em.position.set(level.emitter.x, 0, level.emitter.z); em.rotation.y = -level.emitter.dir;
    const metal = new THREE.MeshStandardMaterial({ color: 0xb8bfcc, metalness: 0.85, roughness: 0.35 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.7, 1.8, 24), metal); body.rotation.z = Math.PI / 2;
    const hub = new THREE.Mesh(new THREE.TorusGeometry(1.15, 0.12, 12, 48), new THREE.MeshStandardMaterial({ color: 0x2a2f3c, metalness: 0.6, roughness: 0.5 })); hub.rotation.y = Math.PI / 2;
    em.add(body, hub);
    for (const s of [-1, 1]) {
      const panel = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.04, 2.4), new THREE.MeshStandardMaterial({ color: 0x1b2a55, metalness: 0.4, roughness: 0.3, emissive: 0x0b1840, emissiveIntensity: 0.6 }));
      panel.position.set(-0.3, 0, s * 2.4); em.add(panel);
    }
    const lens = new THREE.Mesh(new THREE.SphereGeometry(0.32, 20, 16), new THREE.MeshBasicMaterial({ color: hdr(0xff4f6e, 3), toneMapped: false })); lens.position.x = 1;
    em.add(lens); g.add(em);

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

  setPreview(res: TraceResult | null, cut: number) {
    if (this.preview) { this.scene.remove(this.preview); this.preview.geometry.dispose(); this.preview = null; }
    if (!res) return;
    const pts = res.pts.slice(0, cut + 1).map((p) => new THREE.Vector3(p.x, 0, p.z));
    this.preview = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), this.previewMat);
    this.preview.computeLineDistances();
    this.scene.add(this.preview);
  }

  setGhost(g: { x: number; z: number; radius: number } | null) {
    this.ghost.visible = !!g;
    if (g) { this.ghost.position.set(g.x, 0.05, g.z); this.ghost.scale.setScalar(g.radius / 3); }
  }

  setWon(won: boolean) { this.won = won; }

  clearBeam() {
    if (this.beam) { this.scene.remove(this.beam); this.beam.geometry.dispose(); this.beam = null; }
    this.spark.visible = false;
  }

  showBeam(res: TraceResult) {
    this.clearBeam();
    this.beam = new THREE.Mesh(beamGeometry(res.pts), this.beamMat);
    this.scene.add(this.beam);
  }

  fire(res: TraceResult): Promise<void> {
    this.clearBeam();
    const geo = beamGeometry(res.pts);
    this.beam = new THREE.Mesh(geo, this.beamMat); geo.setDrawRange(0, 0); this.scene.add(this.beam);
    return new Promise((done) => {
      this.firing = { pts: res.pts, t0: performance.now(), dur: this.reduceMotion ? 200 : Math.min(2600, 500 + res.pts.length * 1.6), total: geo.index!.count, done: () => {
        const last = res.pts[res.pts.length - 1];
        const color = res.result === 'hit' ? BEACON : res.result === 'rock' ? 0xff9a6e : 0xff4f6e;
        if (res.result !== 'lost') this.flashAt(last, color);
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
      const F = this.firing, k = Math.max(0, Math.min(1, (now - F.t0) / F.dur));
      this.beam!.geometry.setDrawRange(0, Math.floor((F.total * k) / 6) * 6);
      const P = F.pts[Math.min(F.pts.length - 1, Math.floor(k * (F.pts.length - 1)))];
      this.spark.visible = true; this.spark.position.set(P.x, 0, P.z); this.spark.scale.setScalar(1 + Math.sin(now * 0.04) * 0.25);
      if (k >= 1) { this.spark.visible = false; this.beam!.geometry.setDrawRange(0, Infinity); this.firing = null; F.done(); }
    }
    if (this.flashT > 0) {
      const k = Math.max(0, (now - this.flashT) / 700);
      const m = this.flash.material as THREE.MeshBasicMaterial;
      if (k >= 1) { m.opacity = 0; this.flashT = -1; } else { m.opacity = (1 - k) * 0.9; this.flash.scale.setScalar(0.4 + k * 3); }
    }
    if (this.beam && !this.firing) this.beamMat.color.copy(LASER).multiplyScalar(2.2 + Math.sin(t * 9) * 0.35);
    this.controls.update();
    this.composer.render();
    this.raf = requestAnimationFrame(this.tick);
  };
}
