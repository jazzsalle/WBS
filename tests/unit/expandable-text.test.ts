import { describe, expect, it } from 'vitest';
import { placeOverlay, splitFirstLine } from '@/components/ui/expandableTextLayout';

describe('splitFirstLine (U-12)', () => {
  it('개행 없는 텍스트는 그대로, 더보기 없음', () => {
    expect(splitFirstLine('공인시험 성적서')).toEqual({ first: '공인시험 성적서', hasMore: false });
  });

  it('여러 줄이면 첫 줄 + hasMore', () => {
    expect(splitFirstLine('1) 시험 방법\n2) 판정 기준')).toEqual({ first: '1) 시험 방법', hasMore: true });
  });

  it('CRLF도 줄로 센다', () => {
    expect(splitFirstLine('가\r\n나')).toEqual({ first: '가', hasMore: true });
  });

  it('앞쪽 빈 줄은 건너뛰고, 뒤쪽 빈 줄만 있으면 더보기 없음', () => {
    expect(splitFirstLine('\n\n  첫 내용  \n   \n')).toEqual({ first: '첫 내용', hasMore: false });
  });

  it('빈 문자열·공백만', () => {
    expect(splitFirstLine('')).toEqual({ first: '', hasMore: false });
    expect(splitFirstLine(' \n \t')).toEqual({ first: '', hasMore: false });
  });
});

describe('placeOverlay', () => {
  it('아래 공간이 넉넉하면 앵커 바로 아래', () => {
    const p = placeOverlay({ left: 100, top: 100, bottom: 120 }, 1280, 800);
    expect(p).toEqual({ left: 100, width: 448, maxHeight: 320, top: 124, bottom: null });
  });

  it('오른쪽 끝을 넘으면 화면 안으로 당긴다', () => {
    const p = placeOverlay({ left: 1200, top: 100, bottom: 120 }, 1280, 800);
    expect(p.left).toBe(1280 - 448 - 8);
  });

  it('좁은 화면에서는 폭을 줄이고 왼쪽 여백을 지킨다', () => {
    const p = placeOverlay({ left: 0, top: 100, bottom: 120 }, 300, 800);
    expect(p.width).toBe(284);
    expect(p.left).toBe(8);
  });

  it('아래가 좁고 위가 넓으면 위로 뒤집는다', () => {
    const p = placeOverlay({ left: 10, top: 700, bottom: 720 }, 1280, 800);
    expect(p.top).toBeNull();
    expect(p.bottom).toBe(800 - 700 + 4);
    expect(p.maxHeight).toBe(320);
  });

  it('위로 뒤집어도 높이는 위 공간을 넘지 않는다', () => {
    const p = placeOverlay({ left: 10, top: 200, bottom: 700 }, 1280, 800);
    expect(p.bottom).not.toBeNull();
    expect(p.maxHeight).toBe(200 - 4 - 8);
  });
});
