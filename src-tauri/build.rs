fn main() {
    // 앱 자체 명령(keychain_*)의 `allow-*`/`deny-*` 권한을 자동 생성한다.
    // 이 선언이 없으면 권한이 만들어지지 않고, Tauri는 앱 명령을 로컬 출처(dev 서버)에서만
    // 기본 허용한다. 프로덕션은 사이드카 http://127.0.0.1:{port}가 원격 출처라
    // capabilities/default.json에 명시된 권한 없이는 "not allowed by ACL"로 거부된다 (SOT §14.1).
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "keychain_get",
                "keychain_set",
                "keychain_delete",
            ]),
        ),
    )
    .expect("tauri-build 실패");
}
