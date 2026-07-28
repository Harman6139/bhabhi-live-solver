export const SEATS = ["user", "p2", "p3"] as const;
export type Seat = (typeof SEATS)[number];
export type OpponentSeat = Exclude<Seat, "user">;
export type Direction = "clockwise" | "anticlockwise";

export function isSeat(value: unknown): value is Seat {
  return typeof value === "string" && SEATS.includes(value as Seat);
}

export function clockwiseAdjacent(seat: Seat): Seat {
  const index = SEATS.indexOf(seat);
  const adjacent = SEATS[(index + 1) % SEATS.length];
  if (adjacent === undefined) {
    throw new Error(`No clockwise seat follows ${seat}.`);
  }
  return adjacent;
}

export function anticlockwiseAdjacent(seat: Seat): Seat {
  const index = SEATS.indexOf(seat);
  const adjacent = SEATS[(index - 1 + SEATS.length) % SEATS.length];
  if (adjacent === undefined) {
    throw new Error(`No anticlockwise seat follows ${seat}.`);
  }
  return adjacent;
}

export function adjacentSeat(seat: Seat, direction: Direction): Seat {
  return direction === "clockwise"
    ? clockwiseAdjacent(seat)
    : anticlockwiseAdjacent(seat);
}

export function orderedSeatsFrom(
  start: Seat,
  direction: Direction,
  active: readonly Seat[] = SEATS,
): Seat[] {
  const activeSet = new Set(active);
  if (!activeSet.has(start)) {
    throw new Error(`Cannot order active seats from inactive seat ${start}.`);
  }

  const ordered: Seat[] = [];
  let cursor = start;
  for (let traversed = 0; traversed < SEATS.length; traversed += 1) {
    if (activeSet.has(cursor)) {
      ordered.push(cursor);
    }
    cursor = adjacentSeat(cursor, direction);
  }
  return ordered;
}

export function nextActiveSeat(
  seat: Seat,
  direction: Direction,
  active: readonly Seat[],
): Seat {
  if (active.length === 0) {
    throw new Error("There is no active player.");
  }

  let cursor = adjacentSeat(seat, direction);
  for (let traversed = 0; traversed < SEATS.length; traversed += 1) {
    if (active.includes(cursor)) {
      return cursor;
    }
    cursor = adjacentSeat(cursor, direction);
  }
  throw new Error(`No active seat follows ${seat}.`);
}
