//! Wake-on-LAN: the magic packet, and the TCP probe that says whether one is
//! needed at all.
//!
//! A module here rather than a `crates/wr-*` of its own because there's no
//! external surface to wrap — this is std UDP plus one tokio connect, in the
//! same spirit as `atomic_file` and `coalesce`. The transports don't need it
//! either: waking is a property of the host, not of SSH, so it belongs to the
//! layer that already knows which host a session is for.
//!
//! What lives here is only the mechanism. Deciding *when* to wake — probe
//! first, re-send while waiting, give up after so long — is the connect path's
//! job and lands in `session_registry`.

use std::net::{Ipv4Addr, UdpSocket};
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// The port a magic packet is conventionally sent to. Nothing listens on it —
/// the NIC's firmware matches the payload anywhere in the frame, so the port
/// is a convention rather than a requirement. 7 turns up on some gear, which
/// is the whole reason this is overridable.
pub const DEFAULT_PORT: u16 = 9;

/// Where the packet goes when a profile doesn't name a target. The limited
/// broadcast address never leaves the local segment, which is the common case
/// (waking the desktop on your own LAN) and also the safe default: it can't
/// escape to somewhere it wasn't meant for.
pub const DEFAULT_BROADCAST: Ipv4Addr = Ipv4Addr::BROADCAST;

/// How long to keep waiting for a woken host to answer, when a profile
/// doesn't say. A Windows box coming out of S4 with a spinning disk is
/// comfortably the slowest thing this has to cover; 60s clears it with room
/// to spare, and the caller can raise it per-profile for anything slower.
pub const DEFAULT_WAIT_SECONDS: u64 = 60;

/// What to send, and where. `None` throughout means "use the default", so a
/// profile that only fills in a MAC — which is nearly all of them — stores
/// exactly that and nothing else.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeOnLan {
    /// Accepted in any of the four ways people write one down; see
    /// `parse_mac`.
    pub mac: String,
    /// Where to broadcast. `None` is 255.255.255.255, which only reaches the
    /// local segment; a directed broadcast (`192.168.1.255`) is what reaches
    /// another one, and is also how you pin the packet to a specific
    /// interface on a machine with several — see `send`.
    #[serde(default)]
    pub broadcast: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    /// Seconds to wait for the host to come up before giving up.
    #[serde(default)]
    pub wait_seconds: Option<u64>,
}

impl WakeOnLan {
    pub fn port(&self) -> u16 {
        self.port.unwrap_or(DEFAULT_PORT)
    }

    pub fn wait(&self) -> Duration {
        Duration::from_secs(self.wait_seconds.unwrap_or(DEFAULT_WAIT_SECONDS))
    }

    /// The parsed broadcast target. An unparseable address is an error rather
    /// than a silent fall back to 255.255.255.255: a typo'd directed
    /// broadcast that quietly becomes a limited one would look like it worked
    /// on the LAN and fail everywhere else, which is the worst way for this
    /// to be wrong.
    pub fn broadcast_addr(&self) -> Result<Ipv4Addr, String> {
        match self.broadcast.as_deref().map(str::trim) {
            None | Some("") => Ok(DEFAULT_BROADCAST),
            Some(text) => text
                .parse()
                .map_err(|_| format!("not a valid IPv4 broadcast address: {text}")),
        }
    }
}

/// A MAC as its six bytes, from any of the ways one gets written down:
/// `aa:bb:cc:dd:ee:ff`, `aa-bb-cc-dd-ee-ff`, Cisco's `aabb.ccdd.eeff`, or
/// bare `aabbccddeeff`. Separators are simply dropped rather than validated
/// into one canonical form — a mixed-separator string is unambiguous, and
/// rejecting it would only punish someone who pasted from two places.
pub fn parse_mac(text: &str) -> Result<[u8; 6], String> {
    let hex: String = text
        .chars()
        .filter(|c| !matches!(c, ':' | '-' | '.' | ' ' | '\t'))
        .collect();

    if hex.len() != 12 {
        return Err(format!("a MAC address needs 12 hex digits: {text}"));
    }

    let mut mac = [0u8; 6];
    for (i, byte) in mac.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16)
            .map_err(|_| format!("not a valid MAC address: {text}"))?;
    }
    Ok(mac)
}

/// The magic packet: six `0xFF` bytes, then the target's MAC sixteen times
/// over. Fixed-size because it always is — 6 + 6×16 = 102.
fn magic_packet(mac: [u8; 6]) -> [u8; 102] {
    let mut packet = [0xFFu8; 102];
    for chunk in packet[6..].chunks_exact_mut(6) {
        chunk.copy_from_slice(&mac);
    }
    packet
}

/// Broadcasts one magic packet.
///
/// Binding to 0.0.0.0 leaves the interface choice to the routing table, which
/// on a machine with Wi-Fi, Ethernet and a VM switch all up is a coin toss
/// that a limited broadcast has no way to influence. That's what
/// `WakeOnLan::broadcast` is for: a directed broadcast has a route, so naming
/// one picks the interface by picking the subnet. Fanning out across every
/// interface automatically would need interface enumeration — a dependency,
/// and a later call than this one.
pub fn send(wake: &WakeOnLan) -> Result<(), String> {
    let mac = parse_mac(&wake.mac)?;
    let target = wake.broadcast_addr()?;

    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .map_err(|e| format!("could not open a socket to send the magic packet: {e}"))?;
    socket
        .set_broadcast(true)
        .map_err(|e| format!("could not enable broadcast on the socket: {e}"))?;
    socket
        .send_to(&magic_packet(mac), (target, wake.port()))
        .map_err(|e| format!("could not send the magic packet to {target}: {e}"))?;

    Ok(())
}

