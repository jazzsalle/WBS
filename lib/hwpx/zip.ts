// hwpx(OWPML zip) 판정 + 섹션 XML 해제 (SOT §6.18 HX-1, S-24·S-25·S-26).
//
// 클라이언트(브라우저)와 Node(vitest)가 같은 코드를 돈다 — DOM·Node 전역을 쓰지 않는다(S-33).
// 계획서는 이미지 때문에 100MB급이라 filter로 mimetype과 section XML만 inflate한다. BinData까지 풀면
// 브라우저 메모리가 파일 크기의 몇 배로 뛴다.

import { strFromU8, unzipSync } from 'fflate';

/** .hwp·PDF·다른 파일 — 사용자가 할 일은 "hwpx로 다시 저장"이다 */
export const HWPX_SAVE_AS_MESSAGE = 'hwpx로 저장해 다시 올려 주세요';
/** zip이지만 OWPML이 아니거나 본문 섹션이 없다 */
export const HWPX_NOT_HWPX_MESSAGE = 'hwpx 형식이 아닙니다';

const HWPX_MIMETYPE = 'application/hwp+zip';
const MIMETYPE_ENTRY = 'mimetype';
const SECTION_ENTRY = /^Contents\/section(\d+)\.xml$/;

export type HwpxSectionsResult =
  | { ok: true; sections: { section: number; xml: string }[] }
  | { ok: false; message: string };

function startsWith(bytes: Uint8Array, sig: readonly number[]): boolean {
  if (bytes.length < sig.length) return false;
  return sig.every((b, i) => bytes[i] === b);
}

const ZIP_SIG = [0x50, 0x4b] as const; // 'PK'
const OLE_SIG = [0xd0, 0xcf, 0x11, 0xe0] as const; // .hwp(HWP 5.x) 복합 문서
const PDF_SIG = [0x25, 0x50, 0x44, 0x46] as const; // '%PDF'

export function readHwpxSections(bytes: Uint8Array, fileName?: string): HwpxSectionsResult {
  if (fileName !== undefined && !fileName.toLowerCase().endsWith('.hwpx')) {
    return { ok: false, message: HWPX_SAVE_AS_MESSAGE };
  }
  // 확장자만 .hwpx로 바꾼 hwp·PDF도 "형식 아님"보다 "다시 저장"이 사용자가 할 일을 정확히 알려 준다
  if (startsWith(bytes, OLE_SIG) || startsWith(bytes, PDF_SIG)) {
    return { ok: false, message: HWPX_SAVE_AS_MESSAGE };
  }
  if (!startsWith(bytes, ZIP_SIG)) return { ok: false, message: HWPX_NOT_HWPX_MESSAGE };

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter: (file) => file.name === MIMETYPE_ENTRY || SECTION_ENTRY.test(file.name),
    });
  } catch {
    // 깨진 zip — 원인 문구(fflate 내부 메시지)보다 사용자가 알아볼 판정을 돌려준다
    return { ok: false, message: HWPX_NOT_HWPX_MESSAGE };
  }

  const mime = entries[MIMETYPE_ENTRY];
  if (!mime || strFromU8(mime).trim() !== HWPX_MIMETYPE) {
    return { ok: false, message: HWPX_NOT_HWPX_MESSAGE };
  }

  const sections: { section: number; xml: string }[] = [];
  for (const [name, data] of Object.entries(entries)) {
    const m = SECTION_ENTRY.exec(name);
    if (m) sections.push({ section: Number(m[1]), xml: strFromU8(data) });
  }
  if (sections.length === 0) return { ok: false, message: HWPX_NOT_HWPX_MESSAGE };
  // 문자열 정렬이면 section10이 section2보다 앞선다(S-26)
  sections.sort((a, b) => a.section - b.section);
  return { ok: true, sections };
}
