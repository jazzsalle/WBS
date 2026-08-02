//! Next.js standalone 사이드카 관리 (SOT §14.1)
//!
//! 실행 방식: Next standalone은 Node 런타임이 필요하다. 빌드 시
//! scripts/prepare-sidecar.mjs가 빌드 머신의 node 실행 파일을 `resources/node/`에,
//! standalone 산출물을 `resources/web/`에 동봉하고, 여기서 `node server.js`를
//! 자식 프로세스로 직접 띄운다. externalBin(shell 플러그인 사이드카) 방식 대신
//! 리소스 + std::process를 쓴 이유: shell 플러그인 권한을 열지 않고도
//! 포트 전달(env)·수명 관리(앱 종료 시 kill)를 셸 코드가 직접 통제하기 위해서다.

use std::net::{SocketAddr, TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

pub struct SidecarState(pub Mutex<Option<Child>>);

pub fn spawn(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    // 고정 포트 금지(§14.1): OS에 임시 포트를 요청해 랜덤 할당받는다.
    // listener를 닫고 node가 다시 바인딩하는 사이의 경합은 이론상 존재하지만,
    // OS가 임시 포트를 즉시 재사용할 확률은 무시할 수 있는 수준이다.
    let port = TcpListener::bind("127.0.0.1:0")?.local_addr()?.port();

    let resources = app.path().resource_dir()?;
    let node = resources
        .join("node")
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    let web = resources.join("web");
    let server_js = web.join("server.js");

    if !node.exists() || !server_js.exists() {
        return Err(format!(
            "사이드카 리소스 누락: {} / {} — prepare-sidecar.mjs가 실행되지 않은 빌드",
            node.display(),
            server_js.display()
        )
        .into());
    }

    let mut cmd = Command::new(&node);
    cmd.arg(&server_js)
        .current_dir(&web)
        .env("NODE_ENV", "production")
        // 외부 인터페이스 바인딩 금지 — 루프백 전용 (§14.1)
        .env("HOSTNAME", "127.0.0.1")
        .env("PORT", port.to_string())
        // 콘솔에서 실행하면 사이드카 로그가 보이도록 inherit (GUI 실행 시엔 무시됨)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: node가 별도 콘솔 창을 띄우는 것을 막는다
        cmd.creation_flags(0x0800_0000);
    }

    let child = cmd.spawn()?;
    app.manage(SidecarState(Mutex::new(Some(child))));

    // 서버가 뜨기 전에 네비게이트하면 연결 거부 화면이 남으므로, 준비를 폴링한 뒤 이동한다
    let handle = app.clone();
    std::thread::spawn(move || {
        let url = format!("http://127.0.0.1:{port}");
        if wait_ready(port, Duration::from_secs(30)) {
            if let Some(win) = handle.get_webview_window("main") {
                let _ = win.eval(&format!("window.location.replace('{url}')"));
            }
        } else {
            eprintln!("[sidecar] {url} 준비 시간 초과");
            if let Some(win) = handle.get_webview_window("main") {
                let _ = win.eval(
                    "var el=document.getElementById('status');\
                     if(el){el.textContent='앱 서버를 시작하지 못했습니다. 앱을 다시 실행해 주세요.';}",
                );
            }
        }
    });

    Ok(())
}

pub fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<SidecarState>() {
        if let Ok(mut guard) = state.0.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

fn wait_ready(port: u16, timeout: Duration) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}
