//! wisp-wasm: thin wasm-bindgen wrapper over LobsterBrowse's wisp-core
//! (Wisp v2.1). The service worker uses these helpers to build and parse
//! frames; the protocol is NOT reimplemented here.
//!
//! Client handshake (v2): after the WebSocket opens with the wisp
//! subprotocol, the server sends INFO(stream 0). The client replies with
//! its own INFO(stream 0), then opens streams with CONNECT packets.

use bytes::BytesMut;
use wasm_bindgen::prelude::*;
use wisp_core::{encode_packet, CloseReason, Frame, Packet, PacketType, StreamKind};
use wisp_core::extension::{password_auth_client, ExtensionId};

pub const WISP_VERSION_MAJOR: u8 = 2;
pub const WISP_VERSION_MINOR: u8 = 1;
/// Wisp v2 subprotocol name for the WebSocket handshake.
pub const WISP_SUBPROTOCOL: &str = "wisp";

#[wasm_bindgen]
pub struct JsFrame {
    #[wasm_bindgen(js_name = "packetType")]
    pub packet_type: u8,
    #[wasm_bindgen(js_name = "streamId")]
    pub stream_id: u32,
    // wasm-bindgen pub struct fields must be Copy; expose the payload
    // through a getter instead so JS sees the same `frame.payload` API.
    payload: Vec<u8>,
}

#[wasm_bindgen]
impl JsFrame {
    #[wasm_bindgen(getter, js_name = "isData")]
    pub fn is_data(&self) -> bool {
        self.packet_type == PacketType::Data as u8
    }
    #[wasm_bindgen(getter, js_name = "isContinue")]
    pub fn is_continue(&self) -> bool {
        self.packet_type == PacketType::Continue as u8
    }
    #[wasm_bindgen(getter, js_name = "isClose")]
    pub fn is_close(&self) -> bool {
        self.packet_type == PacketType::Close as u8
    }
    #[wasm_bindgen(getter, js_name = "closeReason")]
    pub fn close_reason(&self) -> u8 {
        // #421: report the real close reason byte instead of the old
        // no-op conditional; unknown codes map to Unspecified.
        if !self.is_close() {
            return 0;
        }
        let raw = self.payload.first().copied().unwrap_or(0);
        match wisp_core::CloseReason::from_u8(raw) {
            Ok(_) => raw,
            Err(_) => CloseReason::Unspecified as u8,
        }
    }
    #[wasm_bindgen(getter, js_name = "payload")]
    pub fn payload(&self) -> Vec<u8> {
        self.payload.clone()
    }
    #[wasm_bindgen(getter, js_name = "bufferRemaining")]
    pub fn buffer_remaining(&self) -> u32 {
        u32::from_le_bytes([
            self.payload.first().copied().unwrap_or(0),
            self.payload.get(1).copied().unwrap_or(0),
            self.payload.get(2).copied().unwrap_or(0),
            self.payload.get(3).copied().unwrap_or(0),
        ])
    }
}

/// Client INFO for the v2 handshake (stream 0).
#[wasm_bindgen]
pub fn handshake_info() -> Vec<u8> {
    let pkt = Packet::Info {
        stream_id: 0,
        major: WISP_VERSION_MAJOR,
        minor: WISP_VERSION_MINOR,
        extensions: Vec::new(),
    };
    encode_into_bytes(&pkt)
}

/// A Wisp v2 password-auth client INFO frame, using the canonical
/// wisp-core encoder. The browser's vendored libcurl/epoxy transport
/// does NOT invoke this helper today: do not claim authenticated
/// browsing until the vendor connection owns this negotiated frame.
/// Invalid credentials fail closed (None), never become URL parameters.
#[wasm_bindgen(js_name = "handshakeInfoPassword")]
pub fn handshake_info_password(username: String, password: String) -> Option<Vec<u8>> {
    if username.is_empty()
        || username.len() > 255
        || password.is_empty()
        || password.len() > 4096
    {
        return None;
    }
    let payload = password_auth_client(&username, &password).ok()?;
    Some(encode_into_bytes(&Packet::Info {
        stream_id: 0,
        major: WISP_VERSION_MAJOR,
        minor: WISP_VERSION_MINOR,
        extensions: vec![(ExtensionId::PasswordAuth as u8, payload)],
    }))
}

/// CONNECT for a new TCP stream to host:port.
#[wasm_bindgen(js_name = "connectTcp")]
pub fn connect_tcp(stream_id: u32, port: u16, hostname: String) -> Vec<u8> {
    let pkt = Packet::Connect {
        stream_id,
        kind: StreamKind::Tcp,
        port,
        hostname,
    };
    encode_into_bytes(&pkt)
}

/// DATA payload on a stream.
#[wasm_bindgen(js_name = "dataPacket")]
pub fn data_packet(stream_id: u32, payload: Vec<u8>) -> Vec<u8> {
    let pkt = Packet::Data { stream_id, payload };
    encode_into_bytes(&pkt)
}

