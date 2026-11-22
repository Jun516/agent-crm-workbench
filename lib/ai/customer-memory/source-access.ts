import { createClient } from "@/lib/supabase/server";

/** Evidence links obey the same session RLS as opening the Inbox conversation. */
export async function readableMemoryConversations(org: string, ids: string[]) {
  if (!ids.length) return new Set<string>();
  const client = await createClient();
  const allowed = new Set<string>();
  const unique = [...new Set(ids)];
  for (let offset = 0; offset < unique.length; offset += 100) {
    const result = await client
      .from("conversations")
      .select("id")
      .eq("organization_id", org)
      .in("id", unique.slice(offset, offset + 100));
    if (result.error) throw new Error("customer_memory_source_unavailable");
    result.data.forEach((row) => allowed.add(row.id));
  }
  return allowed;
}

/** Run-source visibility follows the existing workbench table's session RLS. */
export async function readableMemoryRuns(org: string, ids: string[]) {
  if (!ids.length) return new Set<string>();
  const client = await createClient();
  const allowed = new Set<string>(),
    unique = [...new Set(ids)];
  for (let offset = 0; offset < unique.length; offset += 100) {
    const result = await client
      .from("ai_workbench_runs")
      .select("id")
      .eq("organization_id", org)
      .in("id", unique.slice(offset, offset + 100));
    if (result.error) throw new Error("customer_memory_source_unavailable");
    result.data.forEach((row) => allowed.add(row.id));
  }
  return allowed;
}
