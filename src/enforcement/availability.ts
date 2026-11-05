export type Availability = "available" | "unavailable";

export function isAvailabilityFailure(error: unknown): boolean {
  if (error === null || error === undefined) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|network|econn|unavailable|401|429|5\d\d/i.test(message);
}
