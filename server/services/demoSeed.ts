import type {
  BoardCard,
  ChatMessage,
  FormulaLabData,
  QuizData,
  StudyArtifact,
  Workspace,
} from '../../src/types/study.js';

export const DEMO_WORKSPACE_ID = 'demo-vectors-em';

export const DEMO_3D_SCENE_HTML = `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: radial-gradient(circle at top, #111b33 0%, #070b14 100%); color: #e2e8f0; font-family: system-ui, -apple-system, sans-serif; overflow: hidden; height: 100vh; }
  #canvas-wrap { width: 100vw; height: 100vh; position: relative; }
  .hud {
    position: fixed; top: 14px; left: 14px; width: 270px;
    background: rgba(15, 23, 42, 0.84); backdrop-filter: blur(10px);
    border: 1px solid rgba(148, 163, 184, 0.22); border-radius: 14px;
    padding: 14px; font-size: 12px; z-index: 10;
    box-shadow: 0 12px 32px rgba(0,0,0,0.45);
  }
  .hud h2 { font-size: 14px; font-weight: 700; color: #f8fafc; margin-bottom: 4px; }
  .hud p.sub { font-size: 11px; color: #94a3b8; margin-bottom: 10px; line-height: 1.4; }
  .control { margin-bottom: 9px; }
  .control label { display: flex; justify-content: space-between; font-size: 11px; color: #cbd5e1; margin-bottom: 3px; }
  .control input[type="range"] { width: 100%; accent-color: #6366f1; }
  .legend { display: flex; flex-direction: column; gap: 5px; margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(148,163,184,0.16); }
  .legend-item { display: flex; align-items: center; gap: 8px; font-size: 11px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  .readout {
    margin-top: 10px; padding: 8px 10px; border-radius: 10px;
    background: rgba(99, 102, 241, 0.14); border: 1px solid rgba(99, 102, 241, 0.35);
    font-family: ui-monospace, monospace; font-size: 11.5px; color: #e0e7ff;
  }
  .hint-bar {
    position: fixed; bottom: 12px; right: 14px;
    background: rgba(15, 23, 42, 0.72); border: 1px solid rgba(148,163,184,0.2);
    padding: 6px 12px; border-radius: 999px; font-size: 11px; color: #94a3b8;
  }
</style>
</head>
<body>
<div id="canvas-wrap"></div>
<div class="hud">
  <h2>3D Vektörel Çarpım & Lorentz Kuvveti</h2>
  <p class="sub">F = q (v × B) — Hız (v) ve Manyetik Alan (B) arasındaki açıyı değiştirerek kuvvetin yönünü ve büyüklüğünü 3B incele.</p>
  <div class="control">
    <label><span>Hız Büyüklüğü |v|</span><strong id="vVal">3.0</strong></label>
    <input id="vMag" type="range" min="0.5" max="4.5" step="0.1" value="3.0" />
  </div>
  <div class="control">
    <label><span>Manyetik Alan |B|</span><strong id="bVal">2.5</strong></label>
    <input id="bMag" type="range" min="0.5" max="4.0" step="0.1" value="2.5" />
  </div>
  <div class="control">
    <label><span>v ile B Arası Açı (θ)</span><strong id="angleVal">65°</strong></label>
    <input id="theta" type="range" min="0" max="180" step="1" value="65" />
  </div>
  <div class="control">
    <label><span>Yük İşareti (q)</span><strong id="qVal">+1 (Pozitif)</strong></label>
    <input id="charge" type="range" min="-1" max="1" step="2" value="1" />
  </div>
  <div class="readout" id="readout">|F| = |q|·|v|·|B|·sin(θ) = 6.80 N</div>
  <div class="legend">
    <div class="legend-item"><span class="dot" style="background:#38bdf8"></span><span><strong>v</strong> — Parçacık Hızı (XZ düzlemi)</span></div>
    <div class="legend-item"><span class="dot" style="background:#fbbf24"></span><span><strong>B</strong> — Manyetik Alan (+X ekseni)</span></div>
    <div class="legend-item"><span class="dot" style="background:#f43f5e"></span><span><strong>F = q(v × B)</strong> — Lorentz Kuvveti (±Y)</span></div>
    <div class="legend-item"><span class="dot" style="background:#818cf8"></span><span>Paralelkenar Alanı = |v × B|</span></div>
  </div>
</div>
<div class="hint-bar">Fareyle sürükle: Döndür • Tekerlek: Yakınlaştır • Sağ tık: Kaydır</div>

<script type="module">
  import * as THREE from 'three';
  import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

  const container = document.getElementById('canvas-wrap');
  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(46, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(6.5, 5.2, 7.2);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.target.set(0, 0.6, 0);

  // Lights
  scene.add(new THREE.AmbientLight(0xffffff, 0.65));
  const dirLight = new THREE.DirectionalLight(0xe0e7ff, 1.2);
  dirLight.position.set(8, 12, 6);
  scene.add(dirLight);

  // Grid and axes
  const grid = new THREE.GridHelper(12, 12, 0x334155, 0x1e293b);
  scene.add(grid);

  const originSphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.24, 32, 32),
    new THREE.MeshStandardMaterial({ color: 0x34d399, emissive: 0x065f46, roughness: 0.25, metalness: 0.3 })
  );
  scene.add(originSphere);

  // Helper to build thick 3D arrow
  function createThickArrow(color) {
    const group = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.3, metalness: 0.2 });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1, 20), mat);
    shaft.position.y = 0.5;
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.48, 24), mat);
    head.position.y = 1.2;
    group.add(shaft, head);
    group.userData = { shaft, head };
    return group;
  }

  function setArrowVector(arrow, vec) {
    const len = vec.length();
    if (len < 0.05) {
      arrow.visible = false;
      return;
    }
    arrow.visible = true;
    const shaftLen = Math.max(0.05, len - 0.45);
    arrow.userData.shaft.scale.set(1, shaftLen, 1);
    arrow.userData.shaft.position.y = shaftLen / 2;
    arrow.userData.head.position.y = shaftLen + 0.22;
    const dir = vec.clone().normalize();
    arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  }

  const arrowB = createThickArrow(0xfbbf24);
  const arrowV = createThickArrow(0x38bdf8);
  const arrowF = createThickArrow(0xf43f5e);
  scene.add(arrowB, arrowV, arrowF);

  // Parallelogram mesh showing |v x B|
  const paraGeo = new THREE.BufferGeometry();
  const paraMat = new THREE.MeshBasicMaterial({
    color: 0x818cf8,
    transparent: true,
    opacity: 0.28,
    side: THREE.DoubleSide,
  });
  const paraMesh = new THREE.Mesh(paraGeo, paraMat);
  scene.add(paraMesh);

  // Particle orbiting slightly along helical hint
  const trailPoints = [];
  const trailGeo = new THREE.BufferGeometry();
  const trailLine = new THREE.Line(
    trailGeo,
    new THREE.LineBasicMaterial({ color: 0xf43f5e, transparent: true, opacity: 0.5 })
  );
  scene.add(trailLine);

  const vMagEl = document.getElementById('vMag');
  const bMagEl = document.getElementById('bMag');
  const thetaEl = document.getElementById('theta');
  const chargeEl = document.getElementById('charge');

  function updateScene() {
    const vMag = parseFloat(vMagEl.value);
    const bMag = parseFloat(bMagEl.value);
    const deg = parseFloat(thetaEl.value);
    const q = parseFloat(chargeEl.value);
    const rad = (deg * Math.PI) / 180;

    document.getElementById('vVal').textContent = vMag.toFixed(1);
    document.getElementById('bVal').textContent = bMag.toFixed(1);
    document.getElementById('angleVal').textContent = deg + '°';
    document.getElementById('qVal').textContent = q > 0 ? '+1 (Pozitif)' : '-1 (Negatif)';
    originSphere.material.color.setHex(q > 0 ? 0x34d399 : 0x60a5fa);

    const vecB = new THREE.Vector3(bMag, 0, 0);
    const vecV = new THREE.Vector3(vMag * Math.cos(rad), 0, vMag * Math.sin(rad));
    // Standard right-hand cross product: v x B
    const vecF = new THREE.Vector3().crossVectors(vecV, vecB).multiplyScalar(q * 0.45);
    const fMagReal = Math.abs(q) * vMag * bMag * Math.sin(rad);

    setArrowVector(arrowB, vecB);
    setArrowVector(arrowV, vecV);
    setArrowVector(arrowF, vecF);

    // Update parallelogram vertices
    const p0 = new THREE.Vector3(0, 0.02, 0);
    const p1 = vecB.clone().setY(0.02);
    const p2 = vecB.clone().add(vecV).setY(0.02);
    const p3 = vecV.clone().setY(0.02);
    const positions = new Float32Array([
      p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z,
      p0.x, p0.y, p0.z, p2.x, p2.y, p2.z, p3.x, p3.y, p3.z,
    ]);
    paraGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    paraGeo.computeVertexNormals();

    // Update dashed curve showing force deflection direction
    trailPoints.length = 0;
    const fDir = vecF.length() > 0.05 ? vecF.clone().normalize() : new THREE.Vector3(0, 0, 0);
    for (let t = 0; t <= 1; t += 0.05) {
      const pt = vecV.clone().multiplyScalar(t * 0.7).add(fDir.clone().multiplyScalar(t * t * vecF.length() * 0.55));
      trailPoints.push(pt);
    }
    trailGeo.setFromPoints(trailPoints);

    const dirLabel = Math.abs(Math.sin(rad)) < 0.02 ? '0 (Paralel!)' : (vecF.y >= 0 ? '+Y (Yukarı)' : '-Y (Aşağı)');
    document.getElementById('readout').innerHTML =
      '|F| = ' + fMagReal.toFixed(2) + ' N<br/>Yön: <strong>' + dirLabel + '</strong>';
  }

  [vMagEl, bMagEl, thetaEl, chargeEl].forEach((el) => el.addEventListener('input', updateScene));
  updateScene();

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();
</script>
</body>
</html>`;

