//! Supervision of the `pragma-computer` helper process.
//!
//! The helper owns every native call; this side owns its lifetime. It is
//! started on first use, spoken to in NDJSON over its standard streams
//! (`pragma_computer::protocol`), and restarted with backoff when it dies. A
//! crash fails only the in-flight request, as `helperUnavailable` with
//! `retryable: true`. Closing its stdin — which happens when this server exits
//! — is what tells it to exit, exactly like the Bun sidecars.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pragma_computer::protocol::{HelperHello, HelperOp, HelperRequest, HelperResponse};
use pragma_computer::ComputerResult;
use pragma_constants::{ComputerErrorCode, ComputerHelperState, ComputerHelperStatus, CONSTANTS};
use pragma_core::computer::failure;

/// Something that runs helper operations. The real one is a process; tests
/// use an in-process fake backend.
pub trait Helper: Send + Sync {
    /// Runs one operation, waiting at most `timeout`.
    fn call(&self, op: HelperOp, timeout: Duration) -> ComputerResult<serde_json::Value>;
    /// Latches (or clears) the helper's emergency stop without queueing
    /// behind a running action.
    fn set_stopped(&self, stopped: bool);
    /// The helper's health.
    fn status(&self) -> ComputerHelperStatus;
}

/// Called whenever the helper's state changes, to publish `helperState`.
pub type StatusListener = Arc<dyn Fn(ComputerHelperStatus) + Send + Sync>;

struct Running {
    child: Child,
    stdin: ChildStdin,
}

struct Inner {
    running: Option<Running>,
    status: ComputerHelperStatus,
    /// Consecutive starts that ended in a crash; reset by a successful call.
    crashes: usize,
}

/// The supervised helper process.
pub struct ProcessHelper {
    inner: Mutex<Inner>,
    pending: Arc<Mutex<HashMap<u64, Sender<HelperResponse>>>>,
    next_id: AtomicU64,
    screenshots_dir: PathBuf,
    listener: StatusListener,
}

fn status(state: ComputerHelperState, message: Option<String>) -> ComputerHelperStatus {
    ComputerHelperStatus {
        state,
        pid: None,
        message,
        permissions: None,
    }
}

fn unavailable(message: impl Into<String>) -> pragma_constants::ComputerFailure {
    failure(ComputerErrorCode::HelperUnavailable, message)
}

/// Where the helper binary lives: `PRAGMA_COMPUTER_HELPER` when set (tests,
/// local experiments), else beside this server executable, where both a dev
/// `cargo build` and the packaged app put it. When the macOS helper app
/// (`<macHelperAppName>.app`) sits there too, its executable wins: macOS
/// grants Accessibility and Screen Recording to an app bundle, while System
/// Settings refuses a bare ad hoc binary. Only macOS builds stage that bundle.
fn helper_path() -> PathBuf {
    if let Some(path) = std::env::var_os("PRAGMA_COMPUTER_HELPER") {
        return PathBuf::from(path);
    }
    let name = crate::sidecar::executable_name(&CONSTANTS.computer.helper_name);
    let bare = crate::sidecar::sidecar_executable(&name);
    let bundled = bare.parent().map(|dir| {
        dir.join(format!("{}.app", CONSTANTS.computer.mac_helper_app_name))
            .join("Contents")
            .join("MacOS")
            .join(&name)
    });
    match bundled {
        Some(path) if path.is_file() => path,
        _ => bare,
    }
}

impl ProcessHelper {
    /// A helper that is not started until its first call.
    pub fn new(screenshots_dir: PathBuf, listener: StatusListener) -> Self {
        Self {
            inner: Mutex::new(Inner {
                running: None,
                status: status(ComputerHelperState::Stopped, None),
                crashes: 0,
            }),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(1),
            screenshots_dir,
            listener,
        }
    }

    fn set_status(&self, inner: &mut Inner, next: ComputerHelperStatus) {
        if inner.status != next {
            inner.status = next.clone();
            (self.listener)(next);
        }
    }

    /// Starts the helper when it is not running, honouring the restart backoff.
    fn ensure_running(&self, inner: &mut Inner) -> ComputerResult<()> {
        if let Some(running) = inner.running.as_mut() {
            if let Ok(None) = running.child.try_wait() {
                return Ok(());
            }
            inner.running = None;
            inner.crashes += 1;
        }
        let backoff = &CONSTANTS.computer.helper_restart_backoff_ms;
        if inner.crashes > backoff.len() {
            let message = "the computer-use helper keeps crashing".to_string();
            self.set_status(
                inner,
                status(ComputerHelperState::Unavailable, Some(message.clone())),
            );
            return Err(unavailable(message));
        }
        if inner.crashes > 0 {
            self.set_status(inner, status(ComputerHelperState::Restarting, None));
            std::thread::sleep(Duration::from_millis(backoff[inner.crashes - 1]));
        } else {
            self.set_status(inner, status(ComputerHelperState::Starting, None));
        }
        let running = self.spawn().inspect_err(|error| {
            self.set_status(
                inner,
                status(
                    ComputerHelperState::Unavailable,
                    Some(error.message.clone()),
                ),
            );
        })?;
        let mut ready = status(ComputerHelperState::Ready, None);
        ready.pid = Some(u64::from(running.child.id()));
        inner.running = Some(running);
        self.set_status(inner, ready);
        Ok(())
    }

