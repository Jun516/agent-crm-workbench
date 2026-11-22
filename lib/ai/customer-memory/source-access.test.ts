import { beforeEach, describe, expect, it, vi } from "vitest";
import { readableMemoryConversations, readableMemoryRuns } from "./source-access";
const { fetchIds } = vi.hoisted(() => ({ fetchIds: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => {
      const q = { select: () => q, eq: () => q, in: fetchIds };
      return q;
    },
  }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  fetchIds.mockImplementation(async (_key, ids: string[]) => ({
    data: ids.filter((id) => id.startsWith("public")).map((id) => ({ id })),
    error: null,
  }));
});
describe("RLS source lookup batches", () => {
  it("applies the same bounded RLS lookup to report source IDs", async () => {
    const allowed = await readableMemoryRuns(
      "org",
      Array.from({ length: 205 }, (_, i) => `${i % 2 ? "private" : "public"}-${i}`),
    );
    expect(allowed.size).toBe(103);
    expect(fetchIds).toHaveBeenCalledTimes(3);
  });
  it("does not truncate a large source list or include unreadable conversations", async () => {
    const ids = Array.from({ length: 205 }, (_, i) => `${i % 2 ? "private" : "public"}-${i}`);
    const allowed = await readableMemoryConversations("org", [...ids, ids[0]!]);
    expect(allowed.size).toBe(103);
    expect(fetchIds).toHaveBeenCalledTimes(3);
    expect(fetchIds.mock.calls.every((c) => c[1].length <= 100)).toBe(true);
  });
  it("fails the whole read rather than silently returning a partial permission set", async () => {
    fetchIds
      .mockResolvedValueOnce({ data: [{ id: "public-1" }], error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "unavailable" } });
    await expect(
      readableMemoryConversations(
        "org",
        Array.from({ length: 101 }, (_, i) => `public-${i}`),
      ),
    ).rejects.toThrow("source_unavailable");
  });
});
