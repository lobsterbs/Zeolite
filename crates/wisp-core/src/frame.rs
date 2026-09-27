//! Wire framing: parse/serialize raw Wisp frames (header + opaque payload),
//! plus payload encoding/decoding into typed packets.

use crate::error::{Result, WispError};
use crate::packet::{CloseReason, Packet, PacketType, StreamKind};
use bytes::{Buf, BufMut, Bytes, BytesMut};

/// Minimum frame size: type (1) + stream id (4).
pub const HEADER_LEN: usize = 5;

/// A raw frame: type byte, stream id, payload bytes.
#[derive(Debug, Clone)]
pub struct Frame {
    pub packet_type: PacketType,
    pub stream_id: u32,
    pub payload: Bytes,
}

impl Frame {
    /// Serialize the frame into out (little-endian header + payload).
    pub fn encode_into(&self, out: &mut BytesMut) {
        out.put_u8(self.packet_type as u8);
        out.put_u32_le(self.stream_id);
        out.extend_from_slice(&self.payload);
    }

    /// Try to parse one frame from buf. Returns Ok(None) if more data is needed.
    /// Each WebSocket message carries exactly one Wisp frame, so the whole
    /// message is consumed.
    pub fn decode(buf: &mut BytesMut) -> Result<Option<Frame>> {
        if buf.len() < HEADER_LEN {
            return Ok(None);
        }
        let packet_type = PacketType::from_u8(buf[0])?;
        let stream_id = u32::from_le_bytes([buf[1], buf[2], buf[3], buf[4]]);
        let payload = buf[HEADER_LEN..].to_vec();
        buf.advance(buf.len());
        Ok(Some(Frame {
            packet_type,
            stream_id,
            payload: Bytes::from(payload),
        }))
    }

    /// Decode this frame payload into a typed packet.
    pub fn parse_packet(&self) -> Result<Packet> {
        let p = &self.payload;
        match self.packet_type {
            PacketType::Connect => {
                if p.len() < 4 {
                    return Err(WispError::BufferTooShort {
                        need: 4,
                        have: p.len(),
                    });
                }
                let kind = StreamKind::from_u8(p[0])?;
                let port = u16::from_le_bytes([p[1], p[2]]);
                let hostname = parse_hostname(p)?;
                Ok(Packet::Connect {
                    stream_id: self.stream_id,
                    kind,
                    port,
                    hostname,
                })
            }
            PacketType::Data => Ok(Packet::Data {
                stream_id: self.stream_id,
                payload: p.to_vec(),
            }),
            PacketType::Continue => {
                if p.len() < 4 {
                    return Err(WispError::BufferTooShort {
                        need: 4,
                        have: p.len(),
                    });
                }
                Ok(Packet::Continue {
                    stream_id: self.stream_id,
                    buffer_remaining: u32::from_le_bytes([p[0], p[1], p[2], p[3]]),
                })
            }
            PacketType::Close => {
                if p.is_empty() {
                    return Err(WispError::BufferTooShort { need: 1, have: 0 });
                }
                Ok(Packet::Close {
                    stream_id: self.stream_id,
                    reason: CloseReason::from_u8(p[0])?,
                })
            }
            PacketType::Info => parse_info(self.stream_id, p),
        }
    }

    /// Decode this frame payload using the wisp v1 wire layout.
    ///
    /// v1 differs from v2 in exactly one packet: CONNECT carries the
    /// hostname without a length prefix (see `parse_hostname_v1`). All
    /// other packet types are byte-identical between v1 and v2, so they
    /// delegate to `parse_packet`. The server picks the parser once from
    /// the negotiated version; a v1 client must never be fed v2 parsing
    /// (its CONNECT host byte would be misread as the length prefix).
    pub fn parse_packet_v1(&self) -> Result<Packet> {
        if self.packet_type != PacketType::Connect {
            return self.parse_packet();
        }
        let p = &self.payload;
        if p.len() < 3 {
            return Err(WispError::BufferTooShort {
                need: 3,
                have: p.len(),
            });
        }
        let kind = StreamKind::from_u8(p[0])?;
        let port = u16::from_le_bytes([p[1], p[2]]);
        let hostname = parse_hostname_v1(p)?;
        Ok(Packet::Connect {
            stream_id: self.stream_id,
            kind,
            port,
            hostname,
        })
    }
}

/// CONNECT hostname: layout is [kind u8][port u16][hostlen u8][host].
fn parse_hostname(p: &[u8]) -> Result<String> {
    if p.len() < 4 {
        return Err(WispError::BufferTooShort {
            need: 4,
            have: p.len(),
        });
    }
    let hostlen = p[3] as usize;
    if p.len() < 4 + hostlen {
        return Err(WispError::BufferTooShort {
            need: 4 + hostlen,
            have: p.len(),
        });
    }
    Ok(std::str::from_utf8(&p[4..4 + hostlen])?.to_string())
}

/// CONNECT hostname, wisp v1 layout: [kind u8][port u16][host to end of
/// payload]. No length prefix; the frame header already bounds the host.
fn parse_hostname_v1(p: &[u8]) -> Result<String> {
    if p.len() < 3 {
        return Err(WispError::BufferTooShort {
            need: 3,
            have: p.len(),
        });
    }
    Ok(std::str::from_utf8(&p[3..])?.to_string())
}

