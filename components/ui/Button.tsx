// 공통 버튼 (SOT §7 화면 전반)
// 스타일 토큰을 한 곳에 모아 화면마다 클래스 문자열이 갈라지는 것을 막는다.
// Tailwind는 클래스명을 정적으로 스캔하므로 변형별 클래스를 문자열 조합이 아니라
// 완전한 형태로 나열한다.

import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
type Size = 'sm' | 'md';

const VARIANT_CLASSES: Record<Variant, string> = {
  primary: 'bg-slate-900 text-white hover:bg-slate-700',
  secondary: 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50',
  danger: 'bg-red-600 text-white hover:bg-red-500',
  ghost: 'text-slate-600 hover:bg-slate-100',
};

const SIZE_CLASSES: Record<Size, string> = {
  sm: 'px-3 py-1.5 text-xs',
  md: 'px-4 py-2.5 text-sm',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export default function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      // 명시하지 않으면 폼 안에서 submit으로 동작해 의도치 않은 저장이 일어난다
      type={type}
      className={`rounded-lg font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${className}`}
      {...rest}
    />
  );
}
