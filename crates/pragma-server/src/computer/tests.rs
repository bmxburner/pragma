//! The `computer` RPC end to end against the in-process fake backend:
//! enablement, policy and approvals, leases, sensitive controls, the stop,
//! and the activity every caller sees.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use pragma_computer::fake::FakeBackend;
use pragma_constants::{ComputerActivityType, ComputerErrorCode};
use serde_json::{json, Value};

use super::activity::ActivityBus;
use super::helper::InProcessHelper;
use super::{ComputerHost, ComputerService};

struct Host {
    desktop: AtomicBool,
}

impl ComputerHost for Host {
    fn desktop_connected(&self) -> bool {
        self.desktop.load(Ordering::SeqCst)
    }
    fn agent_for_tab(&self, _tab_id: &str) -> Option<String> {
        Some("claude-code".to_string())
    }
}

struct World {
    service: Arc<ComputerService>,
    host: Host,
    activity: Arc<ActivityBus>,
    log: Arc<std::sync::Mutex<Vec<String>>>,
    _home: tempfile::TempDir,
    _server: tempfile::TempDir,
}

fn world(config: Option<Value>) -> World {
    let home = tempfile::tempdir().unwrap();
    if let Some(config) = config {
        std::fs::create_dir_all(home.path().join(".pragma")).unwrap();
        std::fs::write(home.path().join(".pragma/config.json"), config.to_string()).unwrap();
    }
    let server = tempfile::tempdir().unwrap();
    let backend = FakeBackend::default();
    let log = Arc::clone(&backend.log);
    let helper = Arc::new(InProcessHelper::new(
        Box::new(backend),
        server.path().join("shots"),
    ));
    let activity = Arc::new(ActivityBus::default());
    let service = ComputerService::with_helper(
        server.path(),
        helper,
        Arc::clone(&activity),
        Some(home.path().to_path_buf()),
    );
    World {
        service,
        host: Host {
            desktop: AtomicBool::new(true),
        },
        activity,
        log,
        _home: home,
        _server: server,
    }
}

fn enabled_allowing_agents() -> Value {
    json!({ "computerUse": { "enabled": true, "access": { "agents": { "*": "allow" }, "sensitive": "allow" } } })
}

fn agent(tab: &str) -> Value {
    json!({ "kind": "agentTab", "tabId": tab, "worktreeId": "wt-1" })
}

fn user() -> Value {
    json!({ "kind": "user" })
}

impl World {
    fn call(
        &self,
        caller: &Value,
        mut request: Value,
    ) -> Result<Value, pragma_constants::ComputerFailure> {
        request["caller"] = caller.clone();
        self.service.handle_rpc(&self.host, request)
    }

    fn code(&self, caller: &Value, request: Value) -> ComputerErrorCode {
        self.call(caller, request).unwrap_err().code
    }

    fn kinds(&self) -> Vec<ComputerActivityType> {
        self.activity
            .history()
            .into_iter()
            .map(|event| event.type_)
            .collect()
    }

    fn element(&self, caller: &Value, label: &str) -> String {
        let snapshot = self
            .call(caller, json!({ "op": "inspect", "app": "TextEdit" }))
            .unwrap();
        snapshot["elements"]
            .as_array()
            .unwrap()
            .iter()
            .find(|element| element["label"] == label)
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string()
    }
}

#[test]
fn computer_use_is_off_until_enabled() {
    let w = world(None);
    assert_eq!(
        w.code(&agent("t1"), json!({ "op": "apps" })),
        ComputerErrorCode::Disabled
    );
    // Diagnostics still work while it is off.
    assert!(w.call(&agent("t1"), json!({ "op": "status" })).is_ok());
    assert!(w.call(&agent("t1"), json!({ "op": "permissions" })).is_ok());
}

