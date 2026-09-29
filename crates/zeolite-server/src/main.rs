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

    let cfg = zeolite_server::Config::from_env();
    let port = cfg.port;
    let app = zeolite_server::build_app(zeolite_server::Shared::new(cfg));

    let addr = format!("0.0.0.0:{}", port);
    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind");
    // Log the bound address, not the requested port: --port 0 lets the
    // kernel pick a free port (fixed ports lost the AddrInUse lottery
    // twice on hosted runners), and the compat suite parses this line
    // to learn the real port.
    let local = listener.local_addr().expect("local_addr");
    let version = env!("CARGO_PKG_VERSION");
    tracing::info!("zeolite-server {} listening on {}", version, local);
    axum::serve(listener, app)
        .with_graceful_shutdown(zeolite_server::shutdown_signal())
        .await
        .expect("serve");
}