export const DEMO_FORMULA_LAB: FormulaLabData = {
  latex: '\\vec{F} = q (\\vec{v} \\times \\vec{B}), \\quad |F| = |q| \\cdot v \\cdot B \\cdot \\sin(\\theta)',
  subtitle: 'Manyetik Alanda Hareket Eden Yüke Etkiyen Lorentz Kuvveti',
  summary:
    'Bir manyetik alan içindeki elektrik yükü yalnızca hareket ediyorsa ve hızı manyetik alana paralel değilse kuvvet hisseder. Kuvvet hem hıza hem manyetik alana diktir.',
  terms: [
    {
      id: 'F',
      symbol: '\\vec{F}',
      label: 'Manyetik Kuvvet',
      color: '#f43f5e',
      unit: 'Newton (N)',
      meaning: 'Yüklü parçacığın yörüngesini büken kuvvet. Hız vektörüne her zaman dik olduğu için iş yapmaz, sürati değiştirmez.',
      analogy: 'Dönen bir ipe bağlı topu merkeze çeken ip gerilmesi gibi sadece yönü değiştirir.',
    },
    {
      id: 'q',
      symbol: 'q',
      label: 'Elektrik Yükü',
      color: '#34d399',
      unit: 'Coulomb (C)',
      meaning: 'Parçacığın elektrik yükü. Negatif yüklerde kuvvetin yönü sağ el kuralının tam tersine döner.',
      analogy: 'Manyetik alanın parçacığı ne kadar güçlü "yakalayabildiğini" belirleyen kanca büyüklüğü.',
    },
    {
      id: 'v',
      symbol: '\\vec{v}',
      label: 'Parçacık Hızı',
      color: '#38bdf8',
      unit: 'm/s',
      meaning: 'Parçacığın hareket hızı. Parçacık duruyorsa (v = 0) manyetik kuvvet sıfırdır!',
      analogy: 'Suda sabit duran bir dümen yön vermez; akış veya hareket gerekir.',
    },
    {
      id: 'B',
      symbol: '\\vec{B}',
      label: 'Manyetik Alan',
      color: '#fbbf24',
      unit: 'Tesla (T)',
      meaning: 'Uzaydaki manyetik alan şiddeti ve yönü.',
      analogy: 'Parçacığın içinden geçtiği görünmez akıntı çizgileri.',
    },
    {
      id: 'sin',
      symbol: '\\sin(\\theta)',
      label: 'Açı Faktörü',
      color: '#818cf8',
      unit: 'Birim yok (0–1)',
      meaning: 'Hız ile manyetik alan arasındaki açının sinüsü. 90° iken maksimum kuvvet, 0° veya 180° iken sıfır kuvvet oluşur.',
      analogy: 'Rüzgara dik tutulan yelken en fazla itmeyi alır, rüzgara paralel tutulursa hiç itme almaz.',
    },
  ],
  parameters: [
    { name: 'q', symbol: 'q', label: 'Yük (mC)', min: 1, max: 10, step: 0.5, defaultValue: 2, unit: 'mC' },
    { name: 'v', symbol: 'v', label: 'Hız', min: 0, max: 20, step: 1, defaultValue: 10, unit: 'm/s' },
    { name: 'B', symbol: 'B', label: 'Manyetik Alan', min: 0.5, max: 5, step: 0.5, defaultValue: 2, unit: 'T' },
    { name: 'theta', symbol: 'θ', label: 'Açı (Derece)', min: 0, max: 180, step: 5, defaultValue: 90, unit: '°' },
  ],
  expression: 'q * 0.001 * v * B * Math.sin(theta * Math.PI / 180)',
  resultLabel: 'Hesaplanan Kuvvet |F|',
  resultUnit: 'N',
  steps: [
    {
      title: '1. Vektörel Çarpımın Büyüklüğünü Yaz',
      latex: '|\\vec{v} \\times \\vec{B}| = v \\cdot B \\cdot \\sin(\\theta)',
      explanation: 'İki vektörün vektörel çarpımının büyüklüğü, oluşturdukları paralelkenarın alanına eşittir.',
    },
    {
      title: '2. Sağ El Kuralı ile Yönü Bul',
      latex: '\\hat{n} = \\frac{\\vec{v} \\times \\vec{B}}{|\\vec{v} \\times \\vec{B}|}',
      explanation: 'Sağ elinin dört parmağını v yönüne uzatıp B yönüne kıvırdığında başparmağın pozitif yük için kuvvet yönünü gösterir.',
    },
    {
      title: '3. Yük İşaretini Uygula',
      latex: '\\vec{F} = q (\\vec{v} \\times \\vec{B})',
      explanation: 'Eğer parçacık elektron gibi negatif yüklü (q < 0) ise elde edilen yönü tam tersine çevir.',
    },
  ],
};