#[test]
fn an_allowed_agent_clicks_by_element_and_everyone_sees_it() {
    let w = world(Some(enabled_allowing_agents()));
    let save = w.element(&agent("t1"), "Save");
    let result = w
        .call(&agent("t1"), json!({ "op": "click", "element": save }))
        .unwrap();
    assert_eq!(result["method"], "ax");
    assert_eq!(result["physicalCursor"], false);
    assert_eq!(w.log.lock().unwrap().as_slice(), ["click Save"]);
    let kinds = w.kinds();
    assert!(kinds.contains(&ComputerActivityType::SessionStarted));
    assert!(kinds.contains(&ComputerActivityType::ActionStarted));
    assert!(kinds.contains(&ComputerActivityType::ActionCompleted));
    let started = w
        .activity
        .history()
        .into_iter()
        .find(|event| event.type_ == ComputerActivityType::ActionStarted)
        .unwrap();
    assert_eq!(started.description.as_deref(), Some("Click “Save”"));
    assert!(
        started.pointer.is_some(),
        "the overlay cursor gets a destination"
    );
    let status = w.call(&agent("t1"), json!({ "op": "status" })).unwrap();
    assert_eq!(status["sessions"][0]["leases"][0]["appName"], "TextEdit");
    assert_eq!(status["sessions"][0]["owner"]["agentId"], "claude-code");
}

#[test]
fn typed_text_never_reaches_activity() {
    let w = world(Some(enabled_allowing_agents()));
    w.call(
        &agent("t1"),
        json!({ "op": "type", "app": "TextEdit", "text": "hunter2" }),
    )
    .unwrap();
    let history = serde_json::to_string(&w.activity.history()).unwrap();
    assert!(!history.contains("hunter2"));
    assert!(history.contains("•••• (7 chars)"));
}

#[test]
fn a_second_agent_cannot_take_a_leased_app() {
    let w = world(Some(enabled_allowing_agents()));
    w.call(
        &agent("t1"),
        json!({ "op": "key", "app": "TextEdit", "chords": ["mod+s"] }),
    )
    .unwrap();
    let busy = w
        .call(
            &agent("t2"),
            json!({ "op": "key", "app": "TextEdit", "chords": ["mod+s"] }),
        )
        .unwrap_err();
    assert_eq!(busy.code, ComputerErrorCode::AppBusy);
    assert!(busy.retryable);
    assert!(w.kinds().contains(&ComputerActivityType::LeaseDenied));
    // A different app is fine, and ending the first session frees TextEdit.
    w.call(
        &agent("t2"),
        json!({ "op": "key", "app": "Safari", "chords": ["mod+l"] }),
    )
    .unwrap();
    let ended = w.call(&agent("t1"), json!({ "op": "end" })).unwrap();
    assert_eq!(ended["ended"], true);
    w.call(
        &agent("t2"),
        json!({ "op": "key", "app": "TextEdit", "chords": ["mod+s"] }),
    )
    .unwrap();
}

#[test]
fn acting_needs_the_desktop_but_reading_does_not() {
    let w = world(Some(enabled_allowing_agents()));
    w.host.desktop.store(false, Ordering::SeqCst);
    assert!(w
        .call(&agent("t1"), json!({ "op": "inspect", "app": "TextEdit" }))
        .is_ok());
    assert_eq!(
        w.code(&agent("t1"), json!({ "op": "click", "x": 150, "y": 130 })),
        ComputerErrorCode::IndicatorUnavailable
    );
}

