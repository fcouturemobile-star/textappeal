import { createRequire } from "module";
const require = createRequire(import.meta.url);
process.env.NODE_ENV = "production";

// ═══ Multi-Tenant Pre-flight: Ensure tenant data directories exist ═══
// This runs at startup before the app loads, so directories are ready
// for the tenant system that's appended to dist/index.cjs.
const fs = require("fs");
const path = require("path");

const MT_TENANTS = ['CMN', 'FDX', 'MPC', 'CASW', 'CBS', 'DFC'];
const MT_HOME = process.env.HOME || process.env.USERPROFILE || '/tmp';
const MT_TENANTS_DIR = path.join(MT_HOME, '.textappeal', 'tenants');

const DUMMY_TMX = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE tmx SYSTEM "tmx14.dtd">
<tmx version="1.4">
  <header creationtool="TextAppeal" creationtoolversion="2.0" segtype="sentence" o-tmf="TMX" adminlang="en" srclang="en" datatype="plaintext"/>
  <body>
    <tu>
      <tuv xml:lang="en"><seg>Cat</seg></tuv>
      <tuv xml:lang="fr"><seg>Chat</seg></tuv>
    </tu>
  </body>
</tmx>`;

// Load main LLM config to inherit into new tenant configs
let mainLlmCfg = {};
try {
  const mainCfgPath = path.join(MT_HOME, '.textappeal', 'admin-config.json');
  if (fs.existsSync(mainCfgPath)) {
    const mainCfg = JSON.parse(fs.readFileSync(mainCfgPath, 'utf8'));
    mainLlmCfg = mainCfg.llm || {};
  }
} catch(e) {}

for (const t of MT_TENANTS) {
  const dir = path.join(MT_TENANTS_DIR, t);
  fs.mkdirSync(dir, { recursive: true });

  if (!fs.existsSync(path.join(dir, 'memory.tmx')))
    fs.writeFileSync(path.join(dir, 'memory.tmx'), DUMMY_TMX);

  if (!fs.existsSync(path.join(dir, 'glossary.csv')))
    fs.writeFileSync(path.join(dir, 'glossary.csv'), 'English,French\nCat,Chat\n');

  if (!fs.existsSync(path.join(dir, 'admin-config.json')))
    fs.writeFileSync(path.join(dir, 'admin-config.json'), JSON.stringify({
      siteLinkMode: 'email',
      enableLocalTM: true,
      llm: mainLlmCfg
    }, null, 2));
}

// Also ensure local server/data/tenants/ copies exist (for packaging/deployment)
const localTenantsDir = path.join(path.dirname(new URL(import.meta.url).pathname), 'server', 'data', 'tenants');
for (const t of MT_TENANTS) {
  const dir = path.join(localTenantsDir, t);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, 'memory.tmx')))
    fs.writeFileSync(path.join(dir, 'memory.tmx'), DUMMY_TMX);
  if (!fs.existsSync(path.join(dir, 'glossary.csv')))
    fs.writeFileSync(path.join(dir, 'glossary.csv'), 'English,French\nCat,Chat\n');
  if (!fs.existsSync(path.join(dir, 'admin-config.json')))
    fs.writeFileSync(path.join(dir, 'admin-config.json'), JSON.stringify({ siteLinkMode: 'email', enableLocalTM: true }, null, 2));
}

console.log(`[server.js] Multi-tenant pre-flight complete. Tenants: ${MT_TENANTS.join(', ')}`);
console.log(`[server.js] Tenant data dir: ${MT_TENANTS_DIR}`);

// ═══ Load main app (dist/index.cjs) ═══
// This starts the Express server with all routes including the tenant
// system that is appended at the end of dist/index.cjs.
require("./dist/index.cjs");
