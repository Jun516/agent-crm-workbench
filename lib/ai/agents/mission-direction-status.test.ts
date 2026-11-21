import { describe, expect, it } from "vitest";
import {
  DIRECTION_CONSUMED_LABEL,
  DIRECTION_WAITING_LABEL,
  directionConsumptionLine,
} from "./mission-direction-status";

describe("Mission direction consumption label", () => {
  it("keeps an accepted revision waiting until the model has read that same revision", () => {
    expect(directionConsumptionLine({
      currentDirection: "先核对报价",
      directionRevision: 2,
      directionConsumedRevision: 1,
    })).toBe(DIRECTION_WAITING_LABEL);
    expect(directionConsumptionLine({
      currentDirection: "先核对报价",
      directionRevision: "2",
      directionConsumedRevision: "2",
    })).toBe(DIRECTION_CONSUMED_LABEL);
  });

  it("does not invent a consumption line when no direction was accepted", () => {
    expect(directionConsumptionLine({
      currentDirection: "   ",
      directionRevision: 1,
      directionConsumedRevision: 0,
    })).toBeNull();
    expect(directionConsumptionLine({
      currentDirection: "先核对报价",
      directionRevision: "not-a-revision",
      directionConsumedRevision: 0,
    })).toBeNull();
  });
});
