/* ── ui.js – Outliner, Upload, Download, Delete ─────────── */
(function () {
  'use strict';

  // ══ Helpers ═══════════════════════════════════════════════

  // Generic password show/hide toggle
  function makePwToggle(inputId, btnId) {
    const input = document.getElementById(inputId);
    const btn   = document.getElementById(btnId);
    if (!input || !btn) return;
    let shown = false;
    btn.addEventListener('click', () => {
      shown = !shown;
      input.type = shown ? 'text' : 'password';
      btn.innerHTML = shown
        ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="17.94" y1="17.94" x2="22" y2="22"/><line x1="2" y1="2" x2="5.17" y2="5.17"/><path d="M10.73 5.08A10.43 10.43 0 0112 5c7 0 11 7 11 7a13.16 13.16 0 01-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 001 12s4 7 11 7a9.74 9.74 0 005.39-1.61"/></svg>'
        : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
    });
  }
  makePwToggle('uploadPassword', 'uploadPwdToggle');
  makePwToggle('dlPwdInput',     'dlPwdToggle');
  makePwToggle('delPwdInput',    'delPwdToggle');

  // Verify password against server (live check)
  async function verifyPassword(collectionKey, password) {
    const res  = await fetch('/verify-collection-password', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ collectionKey, password })
    });
    return res.json();
  }

  // ══ OUTLINER: Caret expand/collapse ══════════════════════
  document.querySelectorAll('.caret-btn').forEach(btn => {
    const target = btn.dataset.target ? document.getElementById(btn.dataset.target) : null;
    if (target) target.classList.add('collapsed');
    btn.addEventListener('click', () => {
      btn.classList.toggle('open');
      if (target) target.classList.toggle('collapsed');
    });
  });

  // Open first collection by default
  const firstCaret = document.querySelector('.caret-btn[data-target^="col-"]');
  if (firstCaret) {
    firstCaret.classList.add('open');
    const t = document.getElementById(firstCaret.dataset.target);
    if (t) t.classList.remove('collapsed');
  }

  // ══ Collection eye toggle ═════════════════════════════════
  document.querySelectorAll('.vis-btn').forEach(btn => {
    const ci = btn.dataset.ci;
    window.setColVis(ci, true);
    btn.addEventListener('click', () => {
      const on = btn.classList.toggle('active');
      btn.classList.toggle('hidden-state', !on);
      window.setColVis(ci, on);
      document.querySelectorAll('.obj-vis-btn[data-ci="' + ci + '"]').forEach(ob => {
        window.syncModelVis(ci + '-' + ob.dataset.oi, ci);
      });
    });
  });

  // ══ Model eye toggle ══════════════════════════════════════
  document.querySelectorAll('.obj-vis-btn').forEach(btn => {
    const ci = btn.dataset.ci, oi = btn.dataset.oi, key = ci + '-' + oi;
    window.setModelVis(key, true);
    btn.addEventListener('click', () => {
      const on = btn.classList.toggle('active');
      btn.classList.toggle('hidden-state', !on);
      window.setModelVis(key, on);
      const models = window.getLoadedModels();
      if (on && !models[key] && btn.dataset.file) {
        const name = btn.closest('.tree-row').querySelector('.model-label').textContent.trim();
        window.loadGLTF(btn.dataset.file, key, name);
      } else {
        window.syncModelVis(key, ci);
      }
    });
  });

  // ══ Model focus button ════════════════════════════════════
  document.querySelectorAll('.obj-focus-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const ci = btn.dataset.ci, oi = btn.dataset.oi, key = ci + '-' + oi;
      const models = window.getLoadedModels();
      document.querySelectorAll('.model-row.selected').forEach(r => r.classList.remove('selected'));
      btn.closest('.model-row').classList.add('selected');
      if (models[key]) {
        window.fitCamera(models[key].group);
      } else {
        window.loadGLTF(btn.dataset.file, key, btn.dataset.name, g => window.fitCamera(g));
        const eye = document.querySelector('.obj-vis-btn[data-ci="' + ci + '"][data-oi="' + oi + '"]');
        if (eye) { eye.classList.add('active'); eye.classList.remove('hidden-state'); }
        window.setModelVis(key, true);
      }
    });
  });

  // ══ Node eye toggle ═══════════════════════════════════════
  document.querySelectorAll('.node-vis-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const ci = btn.dataset.ci, oi = btn.dataset.oi, ni = parseInt(btn.dataset.node);
      const row = btn.closest('.node-row');
      const nodeName = row ? row.dataset.nodeName : '';
      const on = btn.classList.toggle('active');
      btn.classList.toggle('hidden-state', !on);
      row && row.classList.toggle('node-hidden', !on);
      window.setNodeVis(ci, oi, ni, nodeName, on);
    });
  });

  // Auto-load first model
  setTimeout(() => {
    const firstFocus = document.querySelector('.obj-focus-btn');
    if (firstFocus) firstFocus.click();
  }, 100);

  // ══════════════════════════════════════════════════════════
  // ── UPLOAD MODAL
  // ══════════════════════════════════════════════════════════
  const uploadModal    = document.getElementById('uploadModal');
  const openUploadBtn  = document.getElementById('openUploadBtn');
  const closeUploadBtn = document.getElementById('closeUploadModal');
  const cancelUpload   = document.getElementById('cancelUpload');
  const confirmUpload  = document.getElementById('confirmUpload');
  const fileInput      = document.getElementById('fileInput');
  const fileDropArea   = document.getElementById('fileDropArea');
  const fileDropLabel  = document.getElementById('fileDropLabel');
  const uploadCollName = document.getElementById('uploadCollName');
  const uploadPassword = document.getElementById('uploadPassword');
  const uploadProgress = document.getElementById('uploadProgress');
  const progressFill   = document.getElementById('progressFill');
  const progressLabel  = document.getElementById('progressLabel');
  const uploadMsg      = document.getElementById('uploadMsg');

  let selectedFile = null;

  function resetUploadModal() {
    selectedFile = null;
    fileDropLabel.textContent = 'Click or drag file here';
    uploadMsg.textContent = '';
    uploadMsg.className = 'upload-msg';
    uploadProgress.classList.add('hidden');
    progressFill.style.width = '0%';
    if (uploadPassword) uploadPassword.value = '';
    confirmUpload.disabled = false;
  }

  function openUpload()  { resetUploadModal(); uploadModal.classList.remove('hidden'); }
  function closeUpload() { uploadModal.classList.add('hidden'); }

  openUploadBtn.addEventListener('click', openUpload);
  closeUploadBtn.addEventListener('click', closeUpload);
  cancelUpload.addEventListener('click', closeUpload);
  uploadModal.addEventListener('click', e => { if (e.target === uploadModal) closeUpload(); });

  fileDropArea.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) { selectedFile = fileInput.files[0]; fileDropLabel.textContent = selectedFile.name; }
  });
  fileDropArea.addEventListener('dragover', e => { e.preventDefault(); fileDropArea.classList.add('drag'); });
  fileDropArea.addEventListener('dragleave', () => fileDropArea.classList.remove('drag'));
  fileDropArea.addEventListener('drop', e => {
    e.preventDefault(); fileDropArea.classList.remove('drag');
    const f = e.dataTransfer.files[0];
    if (f && /\.(zip|gltf|glb)$/i.test(f.name)) { selectedFile = f; fileDropLabel.textContent = f.name; }
    else { uploadMsg.textContent = 'Only .zip, .gltf, .glb files accepted.'; uploadMsg.className = 'upload-msg error'; }
  });

  confirmUpload.addEventListener('click', async () => {
    if (!selectedFile) { uploadMsg.textContent = 'Please select a file.'; uploadMsg.className = 'upload-msg error'; return; }
    const pw = uploadPassword ? uploadPassword.value.trim() : '';
    if (!pw) { uploadMsg.textContent = '⚠ A collection password is required.'; uploadMsg.className = 'upload-msg error'; return; }

    const collName = uploadCollName.value.trim() || 'Uploaded';
    const formData = new FormData();
    formData.append('modelFile',       selectedFile);
    formData.append('collectionName',  collName);
    formData.append('uploadPassword',  pw);

    uploadProgress.classList.remove('hidden');
    uploadMsg.textContent = '';
    confirmUpload.disabled = true;

    try {
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/upload');
        xhr.upload.onprogress = e => {
          if (e.lengthComputable) {
            const p = Math.round(e.loaded / e.total * 100);
            progressFill.style.width = p + '%';
            progressLabel.textContent = 'Uploading… ' + p + '%';
          }
        };
        xhr.onload = () => {
          const data = JSON.parse(xhr.responseText);
          (xhr.status === 200 && data.success) ? resolve(data) : reject(new Error(data.error || 'Upload failed'));
        };
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.send(formData);
      });
      progressFill.style.width = '100%';
      progressLabel.textContent = 'Done!';
      uploadMsg.textContent = '✓ Uploaded. Refreshing…';
      uploadMsg.className = 'upload-msg ok';
      setTimeout(() => location.reload(), 1200);
    } catch (err) {
      uploadMsg.textContent = '✕ ' + err.message;
      uploadMsg.className = 'upload-msg error';
      confirmUpload.disabled = false;
    }
  });

  // ══════════════════════════════════════════════════════════
  // ── DOWNLOAD MODAL
  // ══════════════════════════════════════════════════════════
  const downloadModal   = document.getElementById('downloadModal');
  const closeDlBtn      = document.getElementById('closeDownloadModal');
  const cancelDownload  = document.getElementById('cancelDownload');
  const confirmDownload = document.getElementById('confirmDownload');
  const dlCollLabel     = document.getElementById('dlCollLabel');
  const dlPwdInput      = document.getElementById('dlPwdInput');
  const dlMsg           = document.getElementById('dlMsg');

  let currentDlKey = null;

  function openDownloadModal(key, name) {
    currentDlKey = key;
    dlCollLabel.textContent = name;
    dlPwdInput.value = '';
    dlMsg.textContent = '';
    dlMsg.className = 'upload-msg';
    confirmDownload.disabled = true;
    downloadModal.classList.remove('hidden');
    setTimeout(() => dlPwdInput.focus(), 120);
  }
  function closeDownloadModal() { downloadModal.classList.add('hidden'); currentDlKey = null; }

  closeDlBtn.addEventListener('click', closeDownloadModal);
  cancelDownload.addEventListener('click', closeDownloadModal);
  downloadModal.addEventListener('click', e => { if (e.target === downloadModal) closeDownloadModal(); });

  document.querySelectorAll('.dl-btn').forEach(btn => {
    btn.addEventListener('click', () => openDownloadModal(btn.dataset.key, btn.dataset.name));
  });

  // Live password verification while typing
  let dlVerifyTimer = null;
  dlPwdInput.addEventListener('input', () => {
    clearTimeout(dlVerifyTimer);
    confirmDownload.disabled = true;
    dlMsg.textContent = '';
    if (!dlPwdInput.value) return;
    dlVerifyTimer = setTimeout(async () => {
      try {
        const data = await verifyPassword(currentDlKey, dlPwdInput.value);
        if (data.valid) {
          confirmDownload.disabled = false;
          dlMsg.textContent = '✓ Password correct — ready to download';
          dlMsg.className = 'upload-msg ok';
        } else {
          confirmDownload.disabled = true;
          dlMsg.textContent = '✕ Wrong password';
          dlMsg.className = 'upload-msg error';
        }
      } catch { confirmDownload.disabled = true; }
    }, 350);
  });

  dlPwdInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !confirmDownload.disabled) confirmDownload.click(); });

  confirmDownload.addEventListener('click', async () => {
    dlMsg.textContent = 'Preparing download…'; dlMsg.className = 'upload-msg';
    confirmDownload.disabled = true;
    try {
      const res = await fetch('/download-collection', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ collectionKey: currentDlKey, password: dlPwdInput.value })
      });
      if (!res.ok) {
        const err = await res.json();
        dlMsg.textContent = '✕ ' + err.error; dlMsg.className = 'upload-msg error';
        confirmDownload.disabled = false;
        return;
      }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = currentDlKey + '.zip'; a.click();
      URL.revokeObjectURL(url);
      dlMsg.textContent = '✓ Download started!'; dlMsg.className = 'upload-msg ok';
      setTimeout(closeDownloadModal, 1200);
    } catch (err) {
      dlMsg.textContent = '✕ ' + err.message; dlMsg.className = 'upload-msg error';
      confirmDownload.disabled = false;
    }
  });

  // ══════════════════════════════════════════════════════════
  // ── DELETE MODAL
  // ══════════════════════════════════════════════════════════
  const deleteModal   = document.getElementById('deleteModal');
  const closeDelBtn   = document.getElementById('closeDeleteModal');
  const cancelDelete  = document.getElementById('cancelDelete');
  const confirmDelete = document.getElementById('confirmDelete');
  const deleteTypeLabel = document.getElementById('deleteTypeLabel');
  const deleteItemLabel = document.getElementById('deleteItemLabel');
  const delPwdInput   = document.getElementById('delPwdInput');
  const delMsg        = document.getElementById('delMsg');

  let currentDelKey   = null;
  let currentDelModel = null; // null = delete whole collection, string = model name

  function openDeleteModal(collectionKey, collectionName, modelName) {
    currentDelKey   = collectionKey;
    currentDelModel = modelName || null;
    deleteTypeLabel.textContent = modelName ? 'Model' : 'Collection';
    deleteItemLabel.textContent = modelName ? (collectionName + ' / ' + modelName) : collectionName;
    delPwdInput.value = '';
    delMsg.textContent = '';
    delMsg.className = 'upload-msg';
    confirmDelete.disabled = true;
    deleteModal.classList.remove('hidden');
    setTimeout(() => delPwdInput.focus(), 120);
  }
  function closeDeleteModal() { deleteModal.classList.add('hidden'); currentDelKey = null; currentDelModel = null; }

  closeDelBtn.addEventListener('click', closeDeleteModal);
  cancelDelete.addEventListener('click', closeDeleteModal);
  deleteModal.addEventListener('click', e => { if (e.target === deleteModal) closeDeleteModal(); });

  // Delete collection buttons
  document.querySelectorAll('.del-coll-btn').forEach(btn => {
    btn.addEventListener('click', () => openDeleteModal(btn.dataset.key, btn.dataset.name, null));
  });

  // Delete model buttons
  document.querySelectorAll('.del-model-btn').forEach(btn => {
    btn.addEventListener('click', () => openDeleteModal(btn.dataset.collectionKey, btn.dataset.collectionKey, btn.dataset.modelName));
  });

  // Live password verification for delete
  let delVerifyTimer = null;
  delPwdInput.addEventListener('input', () => {
    clearTimeout(delVerifyTimer);
    confirmDelete.disabled = true;
    delMsg.textContent = '';
    if (!delPwdInput.value) return;
    delVerifyTimer = setTimeout(async () => {
      try {
        const data = await verifyPassword(currentDelKey, delPwdInput.value);
        if (data.valid) {
          confirmDelete.disabled = false;
          delMsg.textContent = '✓ Password correct';
          delMsg.className = 'upload-msg ok';
        } else {
          confirmDelete.disabled = true;
          delMsg.textContent = '✕ Wrong password';
          delMsg.className = 'upload-msg error';
        }
      } catch { confirmDelete.disabled = true; }
    }, 350);
  });

  delPwdInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !confirmDelete.disabled) confirmDelete.click(); });

  confirmDelete.addEventListener('click', async () => {
    delMsg.textContent = 'Deleting…'; delMsg.className = 'upload-msg';
    confirmDelete.disabled = true;
    try {
      const isModel = !!currentDelModel;
      const res = await fetch(isModel ? '/delete-model' : '/delete-collection', {
        method:  'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          collectionKey: currentDelKey,
          modelName:     currentDelModel,
          password:      delPwdInput.value
        })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        delMsg.textContent = '✕ ' + (data.error || 'Delete failed');
        delMsg.className = 'upload-msg error';
        confirmDelete.disabled = false;
        return;
      }
      delMsg.textContent = '✓ Deleted. Refreshing…'; delMsg.className = 'upload-msg ok';
      setTimeout(() => location.reload(), 900);
    } catch (err) {
      delMsg.textContent = '✕ ' + err.message; delMsg.className = 'upload-msg error';
      confirmDelete.disabled = false;
    }
  });

}());