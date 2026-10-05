//! zeolite-server: the standalone Zeolite server library.
//!
//! Two jobs:
//! 1. Static-host the built engine app (SW, bootstrap, rewriter wasm).
//! 2. Upgrade `GET /wisp/` to the Wisp v2.1 protocol and relay TCP and UDP.
//!
//! The wisp protocol itself comes from this workspace's `wisp-core`
//! crate: framing, packets and the server handshake state machine are
//! reused, not reimplemented. This crate only owns the sockets, the
//! destination policy, limits, lifecycle and logging.
//!
//! Security boundary: arbitrary wisp clients may only reach destinations
//! that pass `policy::DestinationPolicy` (checked before connect AND on
//! every resolved address, to beat DNS rebinding). Loopback, private,
//! link-local, unique-local and cloud-metadata destinations are closed
//! with reason 0x48 (Blocked).

pub mod policy;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::{
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use bytes::BytesMut;
use futures::{SinkExt, StreamExt};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, UdpSocket};
use tokio::sync::{mpsc, Notify};
use wisp_core::extension::{motd_server, password_auth_server, ExtensionId};
use wisp_core::{encode_packet, CloseReason, Frame, Packet, ServerHandshake, StreamKind};
use wisp_extensions::{KeyAuth, PasswordAuth};

/// Sender into the single WebSocket (shared by the session loop and all
/// per-stream relay tasks). Bounded: relay tasks await when the client
/// is slow, which is exactly the backpressure we want.
type WsTx = mpsc::Sender<Message>;

/// Per-stream send window shared between the session loop (which grants
/// credits from client CONTINUE packets) and the TCP relay reader (which
/// spends one credit per DATA packet). `Notify` wakes a reader that ran
/// out of credits.
#[derive(Default)]
pub struct Window {
    credits: Mutex<u32>,
    notified: Notify,
}

impl Window {
    fn get(&self) -> u32 {
        *self.credits.lock().expect("window lock")
    }

    /// Grant credits (client CONTINUE) and wake any waiting reader.
    fn grant(&self, n: u32) {
        {
            let mut g = self.credits.lock().expect("window lock");
            // The protocol counts buffer slots, not a delta; the client
            // tells us how much room it has in total right now.
            *g = n;
        }
        self.notified.notify_one();
    }

    fn take(&self) -> bool {
        let mut g = self.credits.lock().expect("window lock");
        if *g == 0 {
            return false;
        }
        *g -= 1;
        true
    }
}

/// One open wisp stream: the input channel (wisp DATA -> socket), the
/// relay task handle (aborting it tears the socket down) and shared
/// bookkeeping for the idle/idle-cap sweeps.
struct StreamEntry {
    kind: StreamKind,
    input: mpsc::Sender<Vec<u8>>,
    task: tokio::task::JoinHandle<()>,
    window: Arc<Window>,
    last_active: Arc<Mutex<Instant>>,
    /// UDP byte/packet counters (TCP leaves them at zero).
    udp_bytes: Arc<AtomicU64>,
    udp_packets: Arc<AtomicU64>,
}

/// Why a CONNECT failed; maps to a wisp CloseReason for the client.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectFailure {
    Blocked,
    Dns,
    Timeout,
    Refused,
    Network,
}

impl ConnectFailure {
    pub fn reason(self) -> CloseReason {
        match self {
            Self::Blocked => CloseReason::Blocked,
            Self::Dns => CloseReason::UnreachableHost,
            Self::Timeout => CloseReason::ConnectTimedOut,
            Self::Refused => CloseReason::ConnectionRefused,
            Self::Network => CloseReason::NetworkError,
        }
    }
}

/// Resolve -> validate EVERY address -> connect, under ONE overall
/// deadline. DNS gets the full budget, then every candidate address
/// shares what remains: a host whose many addresses are all
/// unroutable used to cost N x connect_timeout (bug-scout fix), so
/// the whole connect is capped at one timeout.
pub async fn connect_validated(
    dest: &policy::DestinationPolicy,
    hostname: &str,
    port: u16,
    connect_timeout: Duration,
) -> Result<TcpStream, ConnectFailure> {
    match tokio::time::timeout(
        connect_timeout,
        connect_validated_steps(dest, hostname, port, connect_timeout),
    )
    .await
    {
        Ok(r) => r,
        Err(_) => Err(ConnectFailure::Timeout),
    }
}

/// The resolve -> validate -> connect steps; the caller owns the
/// overall deadline. The address that is actually connected is the
/// one that was validated, so a DNS rebinding answer that resolves
/// to private space is rejected, never connected.
async fn connect_validated_steps(
    dest: &policy::DestinationPolicy,
    hostname: &str,
    port: u16,
    connect_timeout: Duration,
) -> Result<TcpStream, ConnectFailure> {
    if dest.check_hostname(hostname) == policy::Verdict::Block {
        return Err(ConnectFailure::Blocked);
    }
    let addrs = match tokio::time::timeout(
        connect_timeout,
        tokio::net::lookup_host((hostname, port)),
    )
    .await
    {
        Ok(Ok(list)) => list,
        Ok(Err(_)) => return Err(ConnectFailure::Dns),
        Err(_) => return Err(ConnectFailure::Timeout),
    };
    let mut last = ConnectFailure::Dns;
    for addr in addrs {
        if dest.check_ip(&addr.ip()) == policy::Verdict::Block {
            last = ConnectFailure::Blocked;
            continue;
        }
        match tokio::time::timeout(connect_timeout, TcpStream::connect(addr)).await {
            Ok(Ok(s)) => {
                let _ = s.set_nodelay(true);
                return Ok(s);
            }
            Ok(Err(_e)) => {
                last = ConnectFailure::Refused;
            }
            Err(_) => {
                last = ConnectFailure::Timeout;
            }
        }
    }
    Err(last)
}

/// Same resolve-then-validate flow for UDP destinations.
pub async fn udp_dest_validated(
    dest: &policy::DestinationPolicy,
    hostname: &str,
    port: u16,
    connect_timeout: Duration,
) -> Result<SocketAddr, ConnectFailure> {
    if dest.check_hostname(hostname) == policy::Verdict::Block {
        return Err(ConnectFailure::Blocked);
    }
    let addrs = match tokio::time::timeout(
        connect_timeout,
        tokio::net::lookup_host((hostname, port)),
    )
    .await
    {
        Ok(Ok(list)) => list,
        Ok(Err(_)) => return Err(ConnectFailure::Dns),
        Err(_) => return Err(ConnectFailure::Timeout),
    };
    for addr in addrs {
        if dest.check_ip(&addr.ip()) == policy::Verdict::Block {
            continue;
        }
        return Ok(addr);
    }
    Err(ConnectFailure::Blocked)
}

