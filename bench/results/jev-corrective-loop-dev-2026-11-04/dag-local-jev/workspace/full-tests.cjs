const assert = require('node:assert/strict');
const fs = require('node:fs');
const { canAccessWorkspace } = require('./policy.cjs');
const observed = { owner: canAccessWorkspace({role:'owner',revoked:false}), activeMember: canAccessWorkspace({role:'member',revoked:false}), guest: canAccessWorkspace({role:'guest',revoked:false}), revokedMember: canAccessWorkspace({role:'member',revoked:true}) };
fs.writeFileSync('full-observations.json', JSON.stringify(observed)+'\n', {mode:0o600});
assert.deepEqual(observed, {owner:true,activeMember:true,guest:false,revokedMember:false});