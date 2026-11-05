const assert = require('node:assert/strict');
const fs = require('node:fs');
const { canAccessWorkspace } = require('./policy.cjs');
try { fs.unlinkSync('existing-observations.json'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const observed = { owner: canAccessWorkspace({role:'owner',revoked:false}), activeMember: canAccessWorkspace({role:'member',revoked:false}), guest: canAccessWorkspace({role:'guest',revoked:false}) };
fs.writeFileSync('existing-observations.json', JSON.stringify(observed)+'\n', {mode:0o600});
assert.deepEqual(observed, {owner:true,activeMember:true,guest:false});
process.stdout.write(JSON.stringify(observed)+'\n');