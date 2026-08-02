//! 세션 토큰 OS 키체인 저장 (SOT §14.2 A-4, §8.2 C-3 — localStorage 금지).
//! Windows Credential Manager / macOS Keychain에 저장한다.
//! 프론트는 lib/tauri/keychain.ts 래퍼를 통해서만 호출한다.
//!
//! Windows Credential Manager는 항목당 2560자(UTF-16) 제한이 있어
//! Supabase 세션 JSON(JWT 포함)이 통째로 들어가지 않는다.
//! 값을 청크로 쪼개 `{key}.{i}` 항목들에 나눠 저장하고 읽을 때 이어붙인다.

use keyring::Entry;

// 키체인 서비스 이름. tauri.conf.json identifier와 맞춘다
const SERVICE: &str = "kr.co.unes.wbs";

// Windows 제한: CRED_MAX_CREDENTIAL_BLOB_SIZE = 2560바이트. 값은 UTF-16(문자당 2바이트)으로
// 인코딩되므로 실질 한도는 1280자다 (keyring 에러 문구의 "2560 chars"는 바이트를 뜻함).
// BMP 밖 문자(2단위) 여유까지 감안해 1200자로 자른다
const CHUNK_CHARS: usize = 1200;

fn entry(key: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, key).map_err(|e| format!("키체인 접근 실패: {e}"))
}

fn chunk_key(key: &str, i: usize) -> String {
    format!("{key}.{i}")
}

/// 청크 항목과 (과거 형식의) 단일 항목을 모두 지운다. 없는 키는 무시 (멱등)
fn remove_all(key: &str) -> Result<(), String> {
    match entry(key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(e) => return Err(format!("키체인 삭제 실패: {e}")),
    }
    let mut i = 0;
    loop {
        match entry(&chunk_key(key, i))?.delete_credential() {
            Ok(()) => i += 1,
            Err(keyring::Error::NoEntry) => break,
            Err(e) => return Err(format!("키체인 삭제 실패: {e}")),
        }
    }
    Ok(())
}

#[tauri::command]
pub fn keychain_get(key: String) -> Result<Option<String>, String> {
    let mut parts: Vec<String> = Vec::new();
    let mut i = 0;
    loop {
        match entry(&chunk_key(&key, i))?.get_password() {
            Ok(v) => {
                parts.push(v);
                i += 1;
            }
            Err(keyring::Error::NoEntry) => break,
            Err(e) => return Err(format!("키체인 읽기 실패: {e}")),
        }
    }
    if !parts.is_empty() {
        return Ok(Some(parts.concat()));
    }
    // 청크 도입 전 단일 항목으로 저장된 값 호환
    match entry(&key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        // 없는 키는 에러가 아니라 None — 최초 실행에서 항상 발생한다
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("키체인 읽기 실패: {e}")),
    }
}

#[tauri::command]
pub fn keychain_set(key: String, value: String) -> Result<(), String> {
    // 이전 값의 청크 수가 더 많았을 수 있으므로 항상 전부 지우고 새로 쓴다
    remove_all(&key)?;
    let chars: Vec<char> = value.chars().collect();
    for (i, chunk) in chars.chunks(CHUNK_CHARS).enumerate() {
        let part: String = chunk.iter().collect();
        entry(&chunk_key(&key, i))?
            .set_password(&part)
            .map_err(|e| format!("키체인 쓰기 실패: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn keychain_delete(key: String) -> Result<(), String> {
    remove_all(&key)
}
