"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import styles from "./motion-disclosure.module.css";

export type MotionDisclosureProps = Readonly<{
  /** Keep the title non-interactive: it is rendered inside the toggle button. */
  title: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  defaultOpen?: boolean;
}>;

/** A local disclosure: toggling never mounts/unmounts children or waits on a timer. */
export function MotionDisclosure({
  title,
  children,
  className,
  contentClassName,
  defaultOpen = false,
}: MotionDisclosureProps) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerId = `${id}-trigger`;
  const panelId = `${id}-panel`;

  return (
    <div className={cn(styles.root, className)} data-state={open ? "open" : "closed"}>
      <button
        id={triggerId}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        className="flex min-h-11 w-full items-center justify-between gap-2 rounded-md py-2 text-left text-sm font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-hidden lg:min-h-9"
        onClick={(event) => {
          // A programmatic close must not leave focus inside the newly inert panel.
          if (open && panelRef.current?.contains(document.activeElement)) {
            event.currentTarget.focus();
          }
          setOpen((current) => !current);
        }}
      >
        <span className="min-w-0">{title}</span>
        <ChevronDown aria-hidden="true" className={cn("size-4 shrink-0", styles.chevron)} />
      </button>
      <div
        ref={panelRef}
        id={panelId}
        role="region"
        aria-labelledby={triggerId}
        aria-hidden={!open}
        inert={!open}
        className={styles.panel}
      >
        <div className={styles.viewport}>
          <div className={cn("pt-1", contentClassName)}>{children}</div>
        </div>
      </div>
    </div>
  );
}
