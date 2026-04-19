/* ── viewer.js – glitch-free + Object & Material selection ── */
(function () {
  'use strict';

  const canvas = document.getElementById('renderCanvas');

  // ── Renderer ──────────────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias:              true,
    alpha:                  false,
    logarithmicDepthBuffer: true,
    powerPreference:        'high-performance'
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputEncoding      = THREE.sRGBEncoding;
  renderer.toneMapping         = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled   = false;
  renderer.physicallyCorrectLights = true;

  // ── Scene ─────────────────────────────────────────────────
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111116);

  // ── Camera ────────────────────────────────────────────────
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
  camera.position.set(10, 6, 15);

  // ── Controls ──────────────────────────────────────────────
  const controls = new THREE.OrbitControls(camera, canvas);
  controls.enableDamping      = true;
  controls.dampingFactor      = 0.05;
  controls.screenSpacePanning = true;
  controls.zoomSpeed          = 1.2;
  controls.rotateSpeed        = 0.8;
  controls.panSpeed           = 0.8;
  controls.maxPolarAngle      = Math.PI * 0.95;
  controls.minDistance        = 0.01;
  controls.maxDistance        = 50000;

  // ── Lighting ──────────────────────────────────────────────
  const hemi = new THREE.HemisphereLight(0xd4eaff, 0x3a3020, 0.6);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff4e0, 1.8);
  sun.position.set(1, 2, 1.5);
  scene.add(sun);

  const sunMarkerGeo = new THREE.SphereGeometry(0.18, 12, 8);
  const sunMarkerMat = new THREE.MeshBasicMaterial({ color: 0xffdd88 });
  const sunMarker    = new THREE.Mesh(sunMarkerGeo, sunMarkerMat);
  sunMarker.visible  = false;
  scene.add(sunMarker);

  const rimA = new THREE.DirectionalLight(0x8090ff, 0.4);
  rimA.position.set(-1, 0.5, -1);
  scene.add(rimA);
  const rimB = new THREE.DirectionalLight(0x4fffb0, 0.15);
  rimB.position.set(0.5, -1, 0.5);
  scene.add(rimB);

  // ── Grid ──────────────────────────────────────────────────
  const grid = new THREE.GridHelper(200, 80, 0x252535, 0x1a1a28);
  scene.add(grid);

  // ── Raycaster ─────────────────────────────────────────────
  const raycaster = new THREE.Raycaster();
  raycaster.params.Mesh.threshold = 0;
  const mouse = new THREE.Vector2();

  // ── Render state (BEFORE resize) ──────────────────────────
  let needsRender = true;
  let sunAngle    = 0;
  let sunRotating = false;
  let sunOn       = true;

  // ── Resize ────────────────────────────────────────────────
  function resize() {
    const w = canvas.parentElement.clientWidth;
    const h = canvas.parentElement.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    canvas.style.width  = w + 'px';
    canvas.style.height = h + 'px';
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    needsRender = true;
  }
  window.addEventListener('resize', resize);
  resize();

  // ── Render loop ───────────────────────────────────────────
  controls.addEventListener('change', () => { needsRender = true; });

  function loop() {
    requestAnimationFrame(loop);
    if (sunRotating) {
      sunAngle += 0.005;
      const r = sun._orbitR || 3;
      sun.position.set(Math.cos(sunAngle) * r, r * 0.8, Math.sin(sunAngle) * r);
      sunMarker.position.copy(sun.position);
      needsRender = true;
    }
    if (controls.update()) needsRender = true;
    if (needsRender) { renderer.render(scene, camera); needsRender = false; }
  }
  loop();

  function forceRender() { needsRender = true; }

  // ── State ─────────────────────────────────────────────────
  const loadedModels = {};
  const modelVisible  = {};
  const colVisible    = {};
  const nodeVisible   = {};
  const loader        = new THREE.GLTFLoader();

  const loadScreen = document.getElementById('loadingScreen');
  const loadLabel  = document.getElementById('loadingLabel');
  const welcome    = document.getElementById('welcomeScreen');
  const infoLabel  = document.getElementById('modelInfoLabel');

  function showLoad(msg) { loadLabel.textContent = msg; loadScreen.classList.remove('hidden'); }
  function hideLoad()    { loadScreen.classList.add('hidden'); }
  function showInfo(msg) { infoLabel.textContent = msg; infoLabel.classList.add('show'); }

  // ── Camera frustum ────────────────────────────────────────
  function adjustCameraFrustum(box) {
    const size   = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    camera.near = Math.max(maxDim * 0.0001, 0.001);
    camera.far  = maxDim * 1000;
    camera.updateProjectionMatrix();
    controls.minDistance = camera.near * 10;
    controls.maxDistance = camera.far  * 0.5;
  }

  function fitCamera(obj) {
    const box    = new THREE.Box3().setFromObject(obj);
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(...box.getSize(new THREE.Vector3()).toArray());
    if (!maxDim) return;
    adjustCameraFrustum(box);
    const dist = Math.abs(maxDim / Math.sin(camera.fov * Math.PI / 360)) * 0.6;
    camera.position.set(center.x + dist * 0.6, center.y + dist * 0.35, center.z + dist * 0.8);
    controls.target.copy(center);
    controls.update();
    grid.position.y = box.min.y;
    grid.scale.setScalar((maxDim * 3) / 200);
    const r = maxDim * 1.5;
    sun._orbitR = r;
    sunMarker.scale.setScalar(Math.max(maxDim * 0.04, 0.1));
    sun.position.set(r, maxDim, r * 0.8);
    sunMarker.position.copy(sun.position);
    forceRender();
  }

  // ── Material fix ──────────────────────────────────────────
  function fixMaterials(group) {
    const maxAniso = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);
    group.traverse(child => {
      if (!child.isMesh) return;
      child.frustumCulled = true;
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach(mat => {
        if (!mat) return;
        ['map','normalMap','roughnessMap','metalnessMap','aoMap','emissiveMap'].forEach(k => {
          if (mat[k]) { mat[k].anisotropy = maxAniso; mat[k].needsUpdate = true; }
        });
        if (mat.transparent) { mat.depthWrite = false; mat.alphaTest = mat.alphaTest || 0.1; mat.side = THREE.DoubleSide; }
        else mat.depthWrite = true;
        mat.polygonOffset = true; mat.polygonOffsetFactor = 1; mat.polygonOffsetUnits = 1;
        mat.needsUpdate = true;
      });
    });
  }

  // ── Name map ──────────────────────────────────────────────
  function buildNameMap(gltfScene) {
    const map = {};
    gltfScene.traverse(obj => {
      if (obj.name) { if (!map[obj.name]) map[obj.name] = []; map[obj.name].push(obj); }
    });
    return map;
  }

  // ── Load GLTF ─────────────────────────────────────────────
  window.loadGLTF = function (url, key, name, onDone) {
    showLoad('Loading ' + name + '…');
    loader.load(url,
      gltf => {
        const group = gltf.scene;
        fixMaterials(group);
        if (loadedModels[key]) scene.remove(loadedModels[key].group);
        loadedModels[key] = { group, nameMap: buildNameMap(group) };
        modelVisible[key] = true;
        scene.add(group);
        welcome.classList.add('gone');
        hideLoad();
        fitCamera(group);
        const box = new THREE.Box3().setFromObject(group);
        const sz  = box.getSize(new THREE.Vector3());
        showInfo(name + '  ' + sz.x.toFixed(2) + ' × ' + sz.y.toFixed(2) + ' × ' + sz.z.toFixed(2));
        forceRender();
        if (onDone) onDone(group);
      },
      xhr => { if (xhr.total) loadLabel.textContent = 'Loading ' + name + '… ' + Math.round(xhr.loaded / xhr.total * 100) + '%'; },
      err  => { hideLoad(); console.error(err); alert('Failed to load: ' + name); }
    );
  };

  // ── Visibility ────────────────────────────────────────────
  window.syncModelVis = function (key, ci) {
    const m = loadedModels[key];
    if (m) { m.group.visible = (modelVisible[key] !== false) && (colVisible[ci] !== false); forceRender(); }
  };
  window.setNodeVis = function (ci, oi, ni, nodeName, v) {
    nodeVisible[ci+'-'+oi+'-'+ni] = v;
    const m = loadedModels[ci+'-'+oi];
    if (!m) return;
    (m.nameMap[nodeName] || []).forEach(o => { o.visible = v; });
    forceRender();
  };
  window.setModelVis     = (key, v) => { modelVisible[key] = v; };
  window.setColVis       = (ci, v)  => { colVisible[ci]    = v; };
  window.getLoadedModels = ()       => loadedModels;
  window.fitCamera       = fitCamera;

  // ════════════════════════════════════════════════════════════
  // ── HIGHLIGHT ENGINE
  // Two modes: 'object' (one mesh) | 'material' (all same-mat meshes)
  // ════════════════════════════════════════════════════════════

  // Highlight colors
  const HL_OBJECT   = new THREE.Color(0x00e5ff);  // cyan  – object select
  const HL_MATERIAL = new THREE.Color(0xff9000);  // amber – material select

  // Save/restore emissive per-mesh
  const savedEmissive = new WeakMap(); // mesh → [{color, intensity}]

  function saveAndHighlight(mesh, color) {
    // Save original if not already saved
    if (!savedEmissive.has(mesh)) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      savedEmissive.set(mesh, mats.map(m => ({
        color:     m.emissive ? m.emissive.clone() : new THREE.Color(0,0,0),
        intensity: m.emissiveIntensity != null ? m.emissiveIntensity : 0
      })));
    }
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    mats.forEach(m => {
      if (!m.emissive) return;
      m.emissive.set(color);
      m.emissiveIntensity = 0.65;
      m.needsUpdate = true;
    });
  }

  function restoreHighlight(mesh) {
    const saved = savedEmissive.get(mesh);
    if (!saved) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    mats.forEach((m, i) => {
      if (!m.emissive) return;
      m.emissive.copy(saved[i] ? saved[i].color : new THREE.Color(0,0,0));
      m.emissiveIntensity = saved[i] ? saved[i].intensity : 0;
      m.needsUpdate = true;
    });
  }

  // Currently highlighted meshes (array for material mode)
  let highlightedMeshes = [];

  function clearHighlights() {
    highlightedMeshes.forEach(restoreHighlight);
    highlightedMeshes = [];
  }

  // ── Selection state ───────────────────────────────────────
  let selectMode = 'none'; // 'none' | 'object' | 'material'

  const selectObjBtn = document.getElementById('selectObjBtn');
  const selectMatBtn = document.getElementById('selectMatBtn');

  function setSelectMode(mode) {
    if (selectMode === mode) {
      // Toggle off
      selectMode = 'none';
    } else {
      selectMode = mode;
    }
    clearHighlights();
    hidePropsPanels();
    selectObjBtn.classList.toggle('active', selectMode === 'object');
    selectMatBtn.classList.toggle('active', selectMode === 'material');
    canvas.style.cursor = selectMode !== 'none' ? 'crosshair' : 'default';
    forceRender();
  }

  selectObjBtn.addEventListener('click', () => setSelectMode('object'));
  selectMatBtn.addEventListener('click', () => setSelectMode('material'));

  function hidePropsPanels() {
    document.getElementById('propsObjPanel').classList.add('hidden');
    document.getElementById('propsMatPanel').classList.add('hidden');
  }

  // ── Collect all scene meshes for raycasting ───────────────
  function getAllMeshes() {
    const meshes = [];
    scene.traverse(obj => {
      if (obj.isMesh && obj.visible && obj !== sunMarker) meshes.push(obj);
    });
    return meshes;
  }

  // ── Get material UUID — unique identifier per material instance
  function matUID(mat) {
    return mat.uuid;
  }

  // ── Find all meshes sharing any material with the hit mesh ─
  function getMeshesByMaterial(hitMesh) {
    // Collect all material UUIDs from the hit mesh
    const hitMats = Array.isArray(hitMesh.material) ? hitMesh.material : [hitMesh.material];
    const hitUUIDs = new Set(hitMats.map(m => m.uuid));

    const result = [];
    scene.traverse(obj => {
      if (!obj.isMesh || obj === sunMarker) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      if (mats.some(m => hitUUIDs.has(m.uuid))) result.push(obj);
    });
    return result;
  }

  // ── Pointer handling ──────────────────────────────────────
  let pointerDown = null;

  canvas.addEventListener('pointerdown', e => {
    pointerDown = { x: e.clientX, y: e.clientY };
  });

  canvas.addEventListener('pointerup', e => {
    if (selectMode === 'none' || !pointerDown) return;
    const dx = Math.abs(e.clientX - pointerDown.x);
    const dy = Math.abs(e.clientY - pointerDown.y);
    pointerDown = null;
    if (dx > 5 || dy > 5) return; // drag, not click

    // Compute NDC
    const rect = canvas.getBoundingClientRect();
    mouse.set(
       ((e.clientX - rect.left) / rect.width)  * 2 - 1,
      -((e.clientY - rect.top)  / rect.height) * 2 + 1
    );
    raycaster.setFromCamera(mouse, camera);

    const hits = raycaster.intersectObjects(getAllMeshes(), false);

    if (hits.length === 0) {
      clearHighlights();
      hidePropsPanels();
      forceRender();
      return;
    }

    const hit  = hits[0];
    const mesh = hit.object;

    clearHighlights();

    if (selectMode === 'object') {
      // ── Object mode: highlight ONE mesh, show object panel
      saveAndHighlight(mesh, HL_OBJECT);
      highlightedMeshes = [mesh];
      showObjectPanel(mesh, hit);

    } else if (selectMode === 'material') {
      // ── Material mode: highlight ALL meshes with same material
      const peers = getMeshesByMaterial(mesh);
      peers.forEach(m => saveAndHighlight(m, HL_MATERIAL));
      highlightedMeshes = peers;
      showMaterialPanel(mesh, peers, hit);
    }

    forceRender();
  });

  // ── OBJECT PROPERTIES PANEL ───────────────────────────────
  function showObjectPanel(mesh, hit) {
    document.getElementById('propsMatPanel').classList.add('hidden');
    const panel = document.getElementById('propsObjPanel');
    panel.classList.remove('hidden');

    const geo       = mesh.geometry;
    const mats      = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const verts     = geo.attributes.position ? geo.attributes.position.count : 0;
    const tris      = geo.index ? Math.round(geo.index.count / 3) : Math.round(verts / 3);
    const box       = new THREE.Box3().setFromObject(mesh);
    const size      = box.getSize(new THREE.Vector3());
    const center    = box.getCenter(new THREE.Vector3());

    // Walk world matrix to get actual position
    const worldPos  = new THREE.Vector3();
    mesh.getWorldPosition(worldPos);
    const worldScale = new THREE.Vector3();
    mesh.getWorldScale(worldScale);

    // Resolve model name
    let modelLabel = '—';
    Object.entries(loadedModels).forEach(([key, m]) => {
      m.group.traverse(c => { if (c === mesh) modelLabel = key; });
    });

    // Parent chain
    let parent = mesh.parent;
    const parentNames = [];
    while (parent && parent !== scene) {
      if (parent.name) parentNames.unshift(parent.name);
      parent = parent.parent;
    }

    const matName    = mats.map(m => m.name || '(unnamed)').join(' | ');
    const matCount   = mats.length;
    const hasTex     = mats.some(m => m.map != null);
    const roughness  = mats[0] && mats[0].roughness != null ? mats[0].roughness.toFixed(3) : '—';
    const metalness  = mats[0] && mats[0].metalness != null ? mats[0].metalness.toFixed(3) : '—';
    const isTransp   = mats.some(m => m.transparent);
    const doubleSide = mats.some(m => m.side === THREE.DoubleSide);
    const hasBump    = mats.some(m => m.normalMap != null);
    const hasAO      = mats.some(m => m.aoMap != null);

    const s = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };

    // Object section
    s('obj_name',      mesh.name || '(unnamed)');
    s('obj_model',     modelLabel);
    s('obj_parent',    parentNames.join(' › ') || '—');
    s('obj_uuid',      mesh.uuid.slice(0, 12) + '…');
    s('obj_visible',   mesh.visible ? 'Yes' : 'No');
    s('obj_shadow',    mesh.castShadow ? 'Yes' : 'No');
    // Mesh section
    s('obj_verts',     verts.toLocaleString());
    s('obj_tris',      tris.toLocaleString());
    s('obj_groups',    (geo.groups ? geo.groups.length : 1).toString());
    s('obj_hasNorm',   geo.attributes.normal ? 'Yes' : 'No');
    s('obj_hasUV',     geo.attributes.uv ? 'Yes' : 'No');
    // Material section
    s('obj_matname',   matName);
    s('obj_matcount',  matCount.toString());
    s('obj_mattype',   mats.map(m => m.type).join(' | '));
    s('obj_rough',     roughness);
    s('obj_metal',     metalness);
    s('obj_tex',       hasTex ? 'Yes' : 'No');
    s('obj_bump',      hasBump ? 'Yes' : 'No');
    s('obj_ao',        hasAO ? 'Yes' : 'No');
    s('obj_transp',    isTransp ? 'Yes' : 'No');
    s('obj_double',    doubleSide ? 'Yes' : 'No');
    // Transform section
    s('obj_wx',        worldPos.x.toFixed(3));
    s('obj_wy',        worldPos.y.toFixed(3));
    s('obj_wz',        worldPos.z.toFixed(3));
    s('obj_sx',        size.x.toFixed(3));
    s('obj_sy',        size.y.toFixed(3));
    s('obj_sz',        size.z.toFixed(3));
    s('obj_cx',        center.x.toFixed(3));
    s('obj_cy',        center.y.toFixed(3));
    s('obj_cz',        center.z.toFixed(3));
    s('obj_hx',        hit.point.x.toFixed(3));
    s('obj_hy',        hit.point.y.toFixed(3));
    s('obj_hz',        hit.point.z.toFixed(3));
    s('obj_dist',      hit.distance.toFixed(3));

    // Highlight hit-point face normal
    if (hit.face) {
      const fn = hit.face.normal;
      s('obj_fnx', fn.x.toFixed(3));
      s('obj_fny', fn.y.toFixed(3));
      s('obj_fnz', fn.z.toFixed(3));
    } else {
      s('obj_fnx','—'); s('obj_fny','—'); s('obj_fnz','—');
    }
  }

  // ── MATERIAL PROPERTIES PANEL ─────────────────────────────
  function showMaterialPanel(mesh, peers, hit) {
    document.getElementById('propsObjPanel').classList.add('hidden');
    const panel = document.getElementById('propsMatPanel');
    panel.classList.remove('hidden');

    const mats    = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const mat     = mats[0]; // primary material

    const s = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };

    // Material identity
    s('mat_name',     mat.name || '(unnamed)');
    s('mat_uuid',     mat.uuid.slice(0, 12) + '…');
    s('mat_type',     mat.type || '—');
    s('mat_side',     mat.side === THREE.DoubleSide ? 'Double' : mat.side === THREE.BackSide ? 'Back' : 'Front');
    s('mat_transp',   mat.transparent ? 'Yes' : 'No');
    s('mat_opacity',  mat.opacity != null ? mat.opacity.toFixed(2) : '—');
    s('mat_depthW',   mat.depthWrite ? 'Yes' : 'No');
    s('mat_depthT',   mat.depthTest ? 'Yes' : 'No');
    s('mat_wire',     mat.wireframe ? 'Yes' : 'No');

    // PBR properties
    s('mat_rough',    mat.roughness != null ? mat.roughness.toFixed(3) : '—');
    s('mat_metal',    mat.metalness != null ? mat.metalness.toFixed(3) : '—');
    s('mat_envint',   mat.envMapIntensity != null ? mat.envMapIntensity.toFixed(2) : '—');
    s('mat_emiss',    mat.emissiveIntensity != null ? mat.emissiveIntensity.toFixed(2) : '—');
    s('mat_emcol',    mat.emissive ? ('#' + mat.emissive.getHexString()) : '—');

    // Texture maps
    s('mat_hasMap',   mat.map ? '✓' : '—');
    s('mat_hasNorm',  mat.normalMap ? '✓' : '—');
    s('mat_hasRough', mat.roughnessMap ? '✓' : '—');
    s('mat_hasMetal', mat.metalnessMap ? '✓' : '—');
    s('mat_hasAO',    mat.aoMap ? '✓' : '—');
    s('mat_hasEmiss', mat.emissiveMap ? '✓' : '—');
    s('mat_hasBump',  mat.bumpMap ? '✓' : '—');
    s('mat_hasDisp',  mat.displacementMap ? '✓' : '—');

    // Color
    s('mat_color',    mat.color ? ('#' + mat.color.getHexString()) : '—');

    // Shared by: count + names
    s('mat_count',    peers.length.toString() + ' object' + (peers.length !== 1 ? 's' : ''));

    // Fill the shared objects list
    const listEl = document.getElementById('mat_objList');
    if (listEl) {
      listEl.innerHTML = '';
      peers.forEach(m => {
        const li = document.createElement('div');
        li.className = 'mat-obj-item';
        li.innerHTML =
          '<span class="mat-obj-dot"></span>' +
          '<span class="mat-obj-name">' + (m.name || '(unnamed)') + '</span>';
        // Click to re-select that specific object
        li.addEventListener('click', () => {
          clearHighlights();
          saveAndHighlight(m, HL_OBJECT);
          highlightedMeshes = [m];
          selectMode = 'object';
          selectObjBtn.classList.add('active');
          selectMatBtn.classList.remove('active');
          canvas.style.cursor = 'crosshair';
          showObjectPanel(m, { point: new THREE.Vector3(), distance: 0, face: null });
          forceRender();
        });
        listEl.appendChild(li);
      });
    }
  }

  // Close buttons
  document.getElementById('closeObjPanelBtn').addEventListener('click', () => {
    clearHighlights(); hidePropsPanels(); forceRender();
  });
  document.getElementById('closeMatPanelBtn').addEventListener('click', () => {
    clearHighlights(); hidePropsPanels(); forceRender();
  });

  // ════════════════════════════════════════════════════════════
  // ── TOOLBAR — Sun, Brightness
  // ════════════════════════════════════════════════════════════

  const sunToggleBtn = document.getElementById('sunToggleBtn');
  sunToggleBtn.addEventListener('click', () => {
    sunOn = !sunOn;
    sun.visible = sunOn;
    sunMarker.visible = sunOn && sunRotating;
    sunToggleBtn.classList.toggle('active', sunOn);
    forceRender();
  });
  sunToggleBtn.classList.add('active');

  const sunRotateBtn = document.getElementById('sunRotateBtn');
  sunRotateBtn.addEventListener('click', () => {
    sunRotating = !sunRotating;
    sunMarker.visible = sunRotating && sunOn;
    sunRotateBtn.classList.toggle('active', sunRotating);
  });

  const brightnessSlider = document.getElementById('brightnessSlider');
  const brightnessVal    = document.getElementById('brightnessVal');
  brightnessSlider.addEventListener('input', () => {
    const v = parseFloat(brightnessSlider.value);
    brightnessVal.textContent = v.toFixed(1) + 'x';
    renderer.toneMappingExposure = v;
    forceRender();
  });

  // ── Footer ────────────────────────────────────────────────
  document.getElementById('resetCamBtn').addEventListener('click', () => {
    const groups = Object.values(loadedModels).map(m => m.group).filter(g => g.visible);
    if (groups.length) fitCamera(groups[0]);
    else { camera.position.set(10, 6, 15); controls.target.set(0, 0, 0); controls.update(); }
    forceRender();
  });

  const gridBtn = document.getElementById('gridBtn');
  let gridOn = true;
  gridBtn.addEventListener('click', () => {
    gridOn = !gridOn; grid.visible = gridOn;
    gridBtn.classList.toggle('active', gridOn); forceRender();
  });
  gridBtn.classList.add('active');

  const wireBtn = document.getElementById('wireBtn');
  let wireOn = false;
  wireBtn.addEventListener('click', () => {
    wireOn = !wireOn;
    Object.values(loadedModels).forEach(m => m.group.traverse(c => {
      if (c.isMesh) {
        (Array.isArray(c.material) ? c.material : [c.material]).forEach(mt => { mt.wireframe = wireOn; });
      }
    }));
    wireBtn.classList.toggle('active', wireOn); forceRender();
  });

  // ── Drag & drop ───────────────────────────────────────────
  const viewerWrap = document.querySelector('.viewer-wrap');
  viewerWrap.addEventListener('dragover', e => e.preventDefault());
  viewerWrap.addEventListener('drop', e => {
    e.preventDefault();
    const file = Array.from(e.dataTransfer.files).find(f => /\.(gltf|glb)$/i.test(f.name));
    if (file) window.loadGLTF(URL.createObjectURL(file), 'drop-' + Date.now(), file.name);
  });

}());