export const DEMO_QUIZ_DATA: QuizData = {
  topic: 'Vektörel Çarpım ve Lorentz Kuvveti',
  difficulty: 'orta',
  questions: [
    {
      id: 'q1',
      type: 'mcq',
      prompt: 'Manyetik alan çizgilerine paralel (θ = 0°) hareket eden pozitif bir protona etkiyen manyetik kuvvet kaç Newton olur?',
      latex: 'F = q v B \\sin(0^\\circ)',
      options: [
        'Maksimum değere (qvB) ulaşır',
        '0 N (Hiç kuvvet etki etmez)',
        'Hızın karesiyle orantılı olur',
        'Manyetik alana ters yönde etki eder',
      ],
      correctIndex: 1,
      hints: [
        'Formüldeki açı terimini (sin θ) kontrol et.',
        'sin(0°) değerinin kaç olduğunu hatırla.',
      ],
      explanation: 'Hız vektörü manyetik alana paralel olduğunda θ = 0° ve sin(0°) = 0 olduğundan Lorentz kuvveti F = 0 N olur.',
    },
    {
      id: 'q2',
      type: 'mcq',
      prompt: 'Düzgün bir manyetik alana dik giren yüklü parçacığın kinetik enerjisi neden değişmez?',
      options: [
        'Çünkü manyetik alan parçacığın yükünü sıfırlar',
        'Çünkü manyetik kuvvet her an hız vektörüne diktir ve iş yapmaz',
        'Çünkü parçacık hemen durur',
        'Çünkü yerçekimi kuvveti manyetik kuvveti dengeler',
      ],
      correctIndex: 1,
      hints: [
        'Fizikte yapılan iş W = F · d · cos(α) ile hesaplanır.',
        'Kuvvet ile hareket yönü arasındaki açı kaç derecedir?',
      ],
      explanation: 'Lorentz kuvveti her zaman hız vektörüne dik (90°) olduğundan yapılan iş sıfırdır; parçacığın sürati ve kinetik enerjisi sabit kalır, sadece yönü değişerek çembersel hareket yapar.',
    },
  ],
};

