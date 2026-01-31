const fs = require('fs');
const path = require('path');

const out = path.resolve(process.cwd(), 'dist/bin.cjs');

const content = `#!/usr/bin/env node
require('./cli.cjs');
`;

fs.writeFileSync(out, content, 'utf8');