/// CONTINUE: tell the peer it may keep sending (buffer window).
#[wasm_bindgen(js_name = "continuePacket")]
pub fn continue_packet(stream_id: u32, buffer_remaining: u32) -> Vec<u8> {
    let pkt = Packet::Continue {
        stream_id,
        buffer_remaining,
    };
    encode_into_bytes(&pkt)
}

/// CLOSE a stream (or stream 0 to end the whole connection).
#[wasm_bindgen(js_name = "closePacket")]
pub fn close_packet(stream_id: u32, reason: u8) -> Vec<u8> {
    // #421: unknown close reasons map to Unspecified, not Voluntary.
    let reason = wisp_core::CloseReason::from_u8(reason).unwrap_or(CloseReason::Unspecified);
    let pkt = Packet::Close { stream_id, reason };
    encode_into_bytes(&pkt)
}

/// Parse one WebSocket message into a frame. Returns undefined if the
/// message is not a valid frame (caller should drop the connection).
#[wasm_bindgen(js_name = "parseFrame")]
pub fn parse_frame(msg: Vec<u8>) -> Option<JsFrame> {
    let mut buf = BytesMut::from(&msg[..]);
    match Frame::decode(&mut buf) {
        Ok(Some(frame)) => Some(JsFrame {
            packet_type: frame.packet_type as u8,
            stream_id: frame.stream_id,
            payload: frame.payload.to_vec(),
        }),
        _ => None,
    }
}

fn encode_into_bytes(pkt: &Packet) -> Vec<u8> {
    let frame = encode_packet(pkt);
    let mut out = BytesMut::with_capacity(5 + frame.payload.len());
    frame.encode_into(&mut out);
    out.to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_through_wrapper() {
        let wire = connect_tcp(7, 443, "example.com".into());
        assert_eq!(wire[0], 0x01);
        let mut buf = BytesMut::from(&wire[..]);
        let frame = Frame::decode(&mut buf).unwrap().unwrap();
        let pkt = frame.parse_packet().unwrap();
        match pkt {
            Packet::Connect {
                stream_id,
                kind,
                port,
                hostname,
            } => {
                assert_eq!(
                    (stream_id, port, hostname),
                    (7, 443, "example.com".to_string())
                );
                assert!(matches!(kind, StreamKind::Tcp));
            }
            _ => panic!("wrong packet"),
        }
    }

    #[test]
    fn info_shape() {
        let wire = handshake_info();
        assert_eq!(wire[0], 0x05);
        assert_eq!(wire[5], 2); // major
        assert_eq!(wire[6], 1); // minor
    }

    #[test]
    fn password_info_roundtrips_through_canonical_wisp_core() {
        let wire = handshake_info_password("ada".into(), "hunter2".into()).unwrap();
        let mut bytes = BytesMut::from(wire.as_slice());
        let frame = Frame::decode(&mut bytes).unwrap().unwrap();
        match frame.parse_packet().unwrap() {
            Packet::Info { stream_id, major, minor, extensions } => {
                assert_eq!((stream_id, major, minor), (0, 2, 1));
                assert_eq!(extensions.len(), 1);
                assert_eq!(extensions[0].0, ExtensionId::PasswordAuth as u8);
                let (user, password) =
                    wisp_core::extension::password_auth_client_decode(&extensions[0].1).unwrap();
                assert_eq!((user.as_str(), password.as_str()), ("ada", "hunter2"));
            }
            _ => panic!("expected Wisp INFO"),
        }
    }

    #[test]
    fn password_info_rejects_invalid_or_oversized_secrets() {
        assert!(handshake_info_password("".into(), "secret".into()).is_none());
        assert!(handshake_info_password("user".into(), "".into()).is_none());
        assert!(handshake_info_password("a".repeat(256), "secret".into()).is_none());
        assert!(handshake_info_password("user".into(), "x".repeat(4097)).is_none());
    }

    #[test]
    fn close_reason_getter_contract() {
        // #421: valid reasons pass through, unknown codes map to
        // Unspecified, DATA frames report 0, and an empty close
        // payload parses as Unspecified.
        let wire = |reason: u8| {
            let mut w = vec![0x04];
            w.extend_from_slice(&7u32.to_le_bytes());
            w.push(reason);
            w
        };
        let f = parse_frame(wire(0x48)).unwrap();
        assert!(f.is_close());
        assert_eq!(f.close_reason(), 0x48);
        let f = parse_frame(wire(0x05)).unwrap();
        assert_eq!(f.close_reason(), CloseReason::Unspecified as u8);
        let f = parse_frame(data_packet(7, vec![9])).unwrap();
        assert!(!f.is_close());
        assert_eq!(f.close_reason(), 0);
        let f = parse_frame(vec![0x04, 7, 0, 0, 0]).unwrap();
        assert_eq!(f.close_reason(), CloseReason::Unspecified as u8);
    }
}
