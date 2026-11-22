export type MemoryCapabilities = { can_confirm: boolean; can_arbitrate: boolean };
export type MemoryActivityView = {
  id: string;
  revision: string;
  kind: "customer_memory_extract" | "customer_memory_consolidate";
  source_kind: string;
  state:
    | "queued"
    | "running"
    | "retry_wait"
    | "failed"
    | "unavailable"
    | "skipped"
    | "continuing"
    | "completed"
    | "unverified";
  created_at: string;
  run_after: string;
  candidates: number | null;
  conflicts: number | null;
  retryable: boolean;
};
export type CustomerMemoryView = {
  id: string;
  category: string;
  body: string;
  sync_state: string;
  write_outcome: string;
  deleted_at: string | null;
  remote_deleted_at: string | null;
  memory_type: string;
  risk_level: string;
  retention_policy: string;
  ttl_expires_at: string | null;
  review_due_at: string | null;
  locked: boolean;
  needs_review: boolean;
  review_reason: string | null;
  confirmed_at: string;
  confirmed_by: string | null;
  policy_revision: number;
  supersedes: string | null;
  evidence_conversation_id: string | null;
  expired: boolean;
};
export type MemoryConflictView = {
  id: string;
  memory_id: string;
  other_memory_id: string | null;
  candidate_id: string | null;
  kind: "l0_l1" | "l1_l1" | "l2_l1";
  created_at: string;
  business_field: string | null;
  memory_body: string;
  memory_revision: number;
  memory_locked: boolean;
  other_body: string | null;
  other_revision: number | null;
  other_locked: boolean | null;
};
export type MemoryCandidateView = {
  id: string;
  body: string;
  memory_type: string;
  risk_level: string;
  source_kind: string;
  category: string;
  attribute_key: string | null;
  attribute_value: string | null;
  model_confidence: number | string | null;
  created_at: string;
  revision_token: string;
  ttl_expires_at: string | null;
  evidence: {
    id: string;
    conversation_id: string | null;
    message_id: string | null;
    excerpt: string;
    observed_at: string;
  }[];
  conflicts: { id: string; memory_id: string; kind: string; created_at: string }[];
};
export const MEMORY_TYPE_LABELS: Record<string, string> = {
  constraint: "约束 / 禁忌",
  commercial_preference: "商业偏好",
  communication_preference: "沟通偏好",
  temporary_request: "临时诉求",
  relationship_context: "关系背景",
};

export function localMemoryDateValue(value: string) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