/// INFO payload: [major u8][minor u8] + extension entries,
/// each entry: [id u8][meta_len u32 LE][meta bytes].
fn parse_info(stream_id: u32, p: &[u8]) -> Result<Packet> {
    if p.len() < 2 {
        return Err(WispError::BufferTooShort {
            need: 2,
            have: p.len(),
        });
    }
    let major = p[0];
    let minor = p[1];
    let mut pos = 2;
    let mut extensions = Vec::new();
    while pos < p.len() {
        if p.len() - pos < 5 {
            return Err(WispError::BufferTooShort {
                need: pos + 5,
                have: p.len(),
            });
        }
        let id = p[pos];
        let meta_len =
            u32::from_le_bytes([p[pos + 1], p[pos + 2], p[pos + 3], p[pos + 4]]) as usize;
        pos += 5;
        if p.len() - pos < meta_len {
            return Err(WispError::BufferTooShort {
                need: pos + meta_len,
                have: p.len(),
            });
        }
        extensions.push((id, p[pos..pos + meta_len].to_vec()));
        pos += meta_len;
    }
    Ok(Packet::Info {
        stream_id,
        major,
        minor,
        extensions,
    })
}

/// Build a raw frame from a typed packet.
pub fn encode_packet(packet: &Packet) -> Frame {
    match packet {
        Packet::Connect {
            stream_id,
            kind,
            port,
            hostname,
        } => {
            let host = hostname.as_bytes();
            debug_assert!(host.len() <= 255, "hostname exceeds u8 length prefix");
            let mut p = BytesMut::with_capacity(4 + host.len());
            p.put_u8(*kind as u8);
            p.put_u16_le(*port);
            p.put_u8(host.len() as u8);
            p.extend_from_slice(host);
            Frame {
                packet_type: PacketType::Connect,
                stream_id: *stream_id,
                payload: p.freeze(),
            }
        }
        Packet::Data { stream_id, payload } => Frame {
            packet_type: PacketType::Data,
            stream_id: *stream_id,
            payload: Bytes::from(payload.clone()),
        },
        Packet::Continue {
            stream_id,
            buffer_remaining,
        } => {
            let mut p = BytesMut::with_capacity(4);
            p.put_u32_le(*buffer_remaining);
            Frame {
                packet_type: PacketType::Continue,
                stream_id: *stream_id,
                payload: p.freeze(),
            }
        }
        Packet::Close { stream_id, reason } => Frame {
            packet_type: PacketType::Close,
            stream_id: *stream_id,
            payload: Bytes::from(vec![*reason as u8]),
        },
        Packet::Info {
            stream_id,
            major,
            minor,
            extensions,
        } => {
            let mut p = BytesMut::new();
            p.put_u8(*major);
            p.put_u8(*minor);
            for (id, meta) in extensions {
                p.put_u8(*id);
                p.put_u32_le(meta.len() as u32);
                p.extend_from_slice(meta);
            }
            Frame {
                packet_type: PacketType::Info,
                stream_id: *stream_id,
                payload: p.freeze(),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::packet::Packet;

    #[test]
    fn roundtrip_connect() {
        let pkt = Packet::Connect {
            stream_id: 42,
            kind: StreamKind::Tcp,
            port: 443,
            hostname: "example.com".into(),
        };
        let frame = encode_packet(&pkt);
        let mut buf = BytesMut::new();
        frame.encode_into(&mut buf);
        let parsed = Frame::decode(&mut buf).unwrap().unwrap();
        assert_eq!(parsed.parse_packet().unwrap(), pkt);
    }

    #[test]
    fn roundtrip_info_with_extensions() {
        let pkt = Packet::Info {
            stream_id: 0,
            major: 2,
            minor: 1,
            extensions: vec![(0x01, vec![]), (0x04, b"hello".to_vec())],
        };
        let frame = encode_packet(&pkt);
        let mut buf = BytesMut::new();
        frame.encode_into(&mut buf);
        let parsed = Frame::decode(&mut buf).unwrap().unwrap();
        assert_eq!(parsed.parse_packet().unwrap(), pkt);
    }

    #[test]
    fn reject_invalid_type() {
        let mut buf = BytesMut::from(&[0x09u8, 0, 0, 0, 0][..]);
        assert!(Frame::decode(&mut buf).is_err());
    }

    #[test]
    fn v1_connect_parses_without_length_prefix() {
        // Hand-built v1 frame: CONNECT, stream 1, TCP, port 443 LE,
        // hostname "example.com" running to the end of the payload.
        let host = b"example.com";
        let mut raw = vec![0x01u8, 0x01, 0x00, 0x00, 0x00, 0x01, 0xBB, 0x01];
        raw.extend_from_slice(host);
        let mut buf = BytesMut::from(&raw[..]);
        let frame = Frame::decode(&mut buf).unwrap().unwrap();
        match frame.parse_packet_v1().unwrap() {
            Packet::Connect {
                stream_id,
                kind,
                port,
                hostname,
            } => {
                assert_eq!(stream_id, 1);
                assert_eq!(kind, StreamKind::Tcp);
                assert_eq!(port, 443);
                assert_eq!(hostname, "example.com");
            }
            other => panic!("expected CONNECT, got {other:?}"),
        }
        // The same bytes must NOT decode via the v2 parser: the first
        // hostname byte ('e' = 101) would be read as a length prefix.
        assert!(frame.parse_packet().is_err());
    }

    #[test]
    fn v1_non_connect_delegates() {
        // DATA and CLOSE are identical in v1 and v2.
        let mut buf = BytesMut::from(&[0x02u8, 0x07, 0x00, 0x00, 0x00, b'h', b'i'][..]);
        let frame = Frame::decode(&mut buf).unwrap().unwrap();
        match frame.parse_packet_v1().unwrap() {
            Packet::Data { stream_id, payload } => {
                assert_eq!(stream_id, 7);
                assert_eq!(payload, b"hi".to_vec());
            }
            other => panic!("expected DATA, got {other:?}"),
        }
    }
}
