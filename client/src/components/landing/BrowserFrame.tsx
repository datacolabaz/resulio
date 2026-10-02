/**
 * Chrome-window frame around a product preview: three dots and a fake address bar, purely
 * decorative (aria-hidden) so it never gets in the way of the real content's own accessible
 * name. `float` adds the hero's very subtle idle motion (off under prefers-reduced-motion — see
 * the `.hero-preview-float` rule in index.css, which only exists at all outside that preference).
 */
export function BrowserFrame({
  children,
  float = false,
  className = "",
}: {
  children: React.ReactNode;
  float?: boolean;
  className?: string;
}) {
  return (
    <div className={`overflow-hidden rounded-2xl border border-border bg-card shadow-card ${float ? "hero-preview-float" : ""} ${className}`}>
      <div aria-hidden className="flex items-center gap-2 border-b border-border bg-muted/60 px-4 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-destructive/50" />
        <span className="h-2.5 w-2.5 rounded-full bg-warning/50" />
        <span className="h-2.5 w-2.5 rounded-full bg-success/50" />
        <span className="ml-3 truncate rounded-full bg-background px-3 py-1 text-xs text-muted-foreground">resulio.co/app</span>
      </div>
      {children}
    </div>
  );
}
