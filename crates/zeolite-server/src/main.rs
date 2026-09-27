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
    tracing::info!("zeolite-server 1.6 Hydride listening on {}", addr);
    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind");
    axum::serve(listener, app)
        .with_graceful_shutdown(zeolite_server::shutdown_signal())
        .await
        .expect("serve");
}
