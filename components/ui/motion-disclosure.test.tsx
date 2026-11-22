import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MotionDisclosure } from "./motion-disclosure";

describe("MotionDisclosure", () => {
  it("connects each native toggle to its own inaccessible, inert closed panel", () => {
    render(
      <>
        <MotionDisclosure title="Evidence">
          <a href="#source">Source</a>
        </MotionDisclosure>
        <MotionDisclosure title="Memory">
          <button type="button">Details action</button>
        </MotionDisclosure>
      </>,
    );
    const evidence = screen.getByRole("button", { name: "Evidence" });
    const memory = screen.getByRole("button", { name: "Memory" });
    const panelId = evidence.getAttribute("aria-controls")!;
    const panel = document.getElementById(panelId)!;

    expect(evidence).toHaveAttribute("aria-expanded", "false");
    expect(evidence).toHaveAttribute("type", "button");
    expect(panel).toHaveAttribute("aria-labelledby", evidence.id);
    expect(panel).toHaveAttribute("aria-hidden", "true");
    expect(panel).toHaveAttribute("inert");
    expect(memory.getAttribute("aria-controls")).not.toBe(panelId);
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Source" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Details action" })).not.toBeInTheDocument();
  });

  it("opens with Enter and closes with Space without moving keyboard focus", async () => {
    const user = userEvent.setup();
    render(
      <MotionDisclosure title="Evidence">
        <a href="#source">Source</a>
      </MotionDisclosure>,
    );
    const toggle = screen.getByRole("button", { name: "Evidence" });
    await user.tab();
    expect(toggle).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const panel = screen.getByRole("region", { name: "Evidence" });
    expect(panel).not.toHaveAttribute("inert");
    expect(screen.getByRole("link", { name: "Source" })).toBeInTheDocument();

    await user.keyboard(" ");
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(panel).toHaveAttribute("inert");
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("keeps child state and the newest open state through rapid repeated toggles", () => {
    render(
      <MotionDisclosure title="Memory" defaultOpen>
        <input aria-label="Draft" defaultValue="Original" />
      </MotionDisclosure>,
    );
    const toggle = screen.getByRole("button", { name: "Memory" });
    const draft = screen.getByRole("textbox", { name: "Draft" });
    fireEvent.change(draft, { target: { value: "Still here" } });
    for (let index = 0; index < 6; index += 1) fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("textbox", { name: "Draft" })).toBe(draft);
    expect(draft).toHaveValue("Still here");
    expect(screen.getByRole("region")).not.toHaveAttribute("inert");
  });

  it("returns focus to its toggle before a programmatic close hides a focused child", () => {
    render(
      <MotionDisclosure title="Memory" defaultOpen>
        <input aria-label="Draft" />
      </MotionDisclosure>,
    );
    const toggle = screen.getByRole("button", { name: "Memory" });
    screen.getByRole("textbox", { name: "Draft" }).focus();
    fireEvent.click(toggle);
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("does not submit a surrounding form", async () => {
    const user = userEvent.setup();
    const submit = vi.fn((event) => event.preventDefault());
    render(
      <form onSubmit={submit}>
        <MotionDisclosure title="Evidence">
          <p>Details</p>
        </MotionDisclosure>
      </form>,
    );
    await user.click(screen.getByRole("button", { name: "Evidence" }));
    expect(submit).not.toHaveBeenCalled();
  });
});
