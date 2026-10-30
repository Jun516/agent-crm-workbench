import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ read: vi.fn(), memories: vi.fn() }));
vi.mock("@/app/api/v1/contacts/_handler", () => ({
  getContactHandler: mocks.read,
  listContactsHandler: vi.fn(),
}));
vi.mock("@/lib/ai/integrations/mem0", () => ({ readConfirmedCustomerMemory: mocks.memories }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({}) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/contacts/proposta-de-dado", () => ({
  CAMPOS_PROPONIVEIS: ["email", "name", "phone_number"],
  proporDadoDoContato: vi.fn(),
}));
import { crmGetContact } from "./contacts";

const contact = {
  id: "contact-1",
  organization_id: "org-1",
  name: "Current name",
  display_name: "Current display",
  email: "current@example.test",
  phone_number: "+15550000000",
  birthdate: "1990-02-01",
  tags: ["confirmed-customer"],
  source: "manual",
  consent: { profiling: { granted_at: "2026-10-01T00:00:00Z" } },
  is_anonymized: false,
  is_merged_into: null,
  is_blocked: false,
  cpf_available: true,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-26T00:00:00Z",
  last_activity_at: null,
};
const supabase = {};
const ctx = {
  organizationId: "org-1",
  supabase,
  actor: { type: "ai_agent", id: "agent-1" },
  requestId: "request-1",
} as never;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-27T00:00:00Z"));
  mocks.read.mockReset().mockResolvedValue(contact);
  mocks.memories.mockReset().mockResolvedValue({
    status: "local",
    memories: [{ body: "Confirmed communication fact" }],
  });
});
afterEach(() => vi.useRealTimers());

describe("crm_get_contact current facts and profile permission", () => {
  it("keeps ordinary contact reads available without profiling consent", async () => {
    mocks.read.mockResolvedValue({ ...contact, consent: {} });
    const result = await crmGetContact.handler({ contact_id: contact.id }, ctx);
    expect(result).toMatchObject({
      name: contact.name,
      phone: contact.phone_number,
      profile_context: { status: "not_permitted" },
      confirmed_customer_memory: { status: "local" },
    });
    expect(result).not.toHaveProperty("birthdate");
  });

  it("reads canonical fields again after the optional memory wait", async () => {
    mocks.read
      .mockResolvedValueOnce({ ...contact, name: "STALE IDENTITY" })
      .mockResolvedValueOnce(contact);
    const result = await crmGetContact.handler({ contact_id: contact.id }, ctx);
    expect(result).toMatchObject({
      name: "Current name",
      profile_context: { status: "available", profile: { birthdate: contact.birthdate } },
    });
    expect(JSON.stringify(result)).not.toContain("STALE IDENTITY");
    expect(mocks.read).toHaveBeenCalledTimes(2);
    expect(mocks.read).toHaveBeenLastCalledWith(
      supabase,
      expect.objectContaining({ organization_id: "org-1" }),
      { contactId: contact.id, decryptPurpose: null },
    );
  });

  it("does not reuse the initial consent when it was revoked during the wait", async () => {
    mocks.read
      .mockResolvedValueOnce(contact)
      .mockResolvedValueOnce({ ...contact, consent: { profiling: { granted_at: null } } });
    const result = await crmGetContact.handler({ contact_id: contact.id }, ctx);
    expect(result).toMatchObject({ profile_context: { status: "not_permitted" } });
    expect(JSON.stringify(result)).not.toContain(contact.birthdate);
  });

  it.each([{ is_anonymized: true }, { is_merged_into: "surviving-contact" }])(
    "discards identity and fetched memory after privacy changes: %j",
    async (privacy) => {
      mocks.read.mockResolvedValueOnce(contact).mockResolvedValueOnce({ ...contact, ...privacy });
      const result = await crmGetContact.handler({ contact_id: contact.id }, ctx);
      expect(result).toMatchObject({
        confirmed_customer_memory: { status: "unavailable", memories: [] },
        profile_context: { status: "unavailable" },
      });
      expect(JSON.stringify(result)).not.toMatch(
        /current@example|Confirmed communication fact|1990-02-01/,
      );
    },
  );
});
