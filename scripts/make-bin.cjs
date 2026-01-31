const fs = require("fs");
const path = require("path");

const distDir = path.resolve(__dirname, "../dist");
fs.mkdirSync(distDir, { recursive: true });

const out = path.join(distDir, "bin.cjs");

const content = `#!/usr/bin/env node
require("./cli.cjs");
`;

fs.writeFileSync(out, content, "utf8");
try { fs.chmodSync(out, 0o755); } catch {}
