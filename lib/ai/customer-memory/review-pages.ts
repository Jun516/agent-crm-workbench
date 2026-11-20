import { z } from "zod";
import type { Queryable } from "@/lib/agent-engine/queue/queue";

const id = z.uuid().transform((value) => value.toLowerCase());
export const memoryReviewPageSchema = z
  .discriminatedUnion("mode", [
    z.object({ mode: z.literal("self"), after: id.nullable() }).strict(),
    z
      .object({
        mode: z.literal("pair"),
        left_after: id.nullable(),
        left_through: id,
        right_after: id,
      })
      .strict(),
  ])
  .refine(
    (page) =>
      page.mode === "self" ||
      ((!page.left_after || page.left_after < page.left_through) &&
        page.right_after >= page.left_through),
    "Invalid review page order",
  );
export type MemoryReviewPage = z.infer<typeof memoryReviewPageSchema>;
export interface ReviewMemory {
  id: string;
  category: string;
  body: string;
  content_hash: string;
  policy_revision: number;
  memory_type: string;
  locked: boolean;
}

/** Triangular page pairs cover cross-page contradictions with <=100 facts per call.
 * The left range stays fixed across continuations; deletion must not shift its boundary. */
export async function loadMemoryReviewPage(
  db: Queryable,
  org: string,
  contact: string,
  until: string,
  input?: MemoryReviewPage,
) {
  const page = memoryReviewPageSchema.parse(input ?? { mode: "self", after: null });
  const read = async (after: string | null, through: string | null, limit: number) =>
    (
      await db.query<ReviewMemory>(
        `select id,category,body,content_hash,policy_revision,memory_type,locked from ai_customer_memories
     where organization_id=$1 and contact_id=$2 and deleted_at is null and created_at<=$3::timestamptz
       and (ttl_expires_at is null or ttl_expires_at>now())
       and ($4::uuid is null or id>$4) and ($5::uuid is null or id<=$5)
     order by id limit $6`,
        [org, contact, until, after, through, limit],
      )
    ).rows;
  if (page.mode === "self") {
    const rows = await read(page.after, null, 51),
      selected = rows.slice(0, 50);
    const next: MemoryReviewPage | null =
      rows.length > 50
        ? {
            mode: "pair",
            left_after: page.after,
            left_through: selected.at(-1)!.id,
            right_after: selected.at(-1)!.id,
          }
        : null;
    return { memories: selected, next };
  }
  const left = await read(page.left_after, page.left_through, 50);
  const right = await read(page.right_after, null, 51),
    selected = right.slice(0, 50);
  const next: MemoryReviewPage =
    right.length > 50
      ? { ...page, right_after: selected.at(-1)!.id }
      : { mode: "self", after: page.left_through };
  return { memories: [...left, ...selected], next };
}
