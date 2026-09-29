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

    let mut cfg = zeolite_server::Config::from_env();
    // --port and --static are parsed here (Config is env-only by
    // design, and a bad value must fail loudly). Both flags were
    // silently ignored until now: every compat fixture server bound
    // the 6002 default and died on bind with AddrInUse against the
    // base server, and three CI runs blamed the runner for squatting
    // the fixed ports before anyone checked whether the flag worked.
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
            other => {
                eprintln!("unexpected argument: {other}");
                std::process::exit(2);
            }
        }
    }
    let port = cfg.port;
    let app = zeolite_server::build_app(zeolite_server::Shared::new(cfg));

    let addr = format!("0.0.0.0:{}", port);
    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind");
    // Log the bound address, not the requested port: --port 0 lets the
    // kernel pick a free port on a shared host, and the compat suite
    // parses this line to learn the real port.
    let local = listener.local_addr().expect("local_addr");
    let version = env!("CARGO_PKG_VERSION");
    tracing::info!("zeolite-server {} listening on {}", version, local);
    axum::serve(listener, app)
        .with_graceful_shutdown(zeolite_server::shutdown_signal())
        .await
        .expect("serve");
}