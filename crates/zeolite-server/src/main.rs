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
    let mut cfg = match zeolite_server::Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("zeolite-server: {e}");
            std::process::exit(2);
        }
    };
    // --port, --static and --bind are parsed here (env and defaults
    // apply below them; Config is validated env-only by design, and a
    // bad value must fail loudly). Both flags were once silently
    // ignored: every compat fixture server bound the 6002 default and
    // died on bind with AddrInUse against the base server, and three
    // CI runs blamed the runner for squatting the fixed ports before
    // anyone checked whether the flag worked.
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
