export type Membership = { role: 'owner' | 'member' | 'guest'; revoked: boolean };
export function canAccessWorkspace(membership: Membership): boolean {
  if (membership.revoked) return false;
  return membership.role === 'owner' || membership.role === 'member';
}
