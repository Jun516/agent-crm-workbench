import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { roleAtLeast } from "@/lib/auth/types";
import { readHomeDashboard } from "@/lib/home/read-home-dashboard";
import { destinosDaInterface, homeDaInterface, permitidos } from "@/lib/navigation/interface";
import { HomeDashboard } from "./_components/HomeDashboard";

export const dynamic = "force-dynamic";
export const metadata = { title: "首页" };

export default async function AppHome() {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org) {
    return <section className="mx-auto max-w-3xl rounded-lg border bg-card p-8"><h1 className="text-2xl font-semibold">暂时没有可用的工作区</h1><p className="mt-2 text-sm text-muted-foreground">请联系组织管理员确认你的成员权限。</p></section>;
  }

  if (!user.support) {
    const platform = user.is_platform_admin;
    const visible = destinosDaInterface(org.interface_settings, platform, org.role);
    // A entrada de uma interface restrita segue a mesma seleção do menu.
    if (visible.length < permitidos(platform, org.role).length) {
      redirect(homeDaInterface(org.interface_settings, platform, org.role));
    }
  }

  const result = await readHomeDashboard(org.orgId, roleAtLeast(org.role, "manager"))
    .then((data) => ({ data, failed: false as const }))
    .catch(() => ({ data: null, failed: true as const }));
  if (result.failed) {
    return (
      <section className="mx-auto max-w-3xl rounded-lg border bg-card p-8">
        <p className="text-sm font-medium text-destructive">首页数据暂时无法加载</p>
        <p className="mt-2 text-sm text-muted-foreground">请刷新页面重试；CRM 数据没有被修改。</p>
      </section>
    );
  }

  const displayName = user.full_name?.trim().split(/\s+/)[0] || "伙伴";
  return <HomeDashboard data={result.data} displayName={displayName} workspaceName={org.name} />;
}
