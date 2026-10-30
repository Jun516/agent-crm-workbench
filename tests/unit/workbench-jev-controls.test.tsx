import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { JevEvaluationControls } from "@/app/app/ai/workbench/_components/JevEvaluationControls";

describe("explicit external Jev review control", () => {
  it("never requests on render and requires an affirmative material-sharing choice", () => {
    const run = vi.fn();
    render(<JevEvaluationControls runId="run" busy={false} terminal onRun={run} />);
    const button = screen.getByRole("button", { name: "运行 Jev 评测（外部服务）" });
    expect(run).not.toHaveBeenCalled();
    expect(button).toBeDisabled();
    expect(screen.getByText(/显式运行才会向 TypeSafe/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("is unavailable for an unconfigured service or an active run", () => {
    const { rerender } = render(
      <JevEvaluationControls
        runId="run"
        busy={false}
        terminal
        configured={false}
        onRun={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("button")).toBeDisabled();
    expect(screen.getByText(/当前未配置 Jev/)).toBeInTheDocument();
    rerender(
      <JevEvaluationControls
        runId="run"
        busy={false}
        terminal={false}
        configured
        onRun={vi.fn()}
      />,
    );
    expect(screen.getByRole("button")).toBeDisabled();
  });
  it("makes a failed review and lack of automatic retry visible", () => {
    const run = vi.fn();
    render(
      <JevEvaluationControls
        runId="run"
        busy={false}
        terminal
        onRun={run}
        review={{ status: "failed", requestedModel: "jev-latest" }}
      />,
    );
    expect(screen.getByText(/Jev 评测未能完成/)).toHaveTextContent("未自动重试");
    expect(run).not.toHaveBeenCalled();
  });
});
