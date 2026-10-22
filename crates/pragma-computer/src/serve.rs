//! The helper's request loop: reads [`HelperRequest`] lines, runs them on a
//! backend, and writes [`HelperResponse`] lines.
//!
//! The backend runs on the calling thread (the process main thread in the real
//! helper, which some `AppKit` calls prefer). A separate reader thread parses
//! input so `stop` is honoured while an action is still running: it trips the
//! shared [`StopFlag`] and answers at once, and the running action fails with
//! `stopped` at its next event boundary. End of input is the shutdown signal,
//! exactly like the Bun sidecars.

use std::io::{BufRead, Write};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use pragma_constants::ComputerErrorCode;

use crate::protocol::{HelperOp, HelperRequest, HelperResponse};
use crate::{failure, ComputerBackend, ComputerResult, Context};

/// Serves requests from `input` until it closes.
pub fn serve<R, W>(backend: &mut dyn ComputerBackend, ctx: &Context, input: R, output: W)
where
    R: BufRead + Send + 'static,
    W: Write + Send + 'static,
{
    let output = Arc::new(Mutex::new(output));
    let (tx, rx) = mpsc::channel::<HelperRequest>();
    let reader_output = Arc::clone(&output);
    let stop = ctx.stop.clone();
    let reader = std::thread::spawn(move || {
        for line in input.lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<HelperRequest>(&line) {
                Ok(request) if request.op.is_immediate() => {
                    match request.op {
                        HelperOp::Stop => stop.trip(),
                        HelperOp::ClearStop => stop.clear(),
                        _ => {}
                    }
                    write(
                        &reader_output,
                        &HelperResponse::ok(request.id, serde_json::Value::Null),
                    );
                }
                Ok(request) => {
                    if tx.send(request).is_err() {
                        break;
                    }
                }
                Err(error) => {
                    let id = serde_json::from_str::<serde_json::Value>(&line)
                        .ok()
                        .and_then(|value| value.get("id").and_then(serde_json::Value::as_u64))
                        .unwrap_or(0);
                    write(
                        &reader_output,
                        &HelperResponse::err(
                            id,
                            failure(
                                ComputerErrorCode::InvalidPayload,
                                format!("invalid helper request: {error}"),
                            ),
                        ),
                    );
                }
            }
        }
    });
    for request in rx {
        let response = match run(backend, ctx, request.op) {
            Ok(value) => HelperResponse::ok(request.id, value),
            Err(error) => HelperResponse::err(request.id, error),
        };
        write(&output, &response);
    }
    let _ = reader.join();
}

fn write<W: Write>(output: &Mutex<W>, response: &HelperResponse) {
    let Ok(line) = serde_json::to_string(response) else {
        return;
    };
    if let Ok(mut output) = output.lock() {
        let _ = writeln!(output, "{line}");
        let _ = output.flush();
    }
}

/// Runs one operation on `backend`.
pub fn run(
    backend: &mut dyn ComputerBackend,
    ctx: &Context,
    op: HelperOp,
) -> ComputerResult<serde_json::Value> {
    match op {
        HelperOp::Ping | HelperOp::Stop | HelperOp::ClearStop => Ok(serde_json::Value::Null),
        HelperOp::Permissions(request) => {
            to_value(backend.permissions(request.request == Some(true)))
        }
        HelperOp::Displays => to_value(backend.displays()),
        HelperOp::Apps(request) => to_value(backend.apps(&request)),
        HelperOp::Windows(request) => to_value(backend.windows(&request)),
        HelperOp::Open(request) => to_value(backend.open(ctx, &request)),
        HelperOp::Focus(request) => to_value(backend.focus(ctx, &request)),
        HelperOp::Inspect(request) => to_value(backend.inspect(&request)),
        HelperOp::Screenshot(request) => to_value(backend.screenshot(ctx, &request)),
        HelperOp::Resolve(request) => to_value(backend.resolve(&request)),
        HelperOp::Click(request) => acting(ctx, || backend.click(ctx, &request)),
        HelperOp::Type(request) => acting(ctx, || backend.type_text(ctx, &request)),
        HelperOp::Key(request) => acting(ctx, || backend.key(ctx, &request)),
        HelperOp::Scroll(request) => acting(ctx, || backend.scroll(ctx, &request)),
        HelperOp::Move(request) => acting(ctx, || backend.move_pointer(ctx, &request)),
        HelperOp::Drag(request) => acting(ctx, || backend.drag(ctx, &request)),
        HelperOp::Idle => Ok(serde_json::json!({ "seconds": backend.seconds_since_user_input() })),
    }
}

/// Refuses an action outright while the stop is latched, before any event.
fn acting<T: serde::Serialize>(
    ctx: &Context,
    action: impl FnOnce() -> ComputerResult<T>,
) -> ComputerResult<serde_json::Value> {
    ctx.stop.check()?;
    to_value(action())
}

fn to_value<T: serde::Serialize>(result: ComputerResult<T>) -> ComputerResult<serde_json::Value> {
    let value = result?;
    serde_json::to_value(value)
        .map_err(|error| failure(ComputerErrorCode::Internal, error.to_string()))
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;
    use crate::fake::FakeBackend;
    use crate::StopFlag;

    #[derive(Clone, Default)]
    struct Sink(Arc<Mutex<Vec<u8>>>);

    impl Write for Sink {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn responses(input: &str) -> Vec<HelperResponse> {
        let sink = Sink::default();
        let ctx = Context {
            stop: StopFlag::default(),
            screenshots_dir: std::env::temp_dir(),
        };
        let mut backend = FakeBackend::default();
        serve(
            &mut backend,
            &ctx,
            Cursor::new(input.to_string()),
            sink.clone(),
        );
        let bytes = sink.0.lock().unwrap().clone();
        String::from_utf8(bytes)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    #[test]
    fn serves_requests_and_reports_bad_lines() {
        let out = responses(
            "{\"id\":1,\"op\":\"apps\"}\n{\"id\":2,\"op\":\"nope\"}\n{\"id\":3,\"op\":\"inspect\",\"app\":\"TextEdit\"}\n",
        );
        let ok = out.iter().find(|r| r.id == 1).unwrap();
        assert!(ok.ok);
        assert_eq!(ok.result.as_ref().unwrap()[0]["name"], "TextEdit");
        let bad = out.iter().find(|r| r.id == 2).unwrap();
        assert_eq!(
            bad.error.as_ref().unwrap().code,
            ComputerErrorCode::InvalidPayload
        );
        let snap = out.iter().find(|r| r.id == 3).unwrap();
        assert!(snap.ok, "{snap:?}");
    }

    #[test]
    fn a_latched_stop_refuses_actions() {
        let out =
            responses("{\"id\":1,\"op\":\"stop\"}\n{\"id\":2,\"op\":\"click\",\"x\":1,\"y\":1}\n");
        let click = out.iter().find(|r| r.id == 2).unwrap();
        // The reader trips the latch before it forwards the next line, so the
        // click always sees it.
        assert!(out.iter().any(|r| r.id == 1 && r.ok));
        assert_eq!(
            click.error.as_ref().unwrap().code,
            ComputerErrorCode::Stopped
        );
    }
}
