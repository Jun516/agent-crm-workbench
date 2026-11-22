import { beforeEach, describe, expect, it, vi } from "vitest";

import { combinarInterfaces } from "@/lib/navigation/interface";

const { requireAuth, resolveActiveOrg, readHomeDashboard } = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  resolveActiveOrg: vi.fn(),
  readHomeDashboard: vi.fn(),
}));

vi.mock("@/lib/auth/server", () => ({ requireAuth, resolveActiveOrg }));
vi.mock("@/lib/home/read-home-dashboard", () => ({ readHomeDashboard }));
vi.mock("./_components/HomeDashboard", () => ({ HomeDashboard: () => null }));
vi.mock("next/navigation", () => ({
  redirect: (destination: string) => {
    throw new Error(`NEXT_REDIRECT:${destination}`);
  },
}));

import AppHome from "./page";

const organization = { orgId: "org-1", name: "Organização", role: "agent" };

beforeEach(() => {
  vi.clearAllMocks();
  requireAuth.mockResolvedValue({ is_platform_admin: false, support: null, full_name: "Pessoa" });
  resolveActiveOrg.mockResolvedValue(organization);
  readHomeDashboard.mockResolvedValue({
    contactCount: 0,
    activeLeadCount: 0,
    openTaskCount: 0,
    activeLeadValueCents: 0,
    tasks: [],
    agentRuns: [],
    stages: [],
    pipelineName: null,
  });
});

describe("entrada da interface por vínculo", () => {
  it.each(["/app/products", "/app/tasks"])(
    "abre a área %s disponível nos recortes da organização e do vínculo",
    async (destination) => {
      const interfaceSettings = combinarInterfaces(
        { preset: "completa", destinos: ["/app/products", "/app/tasks"] },
        { preset: "simplificada", destinos: [destination, "/app/inbox"] },
      );
      resolveActiveOrg.mockResolvedValue({ ...organization, interface_settings: interfaceSettings });

      await expect(AppHome()).rejects.toThrow(`NEXT_REDIRECT:${destination}`);
      expect(readHomeDashboard).not.toHaveBeenCalled();
    },
  );

  it("usa o perfil quando o papel não pode abrir a área selecionada", async () => {
    resolveActiveOrg.mockResolvedValue({
      ...organization,
      role: "viewer",
      interface_settings: { preset: "completa", destinos: ["/app/settings/tenant"] },
    });

    await expect(AppHome()).rejects.toThrow("NEXT_REDIRECT:/app/settings/profile");
    expect(readHomeDashboard).not.toHaveBeenCalled();
  });

  it("abre o painel da interface completa", async () => {
    await AppHome();
    expect(readHomeDashboard).toHaveBeenCalledWith(organization.orgId, false);
  });

  it("mantém o painel e o papel efetivo do acompanhamento de leitura", async () => {
    requireAuth.mockResolvedValue({
      is_platform_admin: true,
      support: { access_mode: "support_readonly" },
    });
    resolveActiveOrg.mockResolvedValue({ ...organization, role: "viewer" });

    await AppHome();
    expect(readHomeDashboard).toHaveBeenCalledWith(organization.orgId, false);
  });
});
