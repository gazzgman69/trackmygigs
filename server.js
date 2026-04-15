require('dotenv').config();

const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');

const authRoutes = require('./routes/auth');
const apiRoutes = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 3000;

// Unique ID per server start — busts browser/proxy cache for JS and CSS
const BUILD_ID = Date.now();

// Read index.html once at startup and inject BUILD_ID into asset URLs
const INDEX_HTML_PATH = path.join(__dirname, 'public', 'index.html');
let indexHtml = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
// Replace any existing ?v=... or add ?v=BUILD_ID to .js and .css links
indexHtml = indexHtml
  .replace(/(href="\/css\/[^"]+\.css)(\?[^"]*)?"/g, `$1?v=${BUILD_ID}"`)
  .replace(/(src="\/js\/[^"]+\.js)(\?[^"]*)?"/g, `$1?v=${BUILD_ID}"`);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Serve static assets (JS, CSS, images) — never serve index.html from here
app.use(express.static(path.join(__dirname, 'public'), {
  index: false, // prevent express.static from serving index.html for /
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  },
}));

app.use('/auth', authRoutes);
app.use('/api', apiRoutes);

// Asset requests that don't exist as static files → 404 (never return HTML)
const ASSET_EXTENSIONS = /\.(js|css|png|jpg|jpeg|gif|svg|ico|json|woff|woff2|ttf|map)$/i;

app.get('*', (req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/auth') || ASSET_EXTENSIONS.test(req.path)) {
    res.status(404).send('Not found');
    return;
  }
  // Serve the pre-built index.html with injected BUILD_ID — never cached
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(indexHtml);
});

app.listen(PORT, () => {
  console.log(`TrackMyGigs server running on port ${PORT} (build ${BUILD_ID})`);
});
