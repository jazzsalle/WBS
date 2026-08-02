// 이메일 도메인 재검증 순수 헬퍼 테스트 (SOT §14.2 A-2)
// hd 파라미터는 편의 기능일 뿐이므로, 서버 측 재검증 로직이 위장 도메인을
// 정확히 걸러내는지 여기서 증명한다.

import { afterEach, describe, expect, it } from 'vitest';
import { getAllowedEmailDomain, isAllowedEmailDomain } from '@/lib/auth/guard';

describe('isAllowedEmailDomain (A-2 서버 측 재검증)', () => {
  it('도메인이 정확히 일치하면 허용한다', () => {
    expect(isAllowedEmailDomain('user@unes.co.kr', 'unes.co.kr')).toBe(true);
  });

  it('대소문자를 무시한다', () => {
    expect(isAllowedEmailDomain('User@UNES.CO.KR', 'unes.co.kr')).toBe(true);
    expect(isAllowedEmailDomain('user@unes.co.kr', 'UNES.co.kr')).toBe(true);
  });

  it('허용 도메인의 @ 접두어·공백을 관대하게 받는다', () => {
    expect(isAllowedEmailDomain('user@unes.co.kr', '@unes.co.kr')).toBe(true);
    expect(isAllowedEmailDomain('user@unes.co.kr', ' unes.co.kr ')).toBe(true);
  });

  it('다른 도메인은 거부한다', () => {
    expect(isAllowedEmailDomain('user@gmail.com', 'unes.co.kr')).toBe(false);
  });

  it('접미사 위장 도메인을 거부한다 — 부분 일치가 아니라 전체 일치', () => {
    expect(isAllowedEmailDomain('user@evil-unes.co.kr', 'unes.co.kr')).toBe(false);
    expect(isAllowedEmailDomain('user@unes.co.kr.evil.com', 'unes.co.kr')).toBe(false);
  });

  it('서브도메인을 거부한다', () => {
    expect(isAllowedEmailDomain('user@mail.unes.co.kr', 'unes.co.kr')).toBe(false);
  });

  it("'@'가 없거나 도메인이 비면 거부한다", () => {
    expect(isAllowedEmailDomain('unes.co.kr', 'unes.co.kr')).toBe(false);
    expect(isAllowedEmailDomain('', 'unes.co.kr')).toBe(false);
    expect(isAllowedEmailDomain('user@', 'unes.co.kr')).toBe(false);
  });

  it("로컬 파트에 '@'가 들어간 인용 주소는 마지막 '@' 기준으로 판정한다", () => {
    expect(isAllowedEmailDomain('"a@b"@unes.co.kr', 'unes.co.kr')).toBe(true);
    expect(isAllowedEmailDomain('"a@unes.co.kr"@evil.com', 'unes.co.kr')).toBe(false);
  });
});

describe('getAllowedEmailDomain (환경 변수 — 하드코딩 금지)', () => {
  const original = process.env.ALLOWED_EMAIL_DOMAIN;

  afterEach(() => {
    if (original === undefined) delete process.env.ALLOWED_EMAIL_DOMAIN;
    else process.env.ALLOWED_EMAIL_DOMAIN = original;
  });

  it('미설정이면 명시적 에러를 던진다 — 조용한 전체 허용 금지', () => {
    delete process.env.ALLOWED_EMAIL_DOMAIN;
    expect(() => getAllowedEmailDomain()).toThrow(/ALLOWED_EMAIL_DOMAIN/);
  });

  it('빈 문자열·공백뿐이어도 에러다', () => {
    process.env.ALLOWED_EMAIL_DOMAIN = '';
    expect(() => getAllowedEmailDomain()).toThrow(/ALLOWED_EMAIL_DOMAIN/);
    process.env.ALLOWED_EMAIL_DOMAIN = '   ';
    expect(() => getAllowedEmailDomain()).toThrow(/ALLOWED_EMAIL_DOMAIN/);
  });

  it('@ 접두어·공백·대문자를 정규화해 돌려준다', () => {
    process.env.ALLOWED_EMAIL_DOMAIN = ' @UNES.co.kr ';
    expect(getAllowedEmailDomain()).toBe('unes.co.kr');
  });
});
