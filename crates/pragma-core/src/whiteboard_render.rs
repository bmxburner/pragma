//! The whiteboard SVG renderer: one V8 engine on one thread, for the process.
//!
//! Building an `Engine` re-parses and compiles the whole bundled Excalidraw
//! core, and every engine is a separate V8 isolate with its own reserved code
//! range. Building one per `view` request made each render cost a full compile
//! on every core, and a burst of requests (a scratchpad embed polling a board,
//! a whiteboard tab, the CLI) built isolates in parallel on the server's
//! per-connection threads until V8 could not reserve address space for the
//! next one and aborted the process: `Fatal process out of memory: Failed to
//! reserve virtual memory for CodeRange`. Every abort restarted the server.
//!
//! Requests are therefore queued to a single worker thread that owns the only
//! engine and reuses it for every render, so at most one isolate exists no
//! matter how many callers arrive at once.

use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Mutex, OnceLock};
use std::thread;

use excalidraw_image::argv::Args as RenderArgs;
use excalidraw_image::engine::Engine;

use crate::{CoreError, CoreResult};

/// One queued render and the channel its SVG goes back on.
struct RenderJob {
    scene: String,
    dark: bool,
    reply: Sender<CoreResult<String>>,
}

static RENDERER: OnceLock<Mutex<Sender<RenderJob>>> = OnceLock::new();

/// Renders an Excalidraw scene (as JSON) to an SVG string on the shared
/// render thread, blocking until it is done.
pub(crate) fn render_svg(scene: String, dark: bool) -> CoreResult<String> {
    let (reply, response) = mpsc::channel();
    renderer()?
        .lock()
        .map_err(|_| CoreError::Operation("whiteboard renderer lock poisoned".to_string()))?
        .send(RenderJob { scene, dark, reply })
        .map_err(|_| unavailable())?;
    response.recv().map_err(|_| unavailable())?
}

fn renderer() -> CoreResult<&'static Mutex<Sender<RenderJob>>> {
    if let Some(sender) = RENDERER.get() {
        return Ok(sender);
    }
    let (sender, jobs) = mpsc::channel();
    thread::Builder::new()
        .name("whiteboard-render".to_string())
        .spawn(move || worker(&jobs))
        .map_err(|error| CoreError::Operation(format!("start whiteboard renderer: {error}")))?;
    // A racing caller may have installed its own worker first; ours then sees
    // its sender dropped, drains nothing, and exits.
    Ok(RENDERER.get_or_init(|| Mutex::new(sender)))
}

fn worker(jobs: &Receiver<RenderJob>) {
    let runtime = match tokio::runtime::Builder::new_current_thread().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            let message = format!("whiteboard renderer runtime: {error}");
            for job in jobs {
                let _ = job.reply.send(Err(CoreError::Operation(message.clone())));
            }
            return;
        }
    };
    let mut engine: Option<Engine> = None;
    for job in jobs {
        let options = RenderArgs {
            dark: job.dark,
            ..RenderArgs::default()
        }
        .opts_json(false);
        // Not `new_cached`: on a cache miss it re-executes the current binary
        // to bake a snapshot, and the current binary here is pragma-server.
        let active = engine.get_or_insert_with(Engine::new);
        let result = runtime.block_on(active.render(&job.scene, &options));
        let result = match result {
            Ok(rendered) => Ok(rendered.svg),
            Err(error) => {
                // A failed render may leave globals or a pending promise behind;
                // start the next job from a clean engine rather than reuse it.
                engine = None;
                Err(CoreError::Operation(format!("render whiteboard: {error}")))
            }
        };
        let _ = job.reply.send(result);
    }
}

fn unavailable() -> CoreError {
    CoreError::Operation("whiteboard renderer is unavailable".to_string())
}

#[cfg(test)]
mod tests {
    use std::thread;

    use super::render_svg;

    const EMPTY_SCENE: &str = r##"{"type":"excalidraw","version":2,"source":"pragma","elements":[],"appState":{"viewBackgroundColor":"#ffffff"},"files":{}}"##;

    #[test]
    fn concurrent_renders_share_one_engine() {
        let renders: Vec<_> = (0..6)
            .map(|index| thread::spawn(move || render_svg(EMPTY_SCENE.to_string(), index % 2 == 0)))
            .collect();
        for render in renders {
            let svg = render.join().expect("render thread").expect("render");
            assert!(svg.contains("<svg"), "expected an SVG document");
        }
    }
}
