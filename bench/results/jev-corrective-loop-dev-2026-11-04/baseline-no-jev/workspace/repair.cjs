const fs = require('node:fs');
fs.copyFileSync('policy.fixed.ts', 'policy.ts');
process.stdout.write('bounded revoked-membership repair applied\n');