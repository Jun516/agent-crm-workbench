import type pg from "pg";
import { expect, it, vi } from "vitest";
import { planQuery } from "./query-plan";
import { executeWithIdentity } from "./read-plan-internal";

it("handles cancellation before the pool wait listener is registered and releases a late connection once", async () => {
  const controller = new AbortController();
  const register = controller.signal.addEventListener.bind(controller.signal);
  vi.spyOn(controller.signal, "addEventListener").mockImplementation((...args) => {
    register(...args);
    controller.abort();
  });
  const release = vi.fn();
  let resolveConnection!: (client: pg.PoolClient) => void;
  const connection = new Promise<pg.PoolClient>((resolve) => {
    resolveConnection = resolve;
  });
  const pool = { connect: () => connection } as unknown as pg.Pool;
  const pending = executeWithIdentity(
    pool,
    planQuery("Liste oportunidades abertas"),
    {
      userId: "synthetic",
      organizationId: "synthetic",
      aal: "aal1",
    },
    controller.signal,
  );
  await expect(pending).rejects.toThrow("ontology_cancelled");
  resolveConnection({ release } as unknown as pg.PoolClient);
  await connection;
  await Promise.resolve();
  expect(release).toHaveBeenCalledTimes(1);
});
