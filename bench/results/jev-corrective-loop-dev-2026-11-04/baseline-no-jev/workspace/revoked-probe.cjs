const assert = require('node:assert/strict');
const fs = require('node:fs');
const { canAccessWorkspace } = require('./policy.cjs');
const observed = { revokedMember: canAccessWorkspace({role:'member',revoked:true}) };
fs.writeFileSync('revoked-observation.json', JSON.stringify(observed)+'\n', {mode:0o600});
assert.equal(observed.revokedMember, false, 'revoked membership must be denied');