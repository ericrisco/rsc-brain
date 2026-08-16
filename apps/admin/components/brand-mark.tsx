export function BrandMark({ compact = false }: { compact?: boolean }) {
  return compact ? (
    <svg viewBox="0 0 32 32" role="img" aria-label="rsc-brain" className="size-8 text-text-primary">
      <rect x="0.75" y="0.75" width="30.5" height="30.5" rx="4" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <text x="6" y="22" fill="currentColor" fontFamily="var(--font-mono)" fontSize="17" fontWeight="600" letterSpacing="-1">
        r/
      </text>
    </svg>
  ) : (
    <span className="font-mono text-[1.1875rem] font-semibold tracking-[-0.025em] text-text-primary" aria-label="rsc-brain">
      rsc-brain
    </span>
  );
}