export const DEMO_STUDY_NOTE = `# Elektromanyetizma — Ders Notu 01: Lorentz Kuvveti

## Temel Kavramlar
- Manyetik alan içindeki bir elektrik yüküne etkiyen kuvvet **Lorentz kuvveti** olarak adlandırılır.
- Formül: \`F = q (v × B)\`
- Kuvvetin büyüklüğü: \`|F| = |q| · v · B · sin(θ)\`

## Dikkat Edilecek Noktalar
1. **Duran yükler** (v = 0) manyetik kuvvet hissetmez.
2. Manyetik alana **paralel** (θ = 0° veya 180°) hareket eden yüklere kuvvet etki etmez.
3. Kuvvet daima hem **v** hem **B** vektörüne diktir → bu yüzden manyetik kuvvet **iş yapmaz**, parçacığın sadece yönünü değiştirir.
4. **Elektron (q < 0)** için sağ el kuralıyla bulunan yönün **tam tersi** alınır.

## Örnek Soru
2 mC yüklü bir parçacık, 2 T şiddetindeki manyetik alana 90° açıyla 10 m/s hızla giriyor. Parçacığa etkiyen kuvveti bulun ve yönünü 3B olarak yorumlayın.
`;

export function buildDemoWorkspaceSeed(): {
  workspace: Workspace;
  artifacts: StudyArtifact[];
  messages: ChatMessage[];
  cards: BoardCard[];
} {
  const now = new Date().toISOString();

  const workspace: Workspace = {
    id: DEMO_WORKSPACE_ID,
    title: 'Fizik II — Vektörler ve Alanlar',
    subject: 'Elektromanyetizma',
    color: '#6366f1',
    icon: 'atom',
    studyMode: 'visual',
    createdAt: now,
    updatedAt: now,
  };

  const artifact3D: StudyArtifact = {
    id: 'demo-art-3d',
    workspaceId: DEMO_WORKSPACE_ID,
    type: '3d-scene',
    title: '3D Vektörel Çarpım & Lorentz Kuvveti',
    version: 1,
    content: DEMO_3D_SCENE_HTML,
    createdAt: now,
    sourceMessageId: 'demo-msg-2',
  };

  const artifactFormula: StudyArtifact = {
    id: 'demo-art-formula',
    workspaceId: DEMO_WORKSPACE_ID,
    type: 'formula-lab',
    title: 'Lorentz Kuvveti Formül Laboratuvarı',
    version: 1,
    content: JSON.stringify(DEMO_FORMULA_LAB, null, 2),
    parsedData: DEMO_FORMULA_LAB,
    createdAt: now,
    sourceMessageId: 'demo-msg-2',
  };

  const artifactQuiz: StudyArtifact = {
    id: 'demo-art-quiz',
    workspaceId: DEMO_WORKSPACE_ID,
    type: 'quiz',
    title: 'Hızlı Kavram Testi: Lorentz Kuvveti',
    version: 1,
    content: JSON.stringify(DEMO_QUIZ_DATA, null, 2),
    parsedData: DEMO_QUIZ_DATA,
    createdAt: now,
    sourceMessageId: 'demo-msg-2',
  };

  const messages: ChatMessage[] = [
    {
      id: 'demo-msg-1',
      role: 'user',
      content: 'Lorentz kuvvetindeki vektörel çarpımı 3 boyutlu olarak gösterebilir misin? Ayrıca formülü parçalara ayırıp anlat.',
      createdAt: now,
      studyMode: 'visual',
    },
    {
      id: 'demo-msg-2',
      role: 'assistant',
      content: '',
      displayContent:
        'Harika bir konu! **Lorentz kuvveti** ($\\vec{F} = q(\\vec{v} \\times \\vec{B})$) üç boyutlu düşünmeyi gerektirir. Senin için üç etkileşimli materyal hazırladım:\n\n' +
        '1. **3D Etkileşimli Model:** Ortadaki 3D sahnede fareyle döndürerek $\\vec{v}$ ve $\\vec{B}$ vektörleri arasındaki açıyı ($\\theta$) ve yük işaretini ($q$) değiştirebilirsin.\n' +
        '2. **Formül Laboratuvarı:** Her terimin üstüne tıklayarak ne anlama geldiğini ve sürgülerle kuvvetin nasıl değiştiğini görebilirsin.\n' +
        '3. **Mini Test:** Konuyu pekiştirmek için 2 soruluk hızlı bir alıştırma ekledim.\n\n' +
        '> **İpucu:** Anlamadığın bir yer olursa üstteki **İşaretle (Kalem)** butonuna basıp doğrudan 3D modelin veya ders notunun üzerini çizebilir ve **"İşaretli Alanı Sor"** diyebilirsin!',
      createdAt: now,
      studyMode: 'visual',
      artifactIds: [artifact3D.id, artifactFormula.id, artifactQuiz.id],
    },
  ];

  const cards: BoardCard[] = [
    {
      id: 'demo-card-1',
      author: 'ai',
      kind: 'step',
      title: 'Birlikte Çözelim — Örnek',
      content:
        'q = +2 mC yük, v = 10 m/s hızla B = 2 T manyetik alana 30° açıyla giriyor. Tahtaya kendi çözüm adımlarını çizip "Adımımı Kontrol Et" butonuna basabilirsin!',
      latex: '|F| = |q| \\cdot v \\cdot B \\cdot \\sin(30^\\circ)',
      x: 40,
      y: 40,
      color: '#6366f1',
      createdAt: now,
    },
  ];

  return {
    workspace,
    artifacts: [artifact3D, artifactFormula, artifactQuiz],
    messages,
    cards,
  };
}