    fn spawn(&self) -> ComputerResult<Running> {
        let path = helper_path();
        let _ = pragma_platform::perms::create_private_dir(&self.screenshots_dir);
        let mut child = pragma_platform::process::command(&path)
            .arg("--screenshots-dir")
            .arg(&self.screenshots_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| unavailable(format!("could not start {}: {error}", path.display())))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| unavailable("helper stdin unavailable"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| unavailable("helper stdout unavailable"))?;
        let mut lines = BufReader::new(stdout).lines();
        let hello = lines
            .next()
            .and_then(Result::ok)
            .and_then(|line| serde_json::from_str::<HelperHello>(&line).ok())
            .filter(|hello| hello.ready);
        if hello.is_none() {
            let _ = child.kill();
            return Err(unavailable("the computer-use helper did not start"));
        }
        let pending = Arc::clone(&self.pending);
        std::thread::spawn(move || {
            for line in lines {
                let Ok(line) = line else { break };
                let Ok(response) = serde_json::from_str::<HelperResponse>(&line) else {
                    continue;
                };
                let waiter = pending
                    .lock()
                    .ok()
                    .and_then(|mut pending| pending.remove(&response.id));
                if let Some(waiter) = waiter {
                    let _ = waiter.send(response);
                }
            }
            // The helper is gone: fail everything still waiting on it.
            if let Ok(mut pending) = pending.lock() {
                for (id, waiter) in pending.drain() {
                    let _ = waiter.send(HelperResponse::err(
                        id,
                        unavailable("the computer-use helper exited"),
                    ));
                }
            }
        });
        Ok(Running { child, stdin })
    }

    fn send(inner: &mut Inner, request: &HelperRequest) -> ComputerResult<()> {
        let line = serde_json::to_string(request)
            .map_err(|error| failure(ComputerErrorCode::Internal, error.to_string()))?;
        let running = inner
            .running
            .as_mut()
            .ok_or_else(|| unavailable("the computer-use helper is not running"))?;
        writeln!(running.stdin, "{line}")
            .and_then(|()| running.stdin.flush())
            .map_err(|error| unavailable(format!("write to helper: {error}")))
    }
}

impl Helper for ProcessHelper {
    fn call(&self, op: HelperOp, timeout: Duration) -> ComputerResult<serde_json::Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| unavailable("helper lock poisoned"))?;
            self.ensure_running(&mut inner)?;
            if let Ok(mut pending) = self.pending.lock() {
                pending.insert(id, tx);
            }
            if let Err(error) = Self::send(&mut inner, &HelperRequest { id, op }) {
                if let Ok(mut pending) = self.pending.lock() {
                    pending.remove(&id);
                }
                return Err(error);
            }
        }
        let Ok(response) = rx.recv_timeout(timeout) else {
            if let Ok(mut pending) = self.pending.lock() {
                pending.remove(&id);
            }
            // A helper that does not answer is wedged in a native call;
            // restarting it is the only way to get the next call through.
            if let Ok(mut inner) = self.inner.lock() {
                if let Some(mut running) = inner.running.take() {
                    let _ = running.child.kill();
                    let _ = running.child.wait();
                }
            }
            return Err(failure(
                ComputerErrorCode::Timeout,
                "the computer-use helper did not answer in time",
            ));
        };
        if response.ok {
            if let Ok(mut inner) = self.inner.lock() {
                inner.crashes = 0;
            }
            Ok(response.result.unwrap_or(serde_json::Value::Null))
        } else {
            Err(response
                .error
                .unwrap_or_else(|| failure(ComputerErrorCode::Internal, "helper failed")))
        }
    }

    fn set_stopped(&self, stopped: bool) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        // Nothing to stop in a helper that is not running; a fresh one starts
        // unlatched and the service refuses actions while stopped anyway.
        if inner.running.is_none() {
            return;
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let op = if stopped {
            HelperOp::Stop
        } else {
            HelperOp::ClearStop
        };
        let _ = Self::send(&mut inner, &HelperRequest { id, op });
    }

    fn status(&self) -> ComputerHelperStatus {
        self.inner.lock().map_or_else(
            |_| status(ComputerHelperState::Unavailable, None),
            |inner| inner.status.clone(),
        )
    }
}

#[cfg(test)]
/// Runs a backend in this process, for tests: the same `serve::run` dispatch
/// the helper uses, without a child process.
pub struct InProcessHelper {
    backend: Mutex<Box<dyn pragma_computer::ComputerBackend + Send>>,
    ctx: pragma_computer::Context,
}

#[cfg(test)]
impl InProcessHelper {
    /// Wraps `backend`, writing screenshots under `screenshots_dir`.
    pub fn new(
        backend: Box<dyn pragma_computer::ComputerBackend + Send>,
        screenshots_dir: PathBuf,
    ) -> Self {
        Self {
            backend: Mutex::new(backend),
            ctx: pragma_computer::Context {
                stop: pragma_computer::StopFlag::default(),
                screenshots_dir,
            },
        }
    }
}

#[cfg(test)]
impl Helper for InProcessHelper {
    fn call(&self, op: HelperOp, _timeout: Duration) -> ComputerResult<serde_json::Value> {
        let mut backend = self
            .backend
            .lock()
            .map_err(|_| unavailable("backend lock poisoned"))?;
        pragma_computer::serve::run(backend.as_mut(), &self.ctx, op)
    }

    fn set_stopped(&self, stopped: bool) {
        if stopped {
            self.ctx.stop.trip();
        } else {
            self.ctx.stop.clear();
        }
    }

    fn status(&self) -> ComputerHelperStatus {
        status(ComputerHelperState::Ready, None)
    }
}
