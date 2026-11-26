// quick loyalty points thing, added during the S14 crunch
export function pointsFor(totalCents: number) {
  return Math.floor(totalCents / 100) * 2;
}
