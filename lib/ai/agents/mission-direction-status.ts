/** Shared by the workbench and the lead dossier. A queued direction is not consumption. */
export const DIRECTION_WAITING_LABEL = "新方向已接受，等待模型消费";
export const DIRECTION_CONSUMED_LABEL = "新方向已由模型读取（不等于业务完成）";

export function directionRevisionNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/** Null when there is no accepted direction yet. Consumption never means the business is done. */
export function directionConsumptionLine(input: {
  currentDirection: string | null | undefined;
  directionRevision: unknown;
  directionConsumedRevision: unknown;
}): string | null {
  if (!input.currentDirection?.trim()) return null;
  const revision = directionRevisionNumber(input.directionRevision);
  if (revision === null) return null;
  const consumed = directionRevisionNumber(input.directionConsumedRevision);
  return consumed !== null && consumed >= revision
    ? DIRECTION_CONSUMED_LABEL
    : DIRECTION_WAITING_LABEL;
}
