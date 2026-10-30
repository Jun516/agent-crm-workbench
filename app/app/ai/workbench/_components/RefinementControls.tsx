"use client";

export function RefinementControls({
  enabled,
  onChange,
  mode,
}: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  mode: "inspect" | "act";
}) {
  return (
    <div className="space-y-2 rounded-md border p-3 text-sm">
      <label className="flex items-center gap-2 font-medium">
        <input
          type="checkbox"
          checked={mode === "inspect" && enabled}
          disabled={mode !== "inspect"}
          onChange={(event) => onChange(event.target.checked)}
        />
        多候选自精炼（只读）
      </label>
      <p className="text-xs text-muted-foreground">
        最多两轮、每轮两个只读候选，经 Probe 检查后汇总；共享本次预算，可能提前停止。
        仅复用方法提示，不训练模型，也不自动发布业务规则。
        {mode !== "inspect" && " 切换到只读检查后可启用。"}
      </p>
    </div>
  );
}