#[test]
fn ask_waits_for_the_desktop_user_and_a_session_grant_sticks() {
    let w = Arc::new(world(Some(
        json!({ "computerUse": { "enabled": true, "access": { "sensitive": "allow" } } }),
    )));
    let caller = agent("t1");
    let asking = {
        let w = Arc::clone(&w);
        let caller = caller.clone();
        std::thread::spawn(move || {
            w.call(
                &caller,
                json!({ "op": "key", "app": "TextEdit", "chords": ["enter"] }),
            )
        })
    };
    let approval = loop {
        let status = w.call(&user(), json!({ "op": "status" })).unwrap();
        if let Some(approval) = status["approvals"]
            .as_array()
            .and_then(|a| a.first())
            .cloned()
        {
            break approval;
        }
        std::thread::yield_now();
    };
    assert_eq!(approval["caller"]["agentId"], "claude-code");
    assert_eq!(approval["sensitive"], false);
    // The agent cannot answer its own prompt.
    assert_eq!(
        w.code(
            &caller,
            json!({ "op": "approve", "approval": approval["id"], "decision": "once" })
        ),
        ComputerErrorCode::NotAuthorized
    );
    w.call(
        &user(),
        json!({ "op": "approve", "approval": approval["id"], "decision": "session" }),
    )
    .unwrap();
    asking.join().unwrap().unwrap();
    // Allowed for the session: the next call does not ask again.
    w.call(
        &caller,
        json!({ "op": "key", "app": "TextEdit", "chords": ["tab"] }),
    )
    .unwrap();
    assert_eq!(
        w.call(&user(), json!({ "op": "status" })).unwrap()["approvals"],
        json!([])
    );
}

#[test]
fn ask_without_a_desktop_is_refused_not_hung() {
    let w = world(Some(json!({ "computerUse": { "enabled": true } })));
    w.host.desktop.store(false, Ordering::SeqCst);
    assert_eq!(
        w.code(&agent("t1"), json!({ "op": "apps" })),
        ComputerErrorCode::NotAuthorized
    );
}

#[test]
fn denied_agents_are_refused() {
    let w = world(Some(
        json!({ "computerUse": { "enabled": true, "access": { "agents": { "claude-code": "deny" } } } }),
    ));
    assert_eq!(
        w.code(&agent("t1"), json!({ "op": "apps" })),
        ComputerErrorCode::NotAuthorized
    );
}

#[test]
fn sensitive_controls_need_approval_even_for_allowed_agents() {
    let w = Arc::new(world(Some(
        json!({ "computerUse": { "enabled": true, "access": { "agents": { "*": "allow" } } } }),
    )));
    let delete = w.element(&agent("t1"), "Delete");
    let clicking = {
        let w = Arc::clone(&w);
        std::thread::spawn(move || {
            w.call(&agent("t1"), json!({ "op": "click", "element": delete }))
        })
    };
    let approval = loop {
        let status = w.call(&user(), json!({ "op": "status" })).unwrap();
        if let Some(approval) = status["approvals"]
            .as_array()
            .and_then(|a| a.first())
            .cloned()
        {
            break approval;
        }
        std::thread::yield_now();
    };
    assert!(approval["reason"].as_str().unwrap().contains("Delete"));
    assert_eq!(approval["sensitive"], true);
    w.call(
        &user(),
        json!({ "op": "approve", "approval": approval["id"], "decision": "deny" }),
    )
    .unwrap();
    assert_eq!(
        clicking.join().unwrap().unwrap_err().code,
        ComputerErrorCode::Denied
    );
    assert_eq!(
        *w.log.lock().unwrap(),
        Vec::<String>::new(),
        "nothing was clicked"
    );
}

#[test]
fn the_stop_ends_everything_until_unpaused() {
    let w = world(Some(enabled_allowing_agents()));
    w.call(
        &agent("t1"),
        json!({ "op": "key", "app": "TextEdit", "chords": ["enter"] }),
    )
    .unwrap();
    assert_eq!(
        w.code(&agent("t1"), json!({ "op": "stop" })),
        ComputerErrorCode::NotAuthorized
    );
    w.call(&user(), json!({ "op": "stop" })).unwrap();
    let status = w.call(&user(), json!({ "op": "status" })).unwrap();
    assert_eq!(status["stopped"], true);
    assert_eq!(status["sessions"], json!([]));
    assert_eq!(
        w.code(
            &agent("t1"),
            json!({ "op": "key", "app": "TextEdit", "chords": ["enter"] })
        ),
        ComputerErrorCode::Stopped
    );
    w.call(&user(), json!({ "op": "unpause" })).unwrap();
    w.call(
        &agent("t1"),
        json!({ "op": "key", "app": "TextEdit", "chords": ["enter"] }),
    )
    .unwrap();
}