/// Environment-driven limits and configuration. Every value is clamped
/// to a safe minimum so a typo cannot disable a limit entirely.
#[derive(Debug, Clone)]
pub struct Config {
    pub port: u16,
    pub static_dir: String,
    pub max_connections: usize,
    pub max_streams_per_conn: usize,
    pub connect_timeout: Duration,
    pub stream_idle_timeout: Duration,
    pub max_conn_duration: Duration,
    pub max_udp_datagram: usize,
    pub max_udp_bytes: u64,
    pub max_udp_packets: u64,
    pub max_ws_message: usize,
    pub motd: Option<String>,
    /// (username, password) for wisp password auth (extension 0x02).
    pub password: Option<(String, String)>,
    /// Hex-encoded Ed25519 verifying key for wisp key auth (0x03).
    pub key_hex: Option<String>,
    /// Also require auth for v1 connections (no extensions possible).
    pub auth_required_v1: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            port: 6002,
            static_dir: "app/dist".into(),
            max_connections: 64,
            max_streams_per_conn: 24,
            connect_timeout: Duration::from_secs(10),
            stream_idle_timeout: Duration::from_secs(300),
            max_conn_duration: Duration::from_secs(3600),
            max_udp_datagram: 4096,
            max_udp_bytes: 16 * 1024 * 1024,
            max_udp_packets: 50_000,
            max_ws_message: 512 * 1024,
            motd: None,
            password: None,
            key_hex: None,
            auth_required_v1: false,
        }
    }
}

fn env_num<T>(name: &str, default: T, min: T) -> T
where
    T: std::str::FromStr + PartialOrd + Copy,
{
    let v = std::env::var(name).ok().and_then(|s| s.parse().ok());
    match v {
        Some(n) if n >= min => n,
        _ => default,
    }
}

fn env_secs(name: &str, default: u64) -> Duration {
    Duration::from_secs(env_num(name, default, 1))
}

impl Config {
    pub fn from_env() -> Self {
        let d = Self::default();
        Self {
            port: env_num("PORT", d.port, 1),
            static_dir: std::env::var("ZL_STATIC").unwrap_or(d.static_dir),
            max_connections: env_num("MAX_CONNECTIONS", d.max_connections, 1),
            max_streams_per_conn: env_num("MAX_STREAMS_PER_CONNECTION", d.max_streams_per_conn, 1),
            connect_timeout: env_secs("CONNECT_TIMEOUT", d.connect_timeout.as_secs()),
            stream_idle_timeout: env_secs("STREAM_IDLE_TIMEOUT", d.stream_idle_timeout.as_secs()),
            max_conn_duration: env_secs("MAX_CONNECTION_DURATION", d.max_conn_duration.as_secs()),
            max_udp_datagram: env_num("MAX_UDP_DATAGRAM_SIZE", d.max_udp_datagram, 64),
            max_udp_bytes: env_num("MAX_UDP_BYTES", d.max_udp_bytes, 1024),
            max_udp_packets: env_num("MAX_UDP_PACKETS", d.max_udp_packets, 1),
            max_ws_message: env_num("MAX_WS_MESSAGE", d.max_ws_message, 2048),
            motd: std::env::var("ZL_MOTD").ok().filter(|s| !s.is_empty()),
            password: match (
                std::env::var("ZL_WISP_USER").ok().filter(|s| !s.is_empty()),
                std::env::var("ZL_WISP_PASSWORD")
                    .ok()
                    .filter(|s| !s.is_empty()),
            ) {
                (Some(u), Some(p)) => Some((u, p)),
                _ => None,
            },
            key_hex: std::env::var("ZL_WISP_ED25519_HEX")
                .ok()
                .filter(|s| s.len() == 64),
            auth_required_v1: std::env::var("ZL_AUTH_REQUIRED_V1")
                .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                .unwrap_or(false),
        }
    }
}

/// Shared across connections: config, the global connection counter and
/// the (immutable) password store.
pub struct Shared {
    pub cfg: Arc<Config>,
    pub dest: policy::DestinationPolicy,
    pub active: AtomicUsize,
    pub password: Option<PasswordAuth>,
}

impl Shared {
    pub fn new(cfg: Config) -> Arc<Self> {
        let password = cfg
            .password
            .as_ref()
            .map(|(u, p)| PasswordAuth::new(true, vec![(u.clone(), p.clone())]));
        Arc::new(Self {
            cfg: Arc::new(cfg),
            dest: policy::DestinationPolicy::default(),
            active: AtomicUsize::new(0),
            password,
        })
    }

    fn auth_required(&self) -> bool {
        self.password.is_some() || self.cfg.key_hex.is_some()
    }
}

/// Decrement the connection counter when the session ends, no matter
/// how it ends (upgrade failure, panic-free error paths, disconnect).
struct ConnGuard(Arc<Shared>);

