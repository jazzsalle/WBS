// Windows 릴리스 빌드에서 콘솔 창을 띄우지 않는다
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod keychain;
mod sidecar;

use tauri::Manager;

fn main() {
    let app = tauri::Builder::default()
        // single-instance는 반드시 가장 먼저 등록한다 — 두 번째 실행을 최대한 이른
        // 시점에 가로채야 하고, "deep-link" feature가 두 번째 인스턴스 argv의
        // wbs:// URL을 deep-link 플러그인 이벤트로 이어준다 (SOT §14.2 A-1)
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        // OAuth URL 시스템 브라우저 열기 (A-1) — 프론트가 plugin:opener|open_url을 invoke
        .plugin(tauri_plugin_opener::init())
        // 백업 파일·LocalConfig 저장 (§8.7, §5.16) + 백업 폴더 선택 (§7.14)
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            keychain::keychain_get,
            keychain::keychain_set,
            keychain::keychain_delete
        ])
        .setup(|app| {
            // 설치기 없이 도는 개발 빌드에서도 wbs:// 스킴이 동작하도록 런타임 등록.
            // 릴리스 설치본은 MSI/NSIS가 레지스트리에 등록하지만 중복 등록은 무해하다.
            #[cfg(any(windows, target_os = "linux"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                app.deep_link().register_all()?;
            }

            if tauri::is_dev() {
                // dev: tauri.conf.json의 devUrl(next dev 서버)로 창이 뜬다. 사이드카 없음
            } else {
                sidecar::spawn(app.handle())?;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Tauri 앱 초기화 실패");

    app.run(|app_handle, event| {
        // 창이 닫혀도 node 자식 프로세스가 고아로 남지 않도록 종료 시 반드시 kill
        if let tauri::RunEvent::Exit = event {
            sidecar::shutdown(app_handle);
        }
    });
}
