require('dotenv').config();

const mongoose = require('mongoose');
const Note     = require('./db/Note');

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const multer   = require('multer');
const AdmZip   = require('adm-zip');
const crypto   = require('crypto');
const session  = require('express-session');

const app  = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret:            process.env.SESSION_SECRET || 'change_me_in_env',
  resave:            false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 8 * 60 * 60 * 1000 }
}));

// ── Public static (CSS/JS/fonts) — served before auth ─────
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth guard ────────────────────────────────────────────
function requireLogin(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  if (req.xhr || req.path.startsWith('/api/') || req.headers['content-type'] === 'application/json') {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  return res.redirect('/login');
}

// /models protected — needs valid session
app.use('/models', requireLogin, express.static(path.join(__dirname, 'models')));

// ══════════════════════════════════════════════════════════
// ── COLLECTION PASSWORD STORE
// Persisted to disk so passwords survive server restarts
// ══════════════════════════════════════════════════════════

const PASSWORDS_FILE = path.join(__dirname, 'collection-passwords.json');

function loadPasswords() {
  try {
    if (fs.existsSync(PASSWORDS_FILE)) {
      return JSON.parse(fs.readFileSync(PASSWORDS_FILE, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return {};
}

function savePasswords(store) {
  fs.writeFileSync(PASSWORDS_FILE, JSON.stringify(store, null, 2));
}

// In-memory store, synced to disk
let collectionPasswords = loadPasswords();

function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw).digest('hex');
}

function verifyCollectionPassword(collectionKey, password) {
  const stored = collectionPasswords[collectionKey];
  if (!stored) return { valid: false, noPassword: true };
  return { valid: hashPassword(password || '') === stored, noPassword: false };
}

// ── Multer ────────────────────────────────────────────────
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename:    (_req, file,  cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => cb(null, /\.(zip|gltf|glb)$/i.test(file.originalname))
});

// ── Parse GLTF nodes ──────────────────────────────────────
function parseGLTFNodes(gltfFilePath) {
  try {
    const raw      = fs.readFileSync(gltfFilePath, 'utf8');
    const gltf     = JSON.parse(raw);
    const allNodes = (gltf.nodes || []).map((node, idx) => ({
      index:   idx,
      name:    node.name || ('Node_' + idx),
      hasMesh: node.mesh !== undefined
    }));
    const withMesh = allNodes.filter(n => n.hasMesh);
    return withMesh.length > 0 ? withMesh : allNodes;
  } catch (e) { return []; }
}

// ── Scan /models ──────────────────────────────────────────
function scanModels() {
  const modelsDir = path.join(__dirname, 'models');
  if (!fs.existsSync(modelsDir)) { fs.mkdirSync(modelsDir, { recursive: true }); return []; }

  return fs.readdirSync(modelsDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(collDir => {
      const collPath = path.join(modelsDir, collDir.name);
      const objects  = [];

      fs.readdirSync(collPath, { withFileTypes: true }).forEach(entry => {
        if (entry.isDirectory()) {
          const mp = path.join(collPath, entry.name);
          const gf = fs.readdirSync(mp).find(f => /\.(gltf|glb)$/i.test(f));
          if (gf) {
            const fmt   = /\.glb$/i.test(gf) ? 'GLB' : 'GLTF';
            const nodes = fmt === 'GLTF' ? parseGLTFNodes(path.join(mp, gf)) : [];
            objects.push({
              name:   entry.name,
              file:   '/models/' + collDir.name + '/' + entry.name + '/' + gf,
              format: fmt,
              nodes
            });
          }
        } else if (/\.(gltf|glb)$/i.test(entry.name)) {
          const fmt   = /\.glb$/i.test(entry.name) ? 'GLB' : 'GLTF';
          const nodes = fmt === 'GLTF' ? parseGLTFNodes(path.join(collPath, entry.name)) : [];
          objects.push({
            name:   entry.name.replace(/\.(gltf|glb)$/i, ''),
            file:   '/models/' + collDir.name + '/' + entry.name,
            format: fmt,
            nodes
          });
        }
      });

      // Include whether this collection has a password set
      return {
        key:         collDir.name,
        name:        collDir.name,
        objects,
        hasPassword: !!collectionPasswords[collDir.name]
      };
    });
}

// ── Recursive folder delete helper ───────────────────────
function deleteFolderRecursive(folderPath) {
  if (!fs.existsSync(folderPath)) return;
  fs.readdirSync(folderPath).forEach(file => {
    const cur = path.join(folderPath, file);
    fs.lstatSync(cur).isDirectory() ? deleteFolderRecursive(cur) : fs.unlinkSync(cur);
  });
  fs.rmdirSync(folderPath);
}

// ══════════════════════════════════════════════════════════
// ── LOGIN ROUTES
// ══════════════════════════════════════════════════════════

app.get('/login', (req, res) => {
  if (req.session && req.session.loggedIn) return res.redirect('/');
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === (process.env.APP_USERNAME || 'admin') &&
      password === (process.env.APP_PASSWORD || 'password')) {
    req.session.loggedIn = true;
    req.session.username = username;
    return res.redirect('/');
  }
  res.render('login', { error: 'Invalid username or password.' });
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ══════════════════════════════════════════════════════════
// ── PROTECTED ROUTES
// ══════════════════════════════════════════════════════════

app.get('/', requireLogin, (_req, res) => {
  res.render('index', { collections: scanModels() });
});

// ── UPLOAD — must include a collection password ───────────
// Password is set once at upload time and cannot be changed
// without knowing the current password.
app.post('/upload', requireLogin, upload.single('modelFile'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });

  const collectionName = (req.body.collectionName || 'Uploaded').replace(/[^a-zA-Z0-9_\- ]/g, '');
  const uploadPassword = (req.body.uploadPassword || '').trim();

  if (!uploadPassword) {
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'A collection password is required for upload.' });
  }

  const destColl = path.join(__dirname, 'models', collectionName);
  const collectionExists = fs.existsSync(destColl);

  // If collection already exists and has a password, verify it
  if (collectionExists && collectionPasswords[collectionName]) {
    const check = verifyCollectionPassword(collectionName, uploadPassword);
    if (!check.valid) {
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(403).json({ error: 'Wrong password for existing collection "' + collectionName + '".' });
    }
  }

  // New collection — set the password
  if (!collectionExists || !collectionPasswords[collectionName]) {
    collectionPasswords[collectionName] = hashPassword(uploadPassword);
    savePasswords(collectionPasswords);
  }

  if (!fs.existsSync(destColl)) fs.mkdirSync(destColl, { recursive: true });

  try {
    if (/\.zip$/i.test(req.file.originalname)) {
      const zip  = new AdmZip(req.file.path);
      const dest = path.join(destColl, path.basename(req.file.originalname, '.zip'));
      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
      zip.extractAllTo(dest, true);
    } else {
      const dest = path.join(destColl, path.basename(req.file.originalname, path.extname(req.file.originalname)));
      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
      fs.renameSync(req.file.path, path.join(dest, req.file.originalname));
    }
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.json({ success: true, message: 'Uploaded to "' + collectionName + '" — protected by your password.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── VERIFY collection password (for download/delete UI) ───
app.post('/verify-collection-password', requireLogin, (req, res) => {
  const { collectionKey, password } = req.body;
  if (!collectionKey) return res.status(400).json({ error: 'Missing collectionKey' });
  const result = verifyCollectionPassword(collectionKey, password);
  res.json(result);
});

// ── DOWNLOAD — requires collection password ───────────────
app.post('/download-collection', requireLogin, (req, res) => {
  const { collectionKey, password } = req.body;

  const check = verifyCollectionPassword(collectionKey, password);
  if (check.noPassword) {
    return res.status(403).json({ error: 'This collection has no password set. Cannot download.' });
  }
  if (!check.valid) {
    return res.status(403).json({ error: 'Wrong password.' });
  }

  const collPath = path.join(__dirname, 'models', collectionKey);
  if (!fs.existsSync(collPath)) return res.status(404).json({ error: 'Collection not found.' });

  try {
    const zip = new AdmZip();
    zip.addLocalFolder(collPath, collectionKey);
    const buf = zip.toBuffer();
    res.set({
      'Content-Type':        'application/zip',
      'Content-Disposition': 'attachment; filename="' + collectionKey + '.zip"',
      'Content-Length':      buf.length
    });
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE collection — requires collection password ──────
app.delete('/delete-collection', requireLogin, (req, res) => {
  const { collectionKey, password } = req.body;

  if (!collectionKey) return res.status(400).json({ error: 'Missing collectionKey' });

  const check = verifyCollectionPassword(collectionKey, password);
  if (check.noPassword) {
    return res.status(403).json({ error: 'No password set for this collection.' });
  }
  if (!check.valid) {
    return res.status(403).json({ error: 'Wrong password.' });
  }

  const collPath = path.join(__dirname, 'models', collectionKey);
  if (!fs.existsSync(collPath)) return res.status(404).json({ error: 'Collection not found.' });

  try {
    deleteFolderRecursive(collPath);
    // Remove password entry
    delete collectionPasswords[collectionKey];
    savePasswords(collectionPasswords);
    res.json({ success: true, message: 'Collection "' + collectionKey + '" deleted.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE single model object inside a collection ────────
app.delete('/delete-model', requireLogin, (req, res) => {
  const { collectionKey, modelName, password } = req.body;

  if (!collectionKey || !modelName) return res.status(400).json({ error: 'Missing fields' });

  const check = verifyCollectionPassword(collectionKey, password);
  if (check.noPassword) {
    return res.status(403).json({ error: 'No password set for this collection.' });
  }
  if (!check.valid) {
    return res.status(403).json({ error: 'Wrong password.' });
  }

  const modelPath = path.join(__dirname, 'models', collectionKey, modelName);
  if (!fs.existsSync(modelPath)) return res.status(404).json({ error: 'Model not found.' });

  try {
    const stat = fs.lstatSync(modelPath);
    if (stat.isDirectory()) {
      deleteFolderRecursive(modelPath);
    } else {
      fs.unlinkSync(modelPath);
    }
    res.json({ success: true, message: 'Model "' + modelName + '" deleted.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/collections', requireLogin, (_req, res) => res.json(scanModels()));

// ── MongoDB connection ────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/gltf_viewer';
mongoose.connect(MONGO_URI, {
  serverSelectionTimeoutMS: 5000,   // fail fast if Atlas unreachable
  socketTimeoutMS:          45000
})
  .then(() => console.log('✓ MongoDB Atlas connected'))
  .catch(err => console.warn('✗ MongoDB not connected (notepad disabled):', err.message));

// ══════════════════════════════════════════════════════════
// ── NOTEPAD ROUTES (public — protected by notepad password)
// ══════════════════════════════════════════════════════════

const NOTEPAD_PASSWORD = process.env.NOTEPAD_PASSWORD || 'Master@2025';

// GET /notepad — show password gate or notepad
app.get('/notepad', (req, res) => {
  res.render('notepad', { authenticated: false, error: null });
});

// POST /notepad/auth — verify notepad password
app.post('/notepad/auth', (req, res) => {
  const { password } = req.body;
  if (password === NOTEPAD_PASSWORD) {
    // Store notepad auth in session (separate from app login)
    req.session.notepadAuth = true;
    return res.redirect('/notepad/app');
  }
  res.render('notepad', { authenticated: false, error: 'Wrong password.' });
});

// Notepad session guard
function requireNotepadAuth(req, res, next) {
  if (req.session && req.session.notepadAuth) return next();
  
  // If it's an API call (JSON request or AJAX), return JSON error
  if (req.xhr || req.path.startsWith('/notepad/notes') || req.headers.accept?.includes('application/json')) {
    return res.status(401).json({ error: 'Session expired. Please login again.' });
  }
  
  // Otherwise redirect to notepad login page
  res.redirect('/notepad');
}

// GET /notepad/app — main notepad UI
app.get('/notepad/app', requireNotepadAuth, async (req, res) => {
  try {
    const notes = await Note.find().sort({ pinned: -1, updatedAt: -1 });
    res.render('notepad-app', { notes });
  } catch (err) {
    res.render('notepad-app', { notes: [], error: err.message });
  }
});

// POST /notepad/notes — create note
app.post('/notepad/notes', requireNotepadAuth, async (req, res) => {
  try {
    const { title, content, color, pinned } = req.body;
    const note = new Note({ title, content, color: color || '#1a1e28', pinned: !!pinned });
    await note.save();
    res.json({ success: true, note });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /notepad/notes/:id — update note
app.put('/notepad/notes/:id', requireNotepadAuth, async (req, res) => {
  try {
    const { title, content, color, pinned } = req.body;
    const note = await Note.findByIdAndUpdate(
      req.params.id,
      { title, content, color, pinned, updatedAt: new Date() },
      { new: true }
    );
    if (!note) return res.status(404).json({ error: 'Note not found' });
    res.json({ success: true, note });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /notepad/notes/:id — delete note
app.delete('/notepad/notes/:id', requireNotepadAuth, async (req, res) => {
  try {
    await Note.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /notepad/logout
app.post('/notepad/logout', (req, res) => {
  req.session.notepadAuth = false;
  res.redirect('/notepad');
});

app.listen(PORT, () => {
  console.log('GLTF Viewer → http://localhost:' + PORT);
  console.log('App login: ' + (process.env.APP_USERNAME || 'admin'));
});