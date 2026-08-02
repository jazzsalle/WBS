//! 세션 토큰 OS 키체인 저장 (SOT §14.2 A-4, §8.2 C-3 — localStorage 금지).
//! Windows Credential Manager / macOS Keychain에 저장한다.
//! 프론트는 lib/tauri/keychain.ts 래퍼를 통해서만 호출한다.

use keyring::Entry;

// 키체인 서비스 이름. tauri.conf.json identifier와 맞춘다
const SERVICE: &str = "kr.co.unes.wbs";

fn entry(key: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, key).map_err(|e| format!("키체인 접근 실패: {e}"))
}

#[tauri::command]
pub fn keychain_get(key: String) -> Result<Option<String>, String> {
    match entry(&key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        // 없는 키는 에러가 아니라 None — 최초 실행에서 항상 발생한다
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("키체인 읽기 실패: {e}")),
    }
}

#[tauri::command]
pub fn keychain_set(key: String, value: String) -> Result<(), String> {
    entry(&key)?
        .set_password(&value)
        .map_err(|e| format!("키체인 쓰기 실패: {e}"))
}

#[tauri::command]
pub fn keychain_delete(key: String) -> Result<(), String> {
    match entry(&key)?.delete_credential() {
        Ok(()) => Ok(()),
        // 이미 없는 키 삭제는 성공으로 취급 (멱등)
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("키체인 삭제 실패: {e}")),
    }
}
