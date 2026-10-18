// A delivery-tracker strip for a court case: six dots in two phases
// (Arbitration, then Court). Done steps are filled, the current one glows,
// later ones are grey. With onSelect, every dot is a button, so a person can
// tap ahead and see what each step will look like.

import { COURT_STEPS, stepIndex, type CaseProgress, type CourtStepId } from '../../lib/courtSteps';

export function CaseTracker({
  progress,
  selected,
  onSelect,
  compact = false,
}: {
  progress: CaseProgress;
  selected?: CourtStepId;
  onSelect?: (id: CourtStepId) => void;
  compact?: boolean;
}) {
  const currentIdx = stepIndex(progress.current);
  const dot = compact ? 'w-5 h-5 text-[10px]' : 'w-8 h-8 text-xs';
  const lineTop = compact ? 'top-2.5' : 'top-4';

  return (
    <div>
      <div className={`grid grid-cols-6 gap-1 ${compact ? 'mb-1' : 'mb-2'}`}>
        <PhaseLabel span={2} label="Arbitration" active={currentIdx <= 1} compact={compact} />
        <PhaseLabel span={4} label="Court" active={currentIdx >= 2} compact={compact} />
      </div>
      <ol className="grid grid-cols-6">
        {COURT_STEPS.map((step, i) => {
          const done = i < currentIdx || (i === currentIdx && progress.current === 'final' && !progress.endedEarly);
          const isCurrent = i === currentIdx && !done;
          const skipped = progress.endedEarly !== null && i > currentIdx;
          const isSelected = selected === step.id;
          const reached = i <= currentIdx;

          const dotClass = done
            ? 'bg-teal text-white'
            : isCurrent
              ? progress.endedEarly
                ? 'bg-navy-light border-2 border-gray-400 text-gray-300'
                : 'bg-teal/20 border-2 border-teal text-teal shadow-[0_0_0_4px_rgba(13,148,136,0.18)]'
              : 'bg-navy-light text-gray-500';

          const content = (
            <>
              {i > 0 && (
                <span
                  aria-hidden
                  className={`absolute ${lineTop} right-1/2 w-full h-0.5 -z-0 ${reached ? 'bg-teal' : 'bg-navy-light'}`}
                />
              )}
              <span
                className={`relative z-10 ${dot} rounded-full flex items-center justify-center font-medium ${dotClass} ${
                  isSelected ? 'ring-2 ring-gold ring-offset-2 ring-offset-navy' : ''
                }`}
              >
                {done ? '✓' : skipped ? '–' : i + 1}
              </span>
              <span
                className={`relative z-10 mt-1 ${compact ? 'text-[9px]' : 'text-[11px]'} leading-tight text-center ${
                  isSelected ? 'text-white font-medium' : isCurrent ? 'text-teal' : 'text-gray-500'
                }`}
              >
                {step.label}
              </span>
            </>
          );

          return (
            <li key={step.id} className="relative flex flex-col items-center">
              {onSelect ? (
                <button
                  type="button"
                  onClick={() => onSelect(step.id)}
                  aria-label={`Step ${i + 1}: ${step.title}`}
                  aria-current={isCurrent ? 'step' : undefined}
                  className="relative flex flex-col items-center w-full focus:outline-none"
                >
                  {content}
                </button>
              ) : (
                content
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function PhaseLabel({ span, label, active, compact }: { span: number; label: string; active: boolean; compact: boolean }) {
  return (
    <div className={`${span === 2 ? 'col-span-2' : 'col-span-4'} border-b ${active ? 'border-gold/60' : 'border-navy-light'}`}>
      <span
        className={`block text-center uppercase tracking-wider pb-1 ${compact ? 'text-[9px]' : 'text-[10px]'} ${
          active ? 'text-gold' : 'text-gray-500'
        }`}
      >
        {label}
      </span>
    </div>
  );
}
