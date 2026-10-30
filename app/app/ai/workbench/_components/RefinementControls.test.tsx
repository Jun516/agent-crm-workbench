import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RefinementControls } from "./RefinementControls";

describe("refinement task controls", () => {
  it("offers explicit opt-in with visible budget and policy limits", () => {
    const onChange = vi.fn();
    render(<RefinementControls enabled={false} onChange={onChange} mode="inspect" />);
    const checkbox = screen.getByRole("checkbox", { name: "多候选自精炼（只读）" });
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    expect(onChange).toHaveBeenCalledWith(true);
    expect(screen.getByText(/不自动发布业务规则/)).toBeInTheDocument();
  });
  it("disables a previously selected refinement in action mode", () => {
    render(<RefinementControls enabled={true} onChange={vi.fn()} mode="act" />);
    expect(screen.getByRole("checkbox")).toBeDisabled();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });
});
