"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.canAccessWorkspace = canAccessWorkspace;
function canAccessWorkspace(membership) {
    return membership.role === 'owner' || membership.role === 'member';
}
