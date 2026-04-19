require('dotenv').config();

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

// ── Body parsers ───────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Session ────────────────────────────────────────────────
app.use(session({
  secret:            process.env.SESSION_SECRET || 'change_me_in_env',
  resave:            false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 8 * 60 * 60 * 1000 }
}));

// ── PUBLIC static files (CSS/JS/favicon) ─────────────────
// These must be served BEFORE requireLogin so the login page
// itself can load style.css, viewer.js etc.
// /models is NOT included here — it stays protected below.
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth guard ────────────────────────────────────────────
function requireLogin(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  if (req.path === '/login') return next();
  // API calls → 401 JSON instead of redirect
  if (req.path.startsWith('/api/') ||
      req.path.startsWith('/upload') ||
      req.path.startsWith('/download') ||
      req.path.startsWith('/set-password') ||
      req.path.startsWith('/verify-password')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  return res.redirect('/login');
}

// ── PROTECTED: /models static (AFTER auth) ────────────────
// Placed after requireLogin so model files need a valid session
app.use('/models', requireLogin, express.static(path.join(__dirname, 'models')));

// ── In-memory download password store ─────────────────────
const downloadPasswords = {};

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

// ── Parse GLTF JSON → node names ──────────────────────────
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

// ── Scan /models directory ────────────────────────────────
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

      return { key: collDir.name, name: collDir.name, objects };
    });
}

// ══════════════════════════════════════════════════════════
// ── LOGIN ROUTES (no auth required)
// ══════════════════════════════════════════════════════════

app.get('/login', (req, res) => {
  if (req.session && req.session.loggedIn) return res.redirect('/');
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const validUser = process.env.APP_USERNAME || 'admin';
  const validPass = process.env.APP_PASSWORD || 'password';

  if (username === validUser && password === validPass) {
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

app.post('/upload', requireLogin, upload.single('modelFile'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  const collectionName = (req.body.collectionName || 'Uploaded').replace(/[^a-zA-Z0-9_\- ]/g, '');
  const destColl = path.join(__dirname, 'models', collectionName);
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
    res.json({ success: true, message: 'Added to collection "' + collectionName + '"' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/set-password', requireLogin, (req, res) => {
  const { collectionKey, password } = req.body;
  if (!collectionKey || !password) return res.status(400).json({ error: 'Missing fields' });
  downloadPasswords[collectionKey] = crypto.createHash('sha256').update(password).digest('hex');
  res.json({ success: true });
});

app.post('/verify-password', requireLogin, (req, res) => {
  const { collectionKey, password } = req.body;
  const stored = downloadPasswords[collectionKey];
  if (!stored) return res.json({ valid: true, noPassword: true });
  const hash = crypto.createHash('sha256').update(password || '').digest('hex');
  res.json({ valid: hash === stored });
});

app.post('/download-collection', requireLogin, (req, res) => {
  const { collectionKey, password } = req.body;
  const stored = downloadPasswords[collectionKey];
  if (stored) {
    const hash = crypto.createHash('sha256').update(password || '').digest('hex');
    if (hash !== stored) return res.status(403).json({ error: 'Wrong password' });
  }
  const collPath = path.join(__dirname, 'models', collectionKey);
  if (!fs.existsSync(collPath)) return res.status(404).json({ error: 'Not found' });
  const zip = new AdmZip();
  zip.addLocalFolder(collPath, collectionKey);
  const buf = zip.toBuffer();
  res.set({
    'Content-Type':        'application/zip',
    'Content-Disposition': 'attachment; filename="' + collectionKey + '.zip"',
    'Content-Length':      buf.length
  });
  res.send(buf);
});

app.get('/api/collections', requireLogin, (_req, res) => res.json(scanModels()));

app.listen(PORT, () => {
  console.log('GLTF Viewer → http://localhost:' + PORT);
  console.log('Login credentials from .env → user: ' + (process.env.APP_USERNAME || 'admin'));
});