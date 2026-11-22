import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MissionDirectionControl } from "./MissionDirectionControl";

const mission = {
  id: "22222222-2222-4222-8222-222222222222",
  status: "needs_review",
  current_direction: "先核对报价",
  direction_revision: 2,
  direction_consumed_revision: 1,
};

afterEach(() => vi.unstubAllGlobals());

describe("workbench Mission direction control", () => {
  it("saves a versioned direction and opens the resumed run", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            runId: "run-new",
            replayed: false,
            customerSendPaused: true,
            directionRevision: 3,
          },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const onAccepted = vi.fn().mockResolvedValue(undefined);
    render(<MissionDirectionControl mission={mission} onAccepted={onAccepted} />);
    expect(screen.getByText("负责人方向：先核对报价")).toBeInTheDocument();
    expect(screen.getByText("新方向已接受，等待模型消费")).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "保存方向并继续任务" });
    expect(button).toBeDisabled();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("负责人补充任务方向"), "改用新的报价依据");
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(onAccepted).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(fetch.mock.calls[0]?.[0]).toBe(`/api/v1/ai/missions/${mission.id}/follow-up`);
    expect(new Headers(init.headers).get("Idempotency-Key")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(JSON.parse(String(init.body))).toEqual({ direction: "改用新的报价依据" });
    expect(onAccepted).toHaveBeenCalledWith({
      runId: "run-new",
      replayed: false,
      customerSendPaused: true,
      directionRevision: 3,
      direction: "改用新的报价依据",
    });
  });

  it("keeps the same idempotency key when the first response is uncertain", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              runId: "run-new",
              replayed: true,
              customerSendPaused: true,
              directionRevision: 3,
            },
          }),
        ),
      );
    vi.stubGlobal("fetch", fetch);
    const onAccepted = vi.fn().mockResolvedValue(undefined);
    render(<MissionDirectionControl mission={mission} onAccepted={onAccepted} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("负责人补充任务方向"), "改用新的报价依据");
    await user.click(screen.getByRole("button", { name: "保存方向并继续任务" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("offline");
    expect(onAccepted).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "保存方向并继续任务" }));
    await waitFor(() =>
      expect(onAccepted).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "run-new",
          replayed: true,
        }),
      ),
    );
    const first = new Headers(fetch.mock.calls[0]![1].headers).get("Idempotency-Key");
    const second = new Headers(fetch.mock.calls[1]![1].headers).get("Idempotency-Key");
    expect(first).toBe(second);
    expect(fetch.mock.calls[0]![1].body).toEqual(fetch.mock.calls[1]![1].body);
  });

  it("shows model consumption without offering another edit on a finished mission", () => {
    render(
      <MissionDirectionControl
        mission={{
          ...mission,
          status: "completed",
          direction_consumed_revision: 2,
        }}
        onAccepted={vi.fn()}
      />,
    );
    expect(screen.getByText("新方向已由模型读取（不等于业务完成）")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
