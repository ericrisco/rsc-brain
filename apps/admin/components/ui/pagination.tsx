import { Button } from "./button";

export function Pagination({
  label,
  previousLabel = "Previous",
  nextLabel = "Next",
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
}: {
  label: string;
  previousLabel?: string;
  nextLabel?: string;
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <nav aria-label="Pagination" className="flex items-center justify-between gap-4 border-t border-border pt-4">
      <Button variant="outline" size="sm" disabled={!hasPrevious} onClick={onPrevious}>
        {previousLabel}
      </Button>
      <span className="text-xs text-text-secondary" aria-live="polite">
        {label}
      </span>
      <Button variant="outline" size="sm" disabled={!hasNext} onClick={onNext}>
        {nextLabel}
      </Button>
    </nav>
  );
}
