//! Thin entrypoint: all logic lives in the library so the tests can
//! exercise it. See `zeolite_server` docs for the architecture.

use std::io::Write;
use std::sync::mpsc::{self, SyncSender, TrySendError};

/* Logs must never stall serving. tracing_subscriber::fmt() writes
 * each event with a blocking write on the caller thread, and on the
 * async runtime that thread is a tokio worker. A stdout consumer that
 * stops draining (a harness spawning the server with piped stdio it
 * never reads, a paused container log driver) fills the OS pipe and
 * wedges the whole server: in the reproduction every request, static
 * files included, froze once ~400 wisp upgrades had logged. Each event
 * now goes through a bounded channel to one drain thread. A full
 * buffer DROPS the event: a lost log line is honest, a blocked
 * runtime worker is not. */
struct NonBlockingWriter {
    tx: SyncSender<Vec<u8>>,
}

impl NonBlockingWriter {
    fn new() -> (Self, std::thread::JoinHandle<()>) {
        // 1024 events of head room: generous for normal traffic,
        // bounded so a stalled drain thread cannot grow memory.
        let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(1024);
        let handle = std::thread::Builder::new()
            .name("log-drain".to_owned())
            .spawn(move || {
                // This thread owns the blocking stdout writes. It is
                // outside the async runtime, so a slow consumer can
                // only ever stall itself, never request serving.
                let mut out = std::io::stdout().lock();
                for chunk in rx {
                    let _ = out.write_all(&chunk);
                }
                let _ = out.flush();
            })
            .expect("spawn log drain thread");
        (Self { tx }, handle)
    }
}

impl Write for NonBlockingWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        match self.tx.try_send(buf.to_vec()) {
            Ok(()) => Ok(buf.len()),
            // Full buffer or dead drain thread: drop the event.
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => Ok(buf.len()),
        }
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for NonBlockingWriter {
    type Writer = NonBlockingWriter;
    fn make_writer(&'a self) -> Self::Writer {
        NonBlockingWriter {
            tx: self.tx.clone(),
        }
    }
}

#[tokio::main]
async fn main() {
    let (log_writer, _log_drain) = NonBlockingWriter::new();
    tracing_subscriber::fmt()
        .with_writer(log_writer)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "zeolite_server=info,tower_http=info".into()),
        )
        .init();

    // Fail closed: a half-set or malformed auth configuration must
    // never turn into an open server that only looks configured.
    // Config layering: defaults < KDL file (ZL_CONFIG / --config)
    // < environment < CLI flags. The file is parsed before the env
    // overlay so the environment still wins over it; a missing or
    // malformed file refuses to start instead of running defaults.
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let mut cfg = match config_path(&argv) {
        Some(path) => {
            let text = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| abort(&format!("config `{path}`: {e}")));
            let file = zeolite_server::Config::from_kdl(&text)
                .unwrap_or_else(|e| abort(&format!("config `{path}`: {e}")));
            zeolite_server::Config::overlay_env(file).unwrap_or_else(|e| abort(&e))
        }
        None => zeolite_server::Config::from_env().unwrap_or_else(|e| abort(&e)),
    };
    // --port, --static, --bind and --config are parsed here (file,
    // env and defaults apply below them; Config is validated before
    // the flags, and a bad value must fail loudly). Both flags were
    // once silently ignored: every compat fixture server bound the
    // 6002 default and died on bind with AddrInUse against the base
    // server, and three CI runs blamed the runner for squatting the
    // fixed ports before anyone checked whether the flag worked.
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--port" => {
                let value = args.next().expect("--port requires a value");
                cfg.port = value.parse().expect("invalid --port value");
            }
            "--static" => {
                cfg.static_dir = args.next().expect("--static requires a value");
            }
            "--bind" => {
                cfg.bind = args.next().expect("--bind requires a value");
            }
            "--config" => {
                // Consumed by config_path before this loop; skip here.
                let _ = args.next().expect("--config requires a value");
            }
            other => {
                eprintln!("unexpected argument: {other}");
                std::process::exit(2);
            }
        }
    }
    let port = cfg.port;
    let bind = cfg.bind.clone();
    let app = zeolite_server::build_app(zeolite_server::Shared::new(cfg));

    // Loopback by default (Config::bind): the relay is an open proxy
    // to the public internet, so binding every interface is the
    // operator's explicit choice (ZL_BIND / --bind).
    let addr = format!("{}:{}", bind, port);
    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind");
    // Log the bound address, not the requested port: --port 0 lets the
    // kernel pick a free port on a shared host, and the compat suite
    // parses this line to learn the real port.
    let local = listener.local_addr().expect("local_addr");
    let version = env!("CARGO_PKG_VERSION");
    tracing::info!("zeolite-server {} listening on {}", version, local);
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(zeolite_server::shutdown_signal())
    .await
    .expect("serve");
}

/// Locate the KDL config file, if any. `--config <path>` beats the
/// ZL_CONFIG environment variable; an empty ZL_CONFIG means none.
fn config_path(argv: &[String]) -> Option<String> {
    if let Some(i) = argv.iter().position(|a| a == "--config") {
        let value = argv.get(i + 1).cloned();
        return Some(value.unwrap_or_else(|| {
            eprintln!("--config requires a value");
            std::process::exit(2);
        }));
    }
    std::env::var("ZL_CONFIG").ok().filter(|v| !v.is_empty())
}

/// A configuration error is fatal: refuse to start rather than run
/// with settings that only look right.
fn abort(msg: &str) -> ! {
    eprintln!("zeolite-server: {msg}");
    std::process::exit(2);
}

#[cfg(test)]
mod log_writer_tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn writer_from(tx: SyncSender<Vec<u8>>) -> NonBlockingWriter {
        NonBlockingWriter { tx }
    }

    #[test]
    fn a_full_buffer_drops_the_event_instead_of_blocking() {
        // Nobody drains the channel; after the buffer fills every
        // write must still return immediately. A stall here would
        // stall a runtime worker (the crawl wedge).
        let (tx, _rx) = mpsc::sync_channel::<Vec<u8>>(4);
        let mut w = writer_from(tx);
        let t0 = Instant::now();
        for _ in 0..2000 {
            assert_eq!(w.write(&[b'x'; 256]).unwrap(), 256);
        }
        assert!(
            t0.elapsed() < Duration::from_millis(500),
            "log writes must never block on a full pipe",
        );
    }

    #[test]
    fn the_drain_thread_preserves_content_and_fifo_order() {
        let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(16);
        let sink = std::thread::spawn(move || {
            let mut v = Vec::new();
            for chunk in rx {
                v.extend_from_slice(&chunk);
            }
            v
        });
        let mut w = writer_from(tx);
        let nl = char::from(10);
        for i in 0..5 {
            let line = format!("line-{i}{nl}");
            w.write_all(line.as_bytes()).unwrap();
        }
        drop(w);
        let text = String::from_utf8(sink.join().unwrap()).unwrap();
        let positions: Vec<usize> = (0..5)
            .map(|i| {
                let want = format!("line-{i}{nl}");
                text.find(&want).unwrap_or_else(|| {
                    panic!("missing {want:?} in drained output");
                })
            })
            .collect();
        let mut sorted = positions.clone();
        sorted.sort_unstable();
        assert_eq!(positions, sorted, "drain must be FIFO");
    }
}
