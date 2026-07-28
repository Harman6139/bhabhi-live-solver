import { describe, expect, it } from "vitest";

import { nextActiveSeat, orderedSeatsFrom } from "../../src/domain/seats";

describe("seat traversal", () => {
  it("orders every seat clockwise and anticlockwise", () => {
    expect(orderedSeatsFrom("user", "clockwise")).toEqual(["user", "p2", "p3"]);
    expect(orderedSeatsFrom("user", "anticlockwise")).toEqual([
      "user",
      "p3",
      "p2",
    ]);
    expect(orderedSeatsFrom("p2", "clockwise")).toEqual(["p2", "p3", "user"]);
  });

  it("skips escaped seats without changing physical adjacency", () => {
    expect(nextActiveSeat("user", "clockwise", ["user", "p3"])).toBe("p3");
    expect(nextActiveSeat("user", "anticlockwise", ["user", "p2"])).toBe("p2");
  });
});
