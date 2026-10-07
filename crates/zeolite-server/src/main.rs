//! Thin entrypoint: all logic lives in the library so the tests can
//! exercise it. See `zeolite_server` docs for the architecture.

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
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