/// Whether `host:port` accepts a connection within `timeout`.
///
/// This is the whole basis for not waking a machine that's already awake, and
/// for knowing when a woken one is ready. Anything other than a completed
/// handshake — refused, timed out, DNS failure — reads as "not up yet", since
/// from here they're indistinguishable from a host that hasn't finished
/// booting.
pub async fn port_open(host: &str, port: u16, timeout: Duration) -> bool {
    matches!(
        tokio::time::timeout(timeout, tokio::net::TcpStream::connect((host, port))).await,
        Ok(Ok(_))
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXPECTED: [u8; 6] = [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF];

    /// All four are how someone will have copied the address out of ipconfig,
    /// a router's lease table, a switch, or a label on the case.
    #[test]
    fn a_mac_parses_however_it_was_written_down() {
        for text in [
            "aa:bb:cc:dd:ee:ff",
            "AA-BB-CC-DD-EE-FF",
            "aabb.ccdd.eeff",
            "AABBCCDDEEFF",
            " aa:bb:cc:dd:ee:ff ",
        ] {
            assert_eq!(parse_mac(text).unwrap(), EXPECTED, "failed on {text}");
        }
    }

    /// Rejected rather than padded or truncated: a MAC that's wrong in any
    /// way wakes nothing, and saying so at the form is the only place the
    /// user can act on it.
    #[test]
    fn a_mac_that_isnt_six_bytes_of_hex_is_refused() {
        for text in [
            "",
            "aa:bb:cc:dd:ee",            // five bytes
            "aa:bb:cc:dd:ee:ff:00",      // seven
            "aa:bb:cc:dd:ee:gg",         // not hex
            "the printer in the corner", // not trying
        ] {
            assert!(parse_mac(text).is_err(), "accepted {text}");
        }
    }

    #[test]
    fn the_packet_is_six_ones_then_the_mac_sixteen_times() {
        let packet = magic_packet(EXPECTED);
        assert_eq!(&packet[..6], &[0xFF; 6]);
        for (i, chunk) in packet[6..].chunks_exact(6).enumerate() {
            assert_eq!(chunk, EXPECTED, "repetition {i}");
        }
        assert_eq!(packet[6..].len() / 6, 16);
    }

    /// A profile that fills in nothing but a MAC — nearly all of them — has
    /// to be the one that just works.
    #[test]
    fn a_mac_only_config_uses_the_conventional_defaults() {
        let wake = WakeOnLan {
            mac: "aa:bb:cc:dd:ee:ff".into(),
            broadcast: None,
            port: None,
            wait_seconds: None,
        };
        assert_eq!(wake.port(), 9);
        assert_eq!(wake.broadcast_addr().unwrap(), Ipv4Addr::BROADCAST);
        assert_eq!(wake.wait(), Duration::from_secs(60));
    }

    /// Empty is what a cleared form field sends, and means the same as absent.
    #[test]
    fn an_empty_broadcast_field_means_the_default() {
        let wake = WakeOnLan {
            mac: "aa:bb:cc:dd:ee:ff".into(),
            broadcast: Some("  ".into()),
            port: None,
            wait_seconds: None,
        };
        assert_eq!(wake.broadcast_addr().unwrap(), Ipv4Addr::BROADCAST);
    }

    /// See `broadcast_addr`: falling back to the limited broadcast here would
    /// work on the LAN and fail silently everywhere else.
    #[test]
    fn a_broadcast_address_that_isnt_one_is_an_error_not_a_fallback() {
        let wake = WakeOnLan {
            mac: "aa:bb:cc:dd:ee:ff".into(),
            broadcast: Some("192.168.1".into()),
            port: None,
            wait_seconds: None,
        };
        assert!(wake.broadcast_addr().is_err());
    }

    /// The bytes on the wire are the entire contract with the NIC's firmware,
    /// so they're worth pinning through a real socket rather than only
    /// through `magic_packet`. Sent to loopback on an ephemeral port: the
    /// broadcast flag is set exactly as it is in the real path, but nothing
    /// leaves the machine running the tests.
    #[test]
    fn send_puts_the_magic_packet_on_the_wire() {
        let receiver = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = receiver.local_addr().unwrap().port();

        send(&WakeOnLan {
            mac: "aa:bb:cc:dd:ee:ff".into(),
            broadcast: Some(Ipv4Addr::LOCALHOST.to_string()),
            port: Some(port),
            wait_seconds: None,
        })
        .unwrap();

        let mut buf = [0u8; 128];
        let (len, _) = receiver.recv_from(&mut buf).unwrap();
        assert_eq!(len, 102);
        assert_eq!(buf[..102], magic_packet(EXPECTED));
    }

    #[test]
    fn send_refuses_a_config_it_cant_turn_into_a_packet() {
        assert!(send(&WakeOnLan {
            mac: "nope".into(),
            broadcast: None,
            port: None,
            wait_seconds: None,
        })
        .is_err());
    }

    /// The "don't wake a machine that's already up" half of the feature.
    #[tokio::test]
    async fn port_open_sees_something_listening() {
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(port_open("127.0.0.1", port, Duration::from_secs(2)).await);
    }

    /// Dropping the listener first frees a port we know nothing else claimed,
    /// which is as close to "definitely closed" as a test can get.
    #[tokio::test]
    async fn port_open_reports_a_closed_port_as_closed() {
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        assert!(!port_open("127.0.0.1", port, Duration::from_secs(2)).await);
    }

    /// A host that will never answer must not hold the connect path open past
    /// its own deadline.
    #[tokio::test]
    async fn port_open_gives_up_after_the_timeout() {
        // 203.0.113.0/24 is TEST-NET-3: reserved for documentation, routed
        // nowhere, so this can only ever time out.
        assert!(!port_open("203.0.113.1", 22, Duration::from_millis(200)).await);
    }
}