#[test]
fn a_paused_session_refuses_actions() {
    let w = world(Some(enabled_allowing_agents()));
    w.call(
        &agent("t1"),
        json!({ "op": "key", "app": "TextEdit", "chords": ["enter"] }),
    )
    .unwrap();
    w.call(&user(), json!({ "op": "pause" })).unwrap();
    assert_eq!(
        w.code(
            &agent("t1"),
            json!({ "op": "key", "app": "TextEdit", "chords": ["enter"] })
        ),
        ComputerErrorCode::UserTakeover
    );
    w.call(&user(), json!({ "op": "unpause" })).unwrap();
    w.call(
        &agent("t1"),
        json!({ "op": "key", "app": "TextEdit", "chords": ["enter"] }),
    )
    .unwrap();
}

#[test]
fn idle_sessions_and_closed_tabs_end() {
    let w = world(Some(enabled_allowing_agents()));
    w.call(
        &agent("t1"),
        json!({ "op": "key", "app": "TextEdit", "chords": ["enter"] }),
    )
    .unwrap();
    w.call(
        &agent("t2"),
        json!({ "op": "key", "app": "Safari", "chords": ["enter"] }),
    )
    .unwrap();
    w.service.end_tab("t2");
    assert_eq!(
        w.call(&user(), json!({ "op": "status" })).unwrap()["sessions"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    w.service.sweep_idle(super::now_ms() + 10 * 60 * 1000);
    assert_eq!(
        w.call(&user(), json!({ "op": "status" })).unwrap()["sessions"],
        json!([])
    );
}

#[test]
fn image_coordinates_map_through_a_known_screenshot() {
    let w = world(Some(enabled_allowing_agents()));
    let shot = w
        .call(
            &agent("t1"),
            json!({ "op": "screenshot", "app": "TextEdit" }),
        )
        .unwrap();
    // The fake's screenshot has origin (100,100) and scale 2.
    w.call(
        &agent("t1"),
        json!({ "op": "click", "app": "TextEdit", "imageX": 40, "imageY": 20, "screenshot": shot["id"] }),
    )
    .unwrap();
    assert_eq!(w.log.lock().unwrap().as_slice(), ["click 120,110"]);
    assert_eq!(
        w.code(
            &agent("t1"),
            json!({ "op": "click", "imageX": 1, "imageY": 1, "screenshot": "shot_nope" })
        ),
        ComputerErrorCode::SnapshotExpired
    );
}

#[test]
fn bad_payloads_are_typed() {
    let w = world(Some(enabled_allowing_agents()));
    assert_eq!(
        w.code(&agent("t1"), json!({ "op": "fly" })),
        ComputerErrorCode::InvalidPayload
    );
    assert_eq!(
        w.code(&agent("t1"), json!({ "op": "click", "bogus": 1 })),
        ComputerErrorCode::InvalidPayload
    );
}

#[test]
fn only_the_desktop_reads_session_frames() {
    let w = world(Some(enabled_allowing_agents()));
    let done = w
        .call(
            &agent("t1"),
            json!({ "op": "key", "app": "TextEdit", "chords": ["enter"] }),
        )
        .unwrap();
    let session = done["sessionId"].clone();
    assert_eq!(
        w.code(&agent("t2"), json!({ "op": "frame", "session": session })),
        ComputerErrorCode::NotAuthorized
    );
    let frame = w
        .call(&user(), json!({ "op": "frame", "session": session }))
        .unwrap();
    assert_eq!(frame["format"], "png");
}
