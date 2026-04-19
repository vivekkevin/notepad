/* ── ui.js – Outliner interactions ──────────────────────── */
(function () {
  'use strict';

  // ══ Generic caret expand/collapse ════════════════════════
  // All .caret-btn elements with data-target collapse their target div
  document.querySelectorAll('.caret-btn').forEach(btn => {
    const targetId = btn.dataset.target;
    const target   = targetId ? document.getElementById(targetId) : null;
    // start collapsed
    if (target) target.classList.add('collapsed');

    btn.addEventListener('click', () => {
      btn.classList.toggle('open');
      if (target) target.classList.toggle('collapsed');
    });
  });

  // ══ Collection eye toggle ═════════════════════════════════
  document.querySelectorAll('.vis-btn').forEach(btn => {
    const ci = btn.dataset.ci;
    window.setColVis(ci, true);

    btn.addEventListener('click', () => {
      const on = btn.classList.toggle('active');
      btn.classList.toggle('hidden-state', !on);
      window.setColVis(ci, on);

      // cascade to all models in this collection
      document.querySelectorAll('.obj-vis-btn[data-ci="' + ci + '"]').forEach(ob => {
        const key = ci + '-' + ob.dataset.oi;
        window.syncModelVis(key, ci);
      });
    });
  });

  // ══ Model (file) eye toggle ═══════════════════════════════
  document.querySelectorAll('.obj-vis-btn').forEach(btn => {
    const ci   = btn.dataset.ci;
    const oi   = btn.dataset.oi;
    const key  = ci + '-' + oi;
    const file = btn.dataset.file;

    window.setModelVis(key, true);

    btn.addEventListener('click', () => {
      const on = btn.classList.toggle('active');
      btn.classList.toggle('hidden-state', !on);
      window.setModelVis(key, on);

      const models = window.getLoadedModels();
      if (on && !models[key] && file) {
        const name = btn.closest('.tree-row').querySelector('.model-label').textContent.trim();
        window.loadGLTF(file, key, name);
      } else {
        window.syncModelVis(key, ci);
      }
    });
  });

  // ══ Model focus/load button ════════════════════════════════
  document.querySelectorAll('.obj-focus-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const ci   = btn.dataset.ci;
      const oi   = btn.dataset.oi;
      const key  = ci + '-' + oi;
      const file = btn.dataset.file;
      const name = btn.dataset.name;
      const models = window.getLoadedModels();

      // Highlight this model row
      document.querySelectorAll('.model-row.selected').forEach(r => r.classList.remove('selected'));
      btn.closest('.model-row').classList.add('selected');

      if (models[key]) {
        window.fitCamera(models[key].group);
      } else {
        window.loadGLTF(file, key, name, g => window.fitCamera(g));
        const eyeBtn = document.querySelector('.obj-vis-btn[data-ci="' + ci + '"][data-oi="' + oi + '"]');
        if (eyeBtn) { eyeBtn.classList.add('active'); eyeBtn.classList.remove('hidden-state'); }
        window.setModelVis(key, true);
      }
    });
  });

  // Auto-open first collection and load first model
  const firstCaret = document.querySelector('.caret-btn[data-target^="col-"]');
  if (firstCaret) {
    firstCaret.classList.add('open');
    const target = document.getElementById(firstCaret.dataset.target);
    if (target) target.classList.remove('collapsed');
  }

  // Auto-load first model
  const firstFocus = document.querySelector('.obj-focus-btn');
  if (firstFocus) {
    setTimeout(() => firstFocus.click(), 100);
  }

  // ══ Node eye toggle (individual GLTF object by name) ════
  document.querySelectorAll('.node-vis-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const ci        = btn.dataset.ci;
      const oi        = btn.dataset.oi;
      const nodeIndex = parseInt(btn.dataset.node);
      const row       = btn.closest('.node-row');
      const nodeName  = row ? row.dataset.nodeName : '';

      const on = btn.classList.toggle('active');
      btn.classList.toggle('hidden-state', !on);
      row && row.classList.toggle('node-hidden', !on);

      window.setNodeVis(ci, oi, nodeIndex, nodeName, on);
    });
  });

  // ══ UPLOAD MODAL ══════════════════════════════════════════
  const uploadModal    = document.getElementById('uploadModal');
  const openUploadBtn  = document.getElementById('openUploadBtn');
  const closeUploadBtn = document.getElementById('closeUploadModal');
  const cancelUpload   = document.getElementById('cancelUpload');
  const confirmUpload  = document.getElementById('confirmUpload');
  const fileInput      = document.getElementById('fileInput');
  const fileDropArea   = document.getElementById('fileDropArea');
  const fileDropLabel  = document.getElementById('fileDropLabel');
  const uploadCollName = document.getElementById('uploadCollName');
  const uploadProgress = document.getElementById('uploadProgress');
  const progressFill   = document.getElementById('progressFill');
  const progressLabel  = document.getElementById('progressLabel');
  const uploadMsg      = document.getElementById('uploadMsg');

  let selectedFile = null;

  function openUpload()  { selectedFile = null; fileDropLabel.textContent = 'Click or drag file here'; uploadMsg.textContent = ''; uploadMsg.className = 'upload-msg'; uploadProgress.classList.add('hidden'); progressFill.style.width = '0%'; uploadModal.classList.remove('hidden'); }
  function closeUpload() { uploadModal.classList.add('hidden'); }

  openUploadBtn.addEventListener('click', openUpload);
  closeUploadBtn.addEventListener('click', closeUpload);
  cancelUpload.addEventListener('click', closeUpload);
  uploadModal.addEventListener('click', e => { if (e.target === uploadModal) closeUpload(); });

  fileDropArea.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) { selectedFile = fileInput.files[0]; fileDropLabel.textContent = selectedFile.name; } });
  fileDropArea.addEventListener('dragover', e => { e.preventDefault(); fileDropArea.classList.add('drag'); });
  fileDropArea.addEventListener('dragleave', () => fileDropArea.classList.remove('drag'));
  fileDropArea.addEventListener('drop', e => {
    e.preventDefault(); fileDropArea.classList.remove('drag');
    const f = e.dataTransfer.files[0];
    if (f && /\.(zip|gltf|glb)$/i.test(f.name)) { selectedFile = f; fileDropLabel.textContent = f.name; }
    else { uploadMsg.textContent = 'Only .zip, .gltf, .glb allowed'; uploadMsg.className = 'upload-msg error'; }
  });

  confirmUpload.addEventListener('click', async () => {
    if (!selectedFile) { uploadMsg.textContent = 'Please select a file.'; uploadMsg.className = 'upload-msg error'; return; }
    const collName = uploadCollName.value.trim() || 'Uploaded';
    const formData = new FormData();
    formData.append('modelFile', selectedFile);
    formData.append('collectionName', collName);
    uploadProgress.classList.remove('hidden');
    uploadMsg.textContent = '';
    confirmUpload.disabled = true;

    try {
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/upload');
        xhr.upload.onprogress = e => {
          if (e.lengthComputable) { const p = Math.round(e.loaded / e.total * 100); progressFill.style.width = p + '%'; progressLabel.textContent = 'Uploading… ' + p + '%'; }
        };
        xhr.onload = () => { const res = JSON.parse(xhr.responseText); xhr.status === 200 && res.success ? resolve(res) : reject(new Error(res.error || 'Upload failed')); };
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.send(formData);
      });
      progressFill.style.width = '100%'; progressLabel.textContent = 'Done!';
      uploadMsg.textContent = '✓ Uploaded to "' + collName + '". Refreshing…'; uploadMsg.className = 'upload-msg ok';
      setTimeout(() => location.reload(), 1200);
    } catch (err) {
      uploadMsg.textContent = '✕ ' + err.message; uploadMsg.className = 'upload-msg error';
      confirmUpload.disabled = false;
    }
  });

  // ══ PASSWORD MODAL ════════════════════════════════════════
  const passwordModal  = document.getElementById('passwordModal');
  const closePwdBtn    = document.getElementById('closePasswordModal');
  const cancelPwd      = document.getElementById('cancelPwd');
  const confirmPwd     = document.getElementById('confirmPwd');
  const pwdInput       = document.getElementById('pwdInput');
  const pwdConfirm     = document.getElementById('pwdConfirm');
  const pwdCollLabel   = document.getElementById('pwdCollLabel');
  const pwdMsg         = document.getElementById('pwdMsg');
  let currentLockKey   = null;

  function openPwdModal(key, name) { currentLockKey = key; pwdCollLabel.textContent = name; pwdInput.value = ''; pwdConfirm.value = ''; pwdMsg.textContent = ''; pwdMsg.className = 'upload-msg'; passwordModal.classList.remove('hidden'); setTimeout(() => pwdInput.focus(), 100); }
  function closePwdModal() { passwordModal.classList.add('hidden'); currentLockKey = null; }

  closePwdBtn.addEventListener('click', closePwdModal);
  cancelPwd.addEventListener('click', closePwdModal);
  passwordModal.addEventListener('click', e => { if (e.target === passwordModal) closePwdModal(); });
  document.querySelectorAll('.lock-btn').forEach(btn => btn.addEventListener('click', () => openPwdModal(btn.dataset.key, btn.dataset.key)));

  confirmPwd.addEventListener('click', async () => {
    const p1 = pwdInput.value, p2 = pwdConfirm.value;
    if (!p1) { pwdMsg.textContent = 'Password cannot be empty.'; pwdMsg.className = 'upload-msg error'; return; }
    if (p1 !== p2) { pwdMsg.textContent = 'Passwords do not match.'; pwdMsg.className = 'upload-msg error'; return; }
    try {
      const res = await fetch('/set-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ collectionKey: currentLockKey, password: p1 }) });
      const data = await res.json();
      if (data.success) {
        document.querySelectorAll('.lock-btn[data-key="' + currentLockKey + '"]').forEach(b => b.classList.add('locked'));
        pwdMsg.textContent = '✓ Password set!'; pwdMsg.className = 'upload-msg ok';
        setTimeout(closePwdModal, 900);
      }
    } catch (err) { pwdMsg.textContent = 'Error: ' + err.message; pwdMsg.className = 'upload-msg error'; }
  });

  // ══ DOWNLOAD MODAL ════════════════════════════════════════
  const downloadModal   = document.getElementById('downloadModal');
  const closeDlBtn      = document.getElementById('closeDownloadModal');
  const cancelDownload  = document.getElementById('cancelDownload');
  const confirmDownload = document.getElementById('confirmDownload');
  const dlCollLabel     = document.getElementById('dlCollLabel');
  const dlPwdInput      = document.getElementById('dlPwdInput');
  const dlPasswordSection  = document.getElementById('dlPasswordSection');
  const dlNoPasswordSection = document.getElementById('dlNoPasswordSection');
  const dlMsg           = document.getElementById('dlMsg');
  let currentDlKey      = null;

  async function openDlModal(key, name) {
    currentDlKey = key; dlCollLabel.textContent = name;
    dlPwdInput.value = ''; dlMsg.textContent = ''; dlMsg.className = 'upload-msg';
    confirmDownload.disabled = true;
    downloadModal.classList.remove('hidden');
    try {
      const res  = await fetch('/verify-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ collectionKey: key, password: '' }) });
      const data = await res.json();
      if (data.noPassword) { dlPasswordSection.classList.add('hidden'); dlNoPasswordSection.classList.remove('hidden'); confirmDownload.disabled = false; }
      else { dlPasswordSection.classList.remove('hidden'); dlNoPasswordSection.classList.add('hidden'); setTimeout(() => dlPwdInput.focus(), 100); }
    } catch { dlPasswordSection.classList.remove('hidden'); dlNoPasswordSection.classList.add('hidden'); }
  }
  function closeDlModal() { downloadModal.classList.add('hidden'); currentDlKey = null; }

  closeDlBtn.addEventListener('click', closeDlModal);
  cancelDownload.addEventListener('click', closeDlModal);
  downloadModal.addEventListener('click', e => { if (e.target === downloadModal) closeDlModal(); });
  document.querySelectorAll('.dl-btn').forEach(btn => btn.addEventListener('click', () => openDlModal(btn.dataset.key, btn.dataset.name)));

  dlPwdInput.addEventListener('input', async () => {
    const pwd = dlPwdInput.value;
    if (!pwd) { confirmDownload.disabled = true; dlMsg.textContent = ''; return; }
    try {
      const res  = await fetch('/verify-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ collectionKey: currentDlKey, password: pwd }) });
      const data = await res.json();
      confirmDownload.disabled = !data.valid;
      dlMsg.textContent = data.valid ? '✓ Correct' : pwd.length > 2 ? '✕ Wrong password' : '';
      dlMsg.className   = data.valid ? 'upload-msg ok' : 'upload-msg error';
    } catch { confirmDownload.disabled = true; }
  });
  dlPwdInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !confirmDownload.disabled) confirmDownload.click(); });

  confirmDownload.addEventListener('click', async () => {
    const pwd = dlPwdInput.value;
    dlMsg.textContent = 'Preparing…'; dlMsg.className = 'upload-msg'; confirmDownload.disabled = true;
    try {
      const res = await fetch('/download-collection', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ collectionKey: currentDlKey, password: pwd }) });
      if (!res.ok) { const err = await res.json(); dlMsg.textContent = '✕ ' + err.error; dlMsg.className = 'upload-msg error'; confirmDownload.disabled = false; return; }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = currentDlKey + '.zip'; a.click(); URL.revokeObjectURL(url);
      dlMsg.textContent = '✓ Download started!'; dlMsg.className = 'upload-msg ok';
      setTimeout(closeDlModal, 1000);
    } catch (err) { dlMsg.textContent = '✕ ' + err.message; dlMsg.className = 'upload-msg error'; confirmDownload.disabled = false; }
  });

}());