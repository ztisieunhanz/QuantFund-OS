import type { ReactNode } from "react";
import { clsx } from "@/lib/clsx";

export function Panel({
  title,
  right,
  children,
  className,
}: {
  title: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={clsx("flex min-h-0 flex-col border border-line bg-panel", className)}>
      <header className="flex items-center justify-between border-b border-line px-3 py-1.5">
        <h2 className="font-mono text-[10px] font-semibold tracking-[0.18em] text-cyan uppercase">
          {title}
        </h2>
        {right ? <div className="font-mono text-[10px] text-muted">{right}</div> : null}
      </header>
      <div className="min-h-0 flex-1 p-3">{children}</div>
    </section>
  );
}
