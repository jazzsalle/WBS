// 공통 버튼 (SOT §7 화면 전반, 부록 E.4 — 토스 스타일: 파란 주 버튼, 테두리 없는 회색 보조 버튼)
// 스타일 토큰을 한 곳에 모아 화면마다 클래스 문자열이 갈라지는 것을 막는다.
// Tailwind는 클래스명을 정적으로 스캔하므로 변형별 클래스를 문자열 조합이 아니라
// 완전한 형태로 나열한다.

import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
type Size = 'sm' | 'md';

const VARIANT_CLASSES: Record<Variant, string> = {
  primary: 'bg-blue-500 text-white hover:bg-blue-600',
  secondary: 'bg-grey-100 text-grey-800 hover:bg-grey-200',
  danger: 'bg-red-500 text-white hover:bg-red-600',
  ghost: 'text-grey-700 hover:bg-grey-100',
};

const SIZE_CLASSES: Record<Size, string> = {
  sm: 'px-3 py-1.5 text-t7',
  md: 'px-4 py-2.5 text-t6',
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