impl Drop for ConnGuard {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Percent-decode a URL path just enough to catch encoded dotfiles
/// (%2E, %2e) and traversal (%2E%2E).
fn percent_decode(path: &str) -> String {
    let b = path.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = std::str::from_utf8(&b[i + 1..i + 3]).ok();
            if let Some(v) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// True when a static path must never be served: dotfiles (.git, .env),
/// Cargo manifests/lockfiles and build output directories.
pub fn sensitive_path(path: &str) -> bool {
    percent_decode(path).split('/').any(|seg| {
        seg.starts_with('.')
            || seg == "Cargo.toml"
            || seg == "Cargo.lock"
            || seg == "target"
            || seg == ".git"
    })
}

async fn deny_sensitive(req: Request, next: Next) -> Response {
    let path = req.uri().path();
    if sensitive_path(path) {
        tracing::debug!(path, "static request refused");
        return StatusCode::NOT_FOUND.into_response();
    }
    next.run(req).await
}

pub fn build_app(shared: Arc<Shared>) -> Router {
    let static_dir = shared.cfg.static_dir.clone();
    Router::new()
        .route("/wisp/", get(wisp_handler))
        .fallback_service(
            tower_http::services::ServeDir::new(static_dir).append_index_html_on_directories(true),
        )
        .layer(middleware::from_fn(deny_sensitive))
        .with_state(shared)
}

pub async fn wisp_handler(
    State(sh): State<Arc<Shared>>,
    ws: WebSocketUpgrade,
    headers: HeaderMap,
) -> Response {
    // v2 clients request the "wisp" WebSocket subprotocol; absence means v1.
    // axum 0.7 has no accessor for the requested subprotocols, so the header
    // is read directly from the upgrade request.
    let v2 = headers
        .get("sec-websocket-protocol")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ps| ps.split(',').any(|p| p.trim().eq_ignore_ascii_case("wisp")));
    // Soft limit check here; the exact count is taken when the upgrade
    // actually starts, so failed upgrades never leak a slot.
    if sh.active.load(Ordering::SeqCst) >= sh.cfg.max_connections {
        tracing::warn!("connection limit hit; refusing upgrade");
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    tracing::info!(v2, "wisp connection opened");
    let max = sh.cfg.max_ws_message;
    // Echo the client-offered wisp subprotocol on v1 handshakes
    // (#64): epoxy-tls opens wisp v1 connections with a random UUID
    // WebSocket subprotocol (ws_protocol()), and zeolite-server only
    // ever selected "wisp", so a v1 client offering anything else got
    // no Sec-WebSocket-Protocol back. Browsers tolerate the missing
    // echo, but strict WebSocket clients (the ws package, which the
    // epoxy CI gate uses) abort the handshake with "Server sent no
    // subprotocol" and epoxy's string transport can never open a
    // session against this server. RFC 6455 lets the server select
    // any one offered protocol; epoxy's own demo wisp server does the
    // same echo. axum echoes the first listed protocol the client
    // offered, so the client's own string round-trips. v2 detection
    // and the "wisp" selection are unchanged.
    let echo = headers
        .get("sec-websocket-protocol")
        .and_then(|v| v.to_str().ok())
        .and_then(|ps| {
            ps.split(',')
                .map(str::trim)
                .find(|p| !p.is_empty() && !p.eq_ignore_ascii_case("wisp"))
        });
    let upgrade = if v2 {
        ws.protocols(["wisp"])
    } else if let Some(protocol) = echo {
        ws.protocols([protocol.to_owned()])
    } else {
        ws
    };
    upgrade
        .max_message_size(max)
        .on_upgrade(move |socket| async move {
            let _guard = ConnGuard(sh.clone());
            sh.active.fetch_add(1, Ordering::SeqCst);
            wisp_session(socket, v2, sh).await;
            tracing::info!("wisp connection closed");
        })
}

/// Post-handshake authentication verdict.
#[derive(Debug)]
enum AuthState {
    NotRequired,
    Ok,
    Reject(CloseReason),
}

/// Check the client's declared extension payloads against the
/// configured authenticators. Called with the intersection of the
/// server and client extension lists. The KeyAuth instance must be
/// the SAME one whose challenge went out in the server INFO, otherwise
/// the client's signature verifies against the wrong challenge.
fn check_auth(
    shared: &Shared,
    keyauth: Option<&KeyAuth>,
    common: &[(ExtensionId, Vec<u8>)],
) -> AuthState {
    let mut need_password = shared.password.is_some();
    // The server decides what auth it requires; a client that never
    // offers the extension must not dodge it.
    let mut need_key = shared.cfg.key_hex.is_some();
    for (id, meta) in common {
        match id {
            ExtensionId::PasswordAuth => {
                need_password = false;
                if let Some(pw) = &shared.password {
                    if !pw.verify_payload(meta) {
                        return AuthState::Reject(CloseReason::AuthBadCredentials);
                    }
                }
            }
            ExtensionId::KeyAuth => {
                if let Some(ka) = keyauth {
                    need_key = false;
                    if !ka.verify_payload(meta) {
                        return AuthState::Reject(CloseReason::AuthBadSignature);
                    }
                }
                // No server-side key: the extension proves nothing;
                // keep requiring auth.
            }
            _ => {}
        }
    }
    if need_password || need_key {
        return AuthState::Reject(CloseReason::AuthRequired);
    }
    AuthState::Ok
}

/// Decode a 64-char hex Ed25519 verifying key.
fn key_from_hex(hex: &str) -> Option<ed25519_dalek::VerifyingKey> {
    let bytes = hex_decode(hex)?;
    let arr: [u8; 32] = bytes.try_into().ok()?;
    ed25519_dalek::VerifyingKey::from_bytes(&arr).ok()
}

fn hex_decode(hex: &str) -> Option<Vec<u8>> {
    if !hex.len().is_multiple_of(2) {
        return None;
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok())
        .collect()
}

/// True when the session may open streams. v1 carries no extensions,
/// so a v1 client can never authenticate.
fn auth_ok(shared: &Shared, v2: bool, verified: bool) -> AuthState {
    if !shared.auth_required() {
        return AuthState::NotRequired;
    }
    if !v2 || (!verified && shared.cfg.auth_required_v1) {
        return AuthState::Reject(CloseReason::AuthRequired);
    }
    AuthState::Ok
}

struct Session {
    shared: Arc<Shared>,
    ws_tx: WsTx,
    streams: std::collections::HashMap<u32, StreamEntry>,
    next_sweep: Instant,
}

impl Session {
    /// Reap streams whose relay task finished on its own (remote EOF,
    /// socket error, failed connect): the task already sent Close, but
    /// its dead entry kept counting toward max_streams_per_conn until
    /// the idle sweep aged it out (up to stream_idle_timeout), so a
    /// client that does not echo Close could lock the connection out
    /// with Throttled. Also stops the duplicate-Close wart: a client
    /// Close for a finished stream no longer finds an entry to echo.
    fn reap_finished(&mut self) {
        self.streams.retain(|_, e| !e.task.is_finished());
    }

    /// Fully close one stream: cancel its relay task, drop the input
    /// channel and remove the entry. No dead entries, no orphaned tasks.
    fn close_stream(&mut self, stream_id: u32) -> bool {
        match self.streams.remove(&stream_id) {
            Some(e) => {
                e.task.abort();
                tracing::info!(stream_id, kind = ?e.kind, "stream closed");
                true
            }
            None => false,
        }
    }

    /// Idle/idle-cap sweep: close streams whose relay reports no
    /// activity within the configured window and UDP streams that
    /// exceeded their byte/packet budget.
    fn sweep(&mut self) {
        self.reap_finished();
        let idle = self.shared.cfg.stream_idle_timeout;
        let mut kill: Vec<u32> = Vec::new();
        for (id, e) in &self.streams {
            let idle_for = e.last_active.lock().map(|t| t.elapsed()).unwrap_or(idle);
            if idle_for > idle {
                tracing::info!(stream_id = *id, "stream idle timeout");
                kill.push(*id);
                continue;
            }
            if e.kind == StreamKind::Udp {
                let bytes = e.udp_bytes.load(Ordering::Relaxed);
                let packets = e.udp_packets.load(Ordering::Relaxed);
                if bytes > self.shared.cfg.max_udp_bytes
                    || packets > self.shared.cfg.max_udp_packets
                {
                    tracing::warn!(stream_id = *id, bytes, packets, "udp budget exceeded");
                    kill.push(*id);
                }
            }
        }
        for id in kill {
            self.close_stream(id);
        }
    }
}

async fn wisp_session(socket: WebSocket, v2: bool, shared: Arc<Shared>) {
    let (mut ws_sink, mut ws_stream) = socket.split();
    let (ws_tx, mut ws_rx) = mpsc::channel::<Message>(128);

    // Pump relay output into the WebSocket. Bounded: if the client
    // stops reading, relay tasks park here instead of buffering.
    tokio::spawn(async move {
        while let Some(msg) = ws_rx.recv().await {
            if ws_sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    // Server extension list for INFO: UDP support is always declared;
    // MOTD/password/key auth only when configured. The KeyAuth instance
    // is created once per connection so its challenge (in the INFO
    // metadata) matches the challenge the client's signature is checked
    // against.
    let keyauth: Option<KeyAuth> = shared
        .cfg
        .key_hex
        .as_deref()
        .and_then(key_from_hex)
        .map(|vk| KeyAuth::new(true, vec![("user".into(), vk)]));
    let mut server_exts: Vec<(ExtensionId, Vec<u8>)> = vec![(ExtensionId::Udp, Vec::new())];
    if let Some(m) = &shared.cfg.motd {
        server_exts.push((ExtensionId::Motd, motd_server(m)));
    }
    if shared.password.is_some() {
        server_exts.push((ExtensionId::PasswordAuth, password_auth_server(true)));
    }
    if let Some(ka) = &keyauth {
        server_exts.push((ExtensionId::KeyAuth, ka.info_metadata()));
    }

    let mut handshake = ServerHandshake::new(server_exts);
    let mut sess = Session {
        shared: shared.clone(),
        ws_tx: ws_tx.clone(),
        streams: std::collections::HashMap::new(),
        next_sweep: Instant::now() + Duration::from_secs(5),
    };
    let deadline = Instant::now() + shared.cfg.max_conn_duration;
    let mut handshake_done = false;
    let mut auth_verified = false;

    for pkt in handshake.opening_packets(v2) {
        if send_packet(&ws_tx, &pkt).await.is_err() {
            return;
        }
    }
    if !v2 {
        // v1 has no INFO exchange; consider the handshake done and
        // honour the (default-off) v1 auth switch.
        handshake_done = true;
        match auth_ok(&shared, false, false) {
            AuthState::Reject(reason) => {
                let _ = send_packet(&ws_tx, &wisp_core::handshake_reject(reason)).await;
                tracing::warn!(?reason, "v1 connection rejected: auth required");
                return;
            }
            AuthState::NotRequired | AuthState::Ok => {}
        }
    }

    loop {
        if Instant::now() > deadline {
            tracing::info!("max connection duration reached");
            break;
        }
        // Periodic lifecycle sweep interleaved with socket reads.
        let msg = tokio::select! {
            m = ws_stream.next() => match m {
                Some(Ok(m)) => m,
                Some(Err(_)) | None => break,
            },
            _ = tokio::time::sleep_until(tokio::time::Instant::from_std(sess.next_sweep)) => {
                sess.sweep();
                sess.next_sweep = Instant::now() + Duration::from_secs(5);
                continue;
            }
        };
        let data = match msg {
            Message::Binary(b) => b,
            Message::Close(_) => break,
            _ => continue, // text/ping/pong: not part of the wisp protocol
        };
        let mut buf = BytesMut::from(&data[..]);
        let frame = match Frame::decode(&mut buf) {
            Ok(Some(f)) => f,
            _ => {
                tracing::warn!("protocol failure: invalid frame, dropping connection");
                break;
            }
        };
        // Wire layout is version-dependent: v1 CONNECT carries the
        // hostname without a length prefix. Parsing a v1 client with
        // the v2 parser misreads the first hostname byte as the
        // length prefix and drops the connection, so pick once here.
        let parsed = if v2 {
            frame.parse_packet()
        } else {
            frame.parse_packet_v1()
        };
        let pkt = match parsed {
            Ok(p) => p,
            Err(e) => {
                if !handshake_done {
                    let _ = send_packet(
                        &ws_tx,
                        &wisp_core::handshake_reject(CloseReason::InvalidInfo),
                    )
                    .await;
                }
                tracing::warn!(%e, "protocol failure: malformed packet");
                break;
            }
        };

        if !handshake_done {
            match pkt.stream_id() {
                0 => {}
                _ => {
                    tracing::warn!("protocol failure: traffic before handshake completion");
                    let _ = send_packet(
                        &ws_tx,
                        &wisp_core::handshake_reject(CloseReason::InvalidInfo),
                    )
                    .await;
                    break;
                }
            }
            match handshake.handle(&pkt) {
                Ok(Some(reply)) => {
                    // Authenticate BEFORE confirming the handshake when
                    // an auth extension is configured: no stream creation
                    // for unauthenticated clients.
                    if !auth_verified && shared.auth_required() {
                        match check_auth(&shared, keyauth.as_ref(), &handshake.common_extensions())
                        {
                            AuthState::Reject(reason) => {
                                let _ =
                                    send_packet(&ws_tx, &wisp_core::handshake_reject(reason)).await;
                                tracing::warn!(?reason, "handshake rejected: auth");
                                return;
                            }
                            AuthState::NotRequired | AuthState::Ok => {
                                auth_verified = true;
                            }
                        }
                    }
                    if send_packet(&ws_tx, &reply).await.is_err() {
                        return;
                    }
                    handshake_done = true;
                    tracing::info!(version = ?handshake.version(), "handshake complete");
                }
                Ok(None) => {
                    handshake_done = true;
                    tracing::info!(version = ?handshake.version(), "handshake complete");
                }
                Err(reason) => {
                    let _ = send_packet(&ws_tx, &wisp_core::handshake_reject(reason)).await;
                    tracing::warn!(?reason, "handshake rejected");
                    break;
                }
            }
            continue;
        }

        match pkt {
            Packet::Connect {
                stream_id,
                kind,
                port,
                hostname,
            } => {
                // Reap finished relays first: a dead entry must not
                // read as a duplicate CONNECT (stream-id reuse) or
                // count toward the stream limit.
                sess.reap_finished();
                if sess.streams.contains_key(&stream_id) {
                    tracing::warn!(stream_id, "protocol failure: duplicate CONNECT");
                    continue;
                }
                if wisp_core::validate_connect(&Packet::Connect {
                    stream_id,
                    kind,
                    port,
                    hostname: hostname.clone(),
                })
                .is_err()
                {
                    tracing::warn!(stream_id, "protocol failure: invalid CONNECT");
                    continue;
                }
                if let AuthState::Reject(reason) = auth_ok(&shared, v2, auth_verified) {
                    let _ = send_packet(&ws_tx, &Packet::Close { stream_id, reason }).await;
                    continue;
                }
                if sess.streams.len() >= shared.cfg.max_streams_per_conn {
                    tracing::warn!(stream_id, "resource limit: max streams per connection");
                    let _ = send_packet(
                        &ws_tx,
                        &Packet::Close {
                            stream_id,
                            reason: CloseReason::Throttled,
                        },
                    )
                    .await;
                    continue;
                }
                match kind {
                    StreamKind::Tcp => {
                        spawn_tcp_relay(&mut sess, stream_id, port, hostname, v2).await
                    }
                    StreamKind::Udp => spawn_udp_relay(&mut sess, stream_id, port, hostname).await,
                }
            }
            Packet::Data { stream_id, payload } => {
                if let Some(entry) = sess.streams.get(&stream_id) {
                    if entry.kind == StreamKind::Udp && payload.len() > shared.cfg.max_udp_datagram
                    {
                        // Oversized datagrams are dropped, not fatal.
                        continue;
                    }
                    // Bounded channel: a slow socket back-pressures the
                    // client's own window (TCP) or budget (UDP).
                    let _ = entry.input.send(payload).await;
                }
                // DATA for an unknown/closed stream is ignored: the
                // relay may have closed a moment ago.
            }
            Packet::Continue {
                stream_id,
                buffer_remaining,
            } => {
                if stream_id == 0 {
                    continue; // handshake window update: nothing to do
                }
                if let Some(entry) = sess.streams.get(&stream_id) {
                    if entry.kind == StreamKind::Tcp {
                        entry.window.grant(buffer_remaining);
                    }
                }
            }
            Packet::Close { stream_id, .. } => {
                if stream_id == 0 {
                    break; // whole connection
                }
                // A finished relay already sent Close; reaping here
                // stops the server from echoing a second one.
                sess.reap_finished();
                if sess.close_stream(stream_id) {
                    let _ = send_packet(
                        &ws_tx,
                        &Packet::Close {
                            stream_id,
                            reason: CloseReason::Voluntary,
                        },
                    )
                    .await;
                }
            }
            Packet::Info { stream_id, .. } => {
                tracing::warn!(stream_id, "protocol failure: INFO after handshake");
                break;
            }
        }
    }

    // Teardown: cancel every relay task and drop every entry. Aborted
    // tasks close their sockets; nothing leaks.
    for (_, e) in sess.streams.drain() {
        e.task.abort();
    }
}

/// Bug-scout fix: with the window starved the relay used to block
/// in Window::wait without draining its input channel. The session
/// loop then wedged on its bounded DATA send, and the CONTINUE that
/// grants the window could never be read: a full-duplex deadlock.
/// Drain the socket's input while waiting for credits instead.
/// Returns false when the socket write failed or the input channel
/// closed (the relay should end); true once a credit is available.
async fn drain_until_credited(
    w: &Window,
    input_rx: &mut mpsc::Receiver<Vec<u8>>,
    wr: &mut tokio::net::tcp::OwnedWriteHalf,
    la: &Mutex<Instant>,
) -> bool {
    while w.get() == 0 {
        let ok = tokio::select! {
            _ = w.notified.notified() => true,
            m = input_rx.recv() => match m {
                Some(bytes) => {
                    if wr.write_all(&bytes).await.is_err() {
                        false
                    } else {
                        if let Ok(mut t) = la.lock() {
                            *t = Instant::now();
                        }
                        true
                    }
                }
                None => false,
            },
        };
        if !ok {
            return false;
        }
    }
    true
}

/// Drain the stream's input channel while the outbound connect is
/// pending (bug-scout fix): a naive client that does not wait for
/// CONTINUE can push more DATA than the 64-slot input channel holds,
/// and the session loop's bounded send would then wedge EVERY stream
/// on this WebSocket, Close and CONTINUE included. Early DATA is
/// buffered (capped at 128 KiB; past that the stream is closed
/// Throttled, the same signal the post-connect path gives a client
/// that ignores its window) and handed back to flush once the socket
/// exists. Returns None when the input channel closed or the cap hit
/// (the caller ends the stream; the Close is already sent or the
/// client is gone).
async fn connect_with_drain<T, F>(
    ws_tx: &WsTx,
    stream_id: u32,
    input_rx: &mut mpsc::Receiver<Vec<u8>>,
    fut: F,
) -> Option<Result<(T, std::collections::VecDeque<Vec<u8>>), ConnectFailure>>
where
    F: std::future::Future<Output = Result<T, ConnectFailure>>,
{
    tokio::pin!(fut);
    let mut buffered: std::collections::VecDeque<Vec<u8>> = Default::default();
    let mut buffered_bytes = 0usize;
    loop {
        tokio::select! {
            r = &mut fut => return Some(r.map(|v| (v, buffered))),
            m = input_rx.recv() => match m {
                Some(bytes) => {
                    buffered_bytes += bytes.len();
                    if buffered_bytes > 128 * 1024 {
                        let _ = send_packet(
                            ws_tx,
                            &Packet::Close {
                                stream_id,
                                reason: CloseReason::Throttled,
                            },
                        )
                        .await;
                        return None;
                    }
                    buffered.push_back(bytes);
                }
                None => return None,
            },
        }
    }
}

/// The TCP relay loop, after a successful connect. Extracted so the
/// tests below exercise the REAL loop (bug-scout fix: they used to
/// hand-copy it, and the copy had already drifted).
#[allow(clippy::too_many_arguments)] // ponytail: one relay loop, its inputs are its inputs
async fn tcp_relay_loop(
    mut rd: tokio::net::tcp::OwnedReadHalf,
    mut wr: tokio::net::tcp::OwnedWriteHalf,
    mut input_rx: mpsc::Receiver<Vec<u8>>,
    ws_tx: &WsTx,
    stream_id: u32,
    w: &Window,
    client_flow: bool,
    la: &Mutex<Instant>,
) {
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        // Out of credits: stop reading the socket until the client
        // grants a new window with CONTINUE (real backpressure).
        // v1 clients never send CONTINUE grants, so their window
        // stays closed forever; relay unthrottled instead.
        if client_flow {
            // Bug-scout fix: the bare wait blocked the relay while
            // starved and the input channel was never drained;
            // drain_until_credited keeps the input side flowing
            // until the window is granted again.
            if !drain_until_credited(w, &mut input_rx, &mut wr, la).await {
                break;
            }
        }
        tokio::select! {
            r = rd.read(&mut buf) => match r {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = Packet::Data {
                        stream_id,
                        payload: buf[..n].to_vec(),
                    };
                    if send_packet(ws_tx, &data).await.is_err() {
                        break;
                    }
                    // Spend one credit; when the window is empty the
                    // next loop iteration waits for the client's
                    // CONTINUE (real backpressure, not a fake 128).
                    if client_flow {
                        w.take();
                    }
                    if let Ok(mut t) = la.lock() {
                        *t = Instant::now();
                    }
                }
            },
            m = input_rx.recv() => match m {
                Some(bytes) => {
                    if wr.write_all(&bytes).await.is_err() {
                        break;
                    }
                    if let Ok(mut t) = la.lock() {
                        *t = Instant::now();
                    }
                }
                None => break,
            },
        }
    }
    let _ = send_packet(
        ws_tx,
        &Packet::Close {
            stream_id,
            reason: CloseReason::Voluntary,
        },
    )
    .await;
    tracing::info!(stream_id, "tcp relay ended");
}

async fn spawn_tcp_relay(
    sess: &mut Session,
    stream_id: u32,
    port: u16,
    hostname: String,
    client_flow: bool,
) {
    let shared = sess.shared.clone();
    let ws_tx = sess.ws_tx.clone();
    let window = Arc::new(Window::default());
    let last_active = Arc::new(Mutex::new(Instant::now()));
    let (input_tx, input_rx) = mpsc::channel::<Vec<u8>>(64);

    let w = window.clone();
    let la = last_active.clone();
    let cfg = shared.cfg.clone();
    let dest = shared.dest.clone();
    let host = hostname.clone();
    let task = tokio::spawn(async move {
        let mut input_rx = input_rx;
        // Connect while draining early DATA (naive clients that do
        // not wait for CONTINUE); connect_validated carries one
        // overall deadline (DNS + every candidate address).
        let (rd, wr) = match connect_with_drain(
            &ws_tx,
            stream_id,
            &mut input_rx,
            connect_validated(&dest, &host, port, cfg.connect_timeout),
        )
        .await
        {
            // Input closed or pre-connect flood: the Close is sent,
            // nothing to relay.
            None => return,
            Some(Err(f)) => {
                tracing::info!(stream_id, host, port, failure = ?f, "connect failed");
                let _ = send_packet(
                    &ws_tx,
                    &Packet::Close {
                        stream_id,
                        reason: f.reason(),
                    },
                )
                .await;
                return;
            }
            Some(Ok((sock, prebuffer))) => {
                // wisp v2: CONTINUE is the CONNECT ack and grants the
                // initial send window. Send it only after the outbound
                // connect succeeded: on failure the client gets Close at
                // the connect phase instead of a mid-handshake Close
                // that curl reports as bogus SSL error 35.
                let _ = send_packet(
                    &ws_tx,
                    &Packet::Continue {
                        stream_id,
                        buffer_remaining: wisp_core::handshake::INITIAL_BUFFER_SIZE,
                    },
                )
                .await;
                tracing::info!(stream_id, host, port, "tcp stream opened");
                let (rd, mut wr) = sock.into_split();
                // Flush what arrived during the connect, in order.
                let mut flush_failed = false;
                for chunk in &prebuffer {
                    if wr.write_all(chunk).await.is_err() {
                        flush_failed = true;
                        break;
                    }
                }
                if flush_failed {
                    let _ = send_packet(
                        &ws_tx,
                        &Packet::Close {
                            stream_id,
                            reason: CloseReason::Voluntary,
                        },
                    )
                    .await;
                    return;
                }
                (rd, wr)
            }
        };
        tcp_relay_loop(rd, wr, input_rx, &ws_tx, stream_id, &w, client_flow, &la).await;
    });

    sess.streams.insert(
        stream_id,
        StreamEntry {
            kind: StreamKind::Tcp,
            input: input_tx,
            task,
            window,
            last_active,
            udp_bytes: Arc::new(AtomicU64::new(0)),
            udp_packets: Arc::new(AtomicU64::new(0)),
        },
    );
}

async fn spawn_udp_relay(sess: &mut Session, stream_id: u32, port: u16, hostname: String) {
    let shared = sess.shared.clone();
    let ws_tx = sess.ws_tx.clone();
    let last_active = Arc::new(Mutex::new(Instant::now()));
    let udp_bytes = Arc::new(AtomicU64::new(0));
    let udp_packets = Arc::new(AtomicU64::new(0));
    let (input_tx, input_rx) = mpsc::channel::<Vec<u8>>(64);

    let cfg = shared.cfg.clone();
    let dest = shared.dest.clone();
    let host = hostname.clone();
    let bytes_ctr = udp_bytes.clone();
    let pkt_ctr = udp_packets.clone();
    let la = last_active.clone();
    let max_dgram = cfg.max_udp_datagram;
    let max_bytes = cfg.max_udp_bytes;
    let max_packets = cfg.max_udp_packets;
    let task = tokio::spawn(async move {
        // One UDP socket per stream, connected to the validated
        // destination. Wisp v2.1 fixes the destination at CONNECT time
        // (no per-datagram destination prefix), so connect() is safe.
        // ponytail: unlike TCP this does not drain input while the
        // destination is being validated - a UDP CONNECT does no
        // outbound connect, only one policy-checked DNS lookup, so
        // the pending window is one lookup long; add a drain here if
        // a client ever manages to wedge the session on it.
        let addr = match udp_dest_validated(&dest, &host, port, cfg.connect_timeout).await {
            Ok(a) => a,
            Err(f) => {
                tracing::info!(stream_id, host, port, failure = ?f, "udp connect failed");
                let _ = send_packet(
                    &ws_tx,
                    &Packet::Close {
                        stream_id,
                        reason: f.reason(),
                    },
                )
                .await;
                return;
            }
        };
        let bind = if addr.is_ipv4() {
            "0.0.0.0:0"
        } else {
            "[::]:0"
        };
        let sock = match UdpSocket::bind(bind).await {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(stream_id, %e, "udp bind failed");
                let _ = send_packet(
                    &ws_tx,
                    &Packet::Close {
                        stream_id,
                        reason: CloseReason::NetworkError,
                    },
                )
                .await;
                return;
            }
        };
        if let Err(e) = sock.connect(addr).await {
            tracing::warn!(stream_id, %e, "udp connect failed");
            let _ = send_packet(
                &ws_tx,
                &Packet::Close {
                    stream_id,
                    reason: CloseReason::NetworkError,
                },
            )
            .await;
            return;
        }
        tracing::info!(stream_id, host, port, "udp stream opened");
        let mut input_rx = input_rx;
        let mut buf = vec![0u8; max_dgram];
        loop {
            tokio::select! {
                r = sock.recv(&mut buf) => match r {
                    // Bug-scout fix: a zero-length datagram is legal
                    // UDP and tokio surfaces it as Ok(0); it must not
                    // end the stream.
                    Ok(0) => continue,
                    Err(_) => break,
                    Ok(n) => {
                        // 1 wisp DATA payload = 1 UDP datagram, always.
                        // No CONTINUE is ever sent for UDP streams.
                        let data = Packet::Data {
                            stream_id,
                            payload: buf[..n].to_vec(),
                        };
                        if send_packet(&ws_tx, &data).await.is_err() {
                            break;
                        }
                        bytes_ctr.fetch_add(n as u64, Ordering::Relaxed);
                        pkt_ctr.fetch_add(1, Ordering::Relaxed);
                        if let Ok(mut t) = la.lock() {
                            *t = Instant::now();
                        }
                    }
                },
                m = input_rx.recv() => match m {
                    Some(dgram) => {
                        if dgram.len() > max_dgram
                            || bytes_ctr.load(Ordering::Relaxed) > max_bytes
                            || pkt_ctr.load(Ordering::Relaxed) > max_packets
                        {
                            continue;
                        }
                        if sock.send(&dgram).await.is_err() {
                            break;
                        }
                        bytes_ctr.fetch_add(dgram.len() as u64, Ordering::Relaxed);
                        pkt_ctr.fetch_add(1, Ordering::Relaxed);
                        if let Ok(mut t) = la.lock() {
                            *t = Instant::now();
                        }
                    }
                    None => break,
                },
            }
        }
        let _ = send_packet(
            &ws_tx,
            &Packet::Close {
                stream_id,
                reason: CloseReason::Voluntary,
            },
        )
        .await;
        tracing::info!(stream_id, "udp relay ended");
    });

    sess.streams.insert(
        stream_id,
        StreamEntry {
            kind: StreamKind::Udp,
            input: input_tx,
            task,
            window: Arc::new(Window::default()),
            last_active,
            udp_bytes,
            udp_packets,
        },
    );
    // UDP streams get NO CONTINUE grant (wisp v2.1: flow control does
    // not apply to UDP).
}

pub async fn send_packet(tx: &WsTx, pkt: &Packet) -> Result<(), mpsc::error::SendError<Message>> {
    let frame = encode_packet(pkt);
    let mut out = BytesMut::with_capacity(5 + frame.payload.len());
    frame.encode_into(&mut out);
    tx.send(Message::Binary(out.to_vec())).await
}

/// Graceful shutdown: SIGINT or SIGTERM stops accepting; the process
/// exits after the in-flight request drains (wisp sockets close with
/// the process; relay tasks are tokio tasks, cancelled at exit).
pub async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutdown signal received");
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::Digest;

    #[test]
    fn sensitive_paths_refused() {
        assert!(sensitive_path("/.git/config"));
        assert!(sensitive_path("/.env"));
        assert!(sensitive_path("/%2Eenv"));
        assert!(sensitive_path("/assets/Cargo.toml"));
        assert!(sensitive_path("/Cargo.lock"));
        assert!(sensitive_path("/target/debug/x"));
        assert!(!sensitive_path("/"));
        assert!(!sensitive_path("/index.html"));
        assert!(!sensitive_path("/sw.js"));
        assert!(!sensitive_path("/zlsw/app.js"));
    }

    #[test]
    fn percent_decode_catches_encoded_dotfiles() {
        assert_eq!(percent_decode("/%2Eenv"), "/.env");
        assert_eq!(percent_decode("/a%2Fb"), "/a/b");
        assert_eq!(percent_decode("/plain"), "/plain");
    }

    #[test]
    fn hex_decode_basics() {
        assert_eq!(hex_decode("00ff").unwrap(), vec![0u8, 255u8]);
        assert_eq!(hex_decode("0f").unwrap(), vec![15u8]);
        assert!(hex_decode("f").is_none()); // odd length
        assert!(hex_decode("zz").is_none());
    }

    #[test]
    fn keyauth_flow_end_to_end() {
        use ed25519_dalek::{Signature, Signer, SigningKey};
        let sk = SigningKey::generate(&mut rand::rngs::OsRng);
        let vk = ed25519_dalek::VerifyingKey::from(&sk);
        // Verifying key as hex, exactly as ZL_WISP_ED25519_HEX expects.
        let cfg = Config {
            key_hex: Some(vk.as_bytes().iter().map(|b| format!("{:02x}", b)).collect()),
            ..Default::default()
        };
        let sh = Shared::new(cfg);
        // Missing key-auth extension: AuthRequired.
        match check_auth(&sh, None, &[]) {
            AuthState::Reject(CloseReason::AuthRequired) => {}
            other => panic!("expected AuthRequired, got {other:?}"),
        }
        // Build the same KeyAuth the session would (fresh challenge).
        let ka = KeyAuth::new(true, vec![("user".into(), vk)]);
        // Client signs the challenge from the INFO metadata.
        let mut chal = ka.info_metadata();
        let challenge = chal.split_off(2); // [required][algorithms][challenge]
        let sig: Signature = sk.sign(&challenge);
        let mut payload = Vec::new();
        payload.push(4); // "user".len()
        payload.extend_from_slice(b"user");
        payload.push(0b0000_0001); // ED25519
        let mut h = sha2::Sha256::new();
        sha2::Digest::update(&mut h, vk.as_bytes());
        payload.extend_from_slice(&sha2::Digest::finalize(h));
        payload.extend_from_slice(&sig.to_bytes());
        assert!(matches!(
            check_auth(&sh, Some(&ka), &[(ExtensionId::KeyAuth, payload.clone())]),
            AuthState::Ok
        ));
        // Tampered signature: AuthBadSignature.
        let mut bad = payload;
        let last = bad.len() - 1;
        bad[last] ^= 0xFF;
        match check_auth(&sh, Some(&ka), &[(ExtensionId::KeyAuth, bad)]) {
            AuthState::Reject(CloseReason::AuthBadSignature) => {}
            other => panic!("expected AuthBadSignature, got {other:?}"),
        }
    }

    #[test]
    fn connect_failure_reasons() {
        assert_eq!(ConnectFailure::Blocked.reason(), CloseReason::Blocked);
        assert_eq!(ConnectFailure::Dns.reason(), CloseReason::UnreachableHost);
        assert_eq!(
            ConnectFailure::Timeout.reason(),
            CloseReason::ConnectTimedOut
        );
        assert_eq!(
            ConnectFailure::Refused.reason(),
            CloseReason::ConnectionRefused
        );
        assert_eq!(ConnectFailure::Network.reason(), CloseReason::NetworkError);
    }

    #[test]
    fn window_grant_take() {
        let w = Window::default();
        assert_eq!(w.get(), 0);
        assert!(!w.take());
        w.grant(2);
        assert!(w.take());
        assert!(w.take());
        assert!(!w.take());
        w.grant(5);
        assert_eq!(w.get(), 5);
    }

    #[test]
    fn auth_verdicts() {
        let mut cfg = Config::default();
        assert!(!auth_required_for(&cfg));
        cfg.password = Some(("ada".into(), "hunter2".into()));
        assert!(auth_required_for(&cfg));
        let sh = Shared::new(cfg);
        // No password extension declared: required.
        match check_auth(&sh, None, &[]) {
            AuthState::Reject(CloseReason::AuthRequired) => {}
            other => panic!("expected AuthRequired, got {other:?}"),
        }
        // Wrong credentials: bad credentials.
        let bad = wisp_core::extension::password_auth_client("ada", "wrong").unwrap();
        match check_auth(&sh, None, &[(ExtensionId::PasswordAuth, bad)]) {
            AuthState::Reject(CloseReason::AuthBadCredentials) => {}
            other => panic!("expected AuthBadCredentials, got {other:?}"),
        }
        // Right credentials: ok.
        let good = wisp_core::extension::password_auth_client("ada", "hunter2").unwrap();
        assert!(matches!(
            check_auth(&sh, None, &[(ExtensionId::PasswordAuth, good)]),
            AuthState::Ok
        ));
    }

    fn auth_required_for(cfg: &Config) -> bool {
        cfg.password.is_some() || cfg.key_hex.is_some()
    }

    #[test]
    fn config_clamps_bad_values() {
        // from_env reads real env vars; keep this test independent of
        // the environment by exercising the helpers instead.
        assert_eq!(env_num("ZL_TEST_NOPE", 5usize, 2), 5);
        assert_eq!(env_num::<usize>("ZL_TEST_X", 5, 2), 5);
        assert_eq!(env_secs("ZL_TEST_NOPE", 7).as_secs(), 7);
    }

    #[tokio::test]
    async fn tcp_relay_roundtrip_with_window() {
        // Local echo server. The REAL relay loop runs (tcp_relay_loop,
        // bug-scout fix: this test used to hand-copy the loop, and the
        // copy had already drifted); the destination policy is a
        // session-level concern, not the relay's.
        let lst = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = lst.local_addr().unwrap();
        let echo = tokio::spawn(async move {
            if let Ok((mut s, _)) = lst.accept().await {
                let (mut r, mut w) = s.split();
                let _ = tokio::io::copy(&mut r, &mut w).await;
            }
        });
        let sock = TcpStream::connect(addr).await.unwrap();
        let (ws_tx, mut ws_rx) = mpsc::channel::<Message>(16);
        let window = Arc::new(Window::default());
        window.grant(8);
        let last_active = Arc::new(Mutex::new(Instant::now()));
        let (input_tx, input_rx) = mpsc::channel::<Vec<u8>>(8);
        let stream_id = 7u32;
        let w = window.clone();
        let la = last_active.clone();
        let relay = tokio::spawn(async move {
            let (rd, wr) = sock.into_split();
            tcp_relay_loop(rd, wr, input_rx, &ws_tx, stream_id, &w, true, &la).await;
        });

        // Outbound data through the input channel.
        input_tx.send(b"hello".to_vec()).await.unwrap();
        // The echo comes back as a wisp DATA packet on the ws channel.
        let msg = tokio::time::timeout(Duration::from_secs(5), ws_rx.recv())
            .await
            .expect("timeout waiting for echo")
            .expect("ws channel closed");
        let bin = match msg {
            Message::Binary(b) => b,
            other => panic!("expected binary, got {other:?}"),
        };
        let mut buf = BytesMut::from(&bin[..]);
        let frame = Frame::decode(&mut buf).unwrap().unwrap();
        match frame.parse_packet().unwrap() {
            Packet::Data {
                stream_id: sid,
                payload,
            } => {
                assert_eq!(sid, 7);
                assert_eq!(payload, b"hello");
            }
            other => panic!("expected DATA, got {other:?}"),
        }
        // Window was spent.
        assert_eq!(window.get(), 7);
        relay.abort();
        echo.abort();
    }

    #[tokio::test]
    async fn tcp_relay_starved_window_keeps_draining_input() {
        // Bug-scout regression: while the window was starved the relay
        // blocked without draining its input channel. The session
        // loop then wedged on its bounded DATA send, and the CONTINUE
        // that grants the window could never be read: a full-duplex
        // deadlock. Input must keep flowing while the window is
        // closed, and the socket read must resume once granted.
        // Runs the REAL relay loop (tcp_relay_loop).
        let lst = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = lst.local_addr().unwrap();
        let echo = tokio::spawn(async move {
            if let Ok((mut s, _)) = lst.accept().await {
                let (mut r, mut w) = s.split();
                let _ = tokio::io::copy(&mut r, &mut w).await;
            }
        });
        let sock = TcpStream::connect(addr).await.unwrap();
        let (ws_tx, mut ws_rx) = mpsc::channel::<Message>(16);
        let window = Arc::new(Window::default());
        // Deliberately starved: no initial grant.
        let la = Arc::new(Mutex::new(Instant::now()));
        let (input_tx, input_rx) = mpsc::channel::<Vec<u8>>(8);
        let stream_id = 9u32;
        let w = window.clone();
        let relay = tokio::spawn(async move {
            let (rd, wr) = sock.into_split();
            tcp_relay_loop(rd, wr, input_rx, &ws_tx, stream_id, &w, true, &la).await;
        });

        // More than the input channel's own capacity: with the old
        // code every send past the eighth wedged forever (nothing
        // drained while starved).
        for i in 0..10u8 {
            tokio::time::timeout(Duration::from_secs(5), input_tx.send(vec![i; 64]))
                .await
                .expect("input send wedged: starved relay not draining")
                .unwrap();
        }
        // Grant the window: the drained bytes come back as wisp DATA.
        window.grant(1000);
        let mut got = 0usize;
        while got < 10 * 64 {
            let msg = tokio::time::timeout(Duration::from_secs(5), ws_rx.recv())
                .await
                .expect("timeout waiting for echo after grant")
                .expect("ws channel closed");
            let bin = match msg {
                Message::Binary(b) => b,
                other => panic!("expected binary, got {other:?}"),
            };
            let mut buf = BytesMut::from(&bin[..]);
            let frame = Frame::decode(&mut buf).unwrap().unwrap();
            match frame.parse_packet().unwrap() {
                Packet::Data {
                    stream_id: sid,
                    payload,
                } => {
                    assert_eq!(sid, 9);
                    got += payload.len();
                }
                other => panic!("expected DATA, got {other:?}"),
            }
        }
        assert_eq!(got, 640);
        relay.abort();
        echo.abort();
    }

    #[tokio::test]
    async fn failed_connect_closes_without_continue_and_is_reaped() {
        // Bug-scout regressions: (1) CONTINUE used to be granted
        // before the outbound connect, so a failed connect surfaced
        // as a mid-handshake Close (curl's bogus "SSL error 35") - a
        // failed connect must Close at the connect phase with NO
        // CONTINUE. (2) The finished relay's dead entry used to stay
        // in the session map until the idle sweep, counting toward
        // max_streams_per_conn.
        let (ws_tx, mut ws_rx) = mpsc::channel::<Message>(16);
        let mut sess = Session {
            shared: Shared::new(Config::default()),
            ws_tx,
            streams: std::collections::HashMap::new(),
            next_sweep: Instant::now(),
        };
        // Loopback is blocked by the default destination policy
        // (instant, no DNS); under the compat suite's test escape
        // hatch the connect is refused instead - both are honest
        // connect failures, both must Close without CONTINUE.
        spawn_tcp_relay(&mut sess, 7, 61999, "127.0.0.1".into(), true).await;
        let msg = tokio::time::timeout(Duration::from_secs(5), ws_rx.recv())
            .await
            .expect("timeout waiting for Close")
            .expect("ws channel closed");
        let bin = match msg {
            Message::Binary(b) => b,
            other => panic!("expected binary, got {other:?}"),
        };
        let mut buf = BytesMut::from(&bin[..]);
        let frame = Frame::decode(&mut buf).unwrap().unwrap();
        match frame.parse_packet().unwrap() {
            Packet::Close { stream_id, reason } => {
                assert_eq!(stream_id, 7);
                assert!(
                    matches!(
                        reason,
                        CloseReason::Blocked | CloseReason::ConnectionRefused
                    ),
                    "unexpected close reason {reason:?}"
                );
            }
            Packet::Continue { .. } => panic!("CONTINUE granted for a failed connect"),
            other => panic!("expected Close, got {other:?}"),
        }
        // The entry stays until the relay task finishes, then the
        // reap (Connect arm / sweep) must drop it: a dead stream must
        // not count toward max_streams_per_conn.
        let mut finished = false;
        for _ in 0..200 {
            finished = sess
                .streams
                .get(&7)
                .map(|e| e.task.is_finished())
                .unwrap_or(false);
            if finished {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(finished, "relay task must finish after a failed connect");
        sess.reap_finished();
        assert!(
            sess.streams.is_empty(),
            "finished relay entry must be reaped"
        );
    }

    #[tokio::test]
    async fn udp_relay_datagram_boundaries() {
        // Local UDP echo.
        let echo = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let eaddr = echo.local_addr().unwrap();
        let echo_task = tokio::spawn(async move {
            let mut buf = vec![0u8; 4096];
            loop {
                let (n, from) = match echo.recv_from(&mut buf).await {
                    Ok(x) => x,
                    Err(_) => break,
                };
                if echo.send_to(&buf[..n], from).await.is_err() {
                    break;
                }
            }
        });
        let sock = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        sock.connect(eaddr).await.unwrap();
        let (ws_tx, mut ws_rx) = mpsc::channel::<Message>(16);
        let (input_tx, input_rx) = mpsc::channel::<Vec<u8>>(8);
        let stream_id = 3u32;
        let bytes_ctr = Arc::new(AtomicU64::new(0));
        let pkt_ctr = Arc::new(AtomicU64::new(0));
        let la = Arc::new(Mutex::new(Instant::now()));
        let bc = bytes_ctr.clone();
        let pc = pkt_ctr.clone();
        let lam = la.clone();
        let max_dgram = 4096usize;
        let relay = tokio::spawn(async move {
            let mut input_rx = input_rx;
            let mut buf = vec![0u8; max_dgram];
            loop {
                tokio::select! {
                    r = sock.recv(&mut buf) => match r {
                        Ok(0) => continue,
                        Err(_) => break,
                        Ok(n) => {
                            let data = Packet::Data { stream_id, payload: buf[..n].to_vec() };
                            if send_packet(&ws_tx, &data).await.is_err() {
                                break;
                            }
                            bc.fetch_add(n as u64, Ordering::Relaxed);
                            pc.fetch_add(1, Ordering::Relaxed);
                            if let Ok(mut t) = lam.lock() { *t = Instant::now(); }
                        }
                    },
                    m = input_rx.recv() => match m {
                        Some(dgram) => {
                            if dgram.len() > max_dgram { continue; }
                            if sock.send(&dgram).await.is_err() { break; }
                            bc.fetch_add(dgram.len() as u64, Ordering::Relaxed);
                            pc.fetch_add(1, Ordering::Relaxed);
                            if let Ok(mut t) = lam.lock() { *t = Instant::now(); }
                        }
                        None => break,
                    },
                }
            }
        });

        // Two datagrams in, two datagrams out; boundaries preserved.
        // A zero-length datagram is legal UDP: it must ride along
        // without ending the stream (bug-scout fix: tokio surfaces it
        // as Ok(0), which read as EOF).
        input_tx.send(Vec::new()).await.unwrap();
        input_tx.send(vec![1, 2, 3]).await.unwrap();
        input_tx.send(vec![4]).await.unwrap();
        let mut got: Vec<Vec<u8>> = Vec::new();
        for _ in 0..2 {
            let msg = tokio::time::timeout(Duration::from_secs(5), ws_rx.recv())
                .await
                .expect("timeout")
                .expect("closed");
            let bin = match msg {
                Message::Binary(b) => b,
                other => panic!("expected binary, got {other:?}"),
            };
            let mut buf = BytesMut::from(&bin[..]);
            let frame = Frame::decode(&mut buf).unwrap().unwrap();
            match frame.parse_packet().unwrap() {
                Packet::Data { payload, .. } => got.push(payload),
                other => panic!("expected DATA, got {other:?}"),
            }
        }
        assert_eq!(got, vec![vec![1, 2, 3], vec![4]]);
        // The counter is bidirectional: 3 client->upstream datagrams
        // (one of them zero-length) plus the 2 echoed back.
        assert_eq!(pkt_ctr.load(Ordering::Relaxed), 5);
        relay.abort();
        echo_task.abort();
    }
}
