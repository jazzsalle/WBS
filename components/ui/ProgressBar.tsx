// 진척률 바 (SOT §6.1, §7.15)
// 진척률은 저장하지 않고 읽을 때 계산한 값이 넘어온다 (O-4). 여기서는 표시만 한다.

export interface ProgressBarProps {
  /** 0~100. 범위를 벗어난 값은 잘라서 그린다 */
  value: number;
  /** 숫자 표기 노출 여부 */
  showValue?: boolean;
  label?: string;
  className?: string;
}

export default function ProgressBar({
  value,
  showValue = true,
  label,
  className = '',
}: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className={className}>
      <div className="flex items-center justify-between text-xs text-grey-500">
        <span>{label ?? '진척률'}</span>
        {showValue && <span className="font-semibold text-grey-700">{clamped}%</span>}
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={clamped}
        aria-label={label ?? '진척률'}
        className="mt-1 h-2 w-full overflow-hidden rounded-full bg-grey-200"
      >
        <div
          className="h-full rounded-full bg-blue-500 transition-[width]"
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}
