//! Wake-on-LAN: the magic packet, and the TCP probe that says whether one is
//! needed at all.
//!
//! A module here rather than a `crates/wr-*` of its own because there's no
//! external surface to wrap — this is std UDP plus one tokio connect, in the
//! same spirit as `atomic_file` and `coalesce`. The transports don't need it
//! either: waking is a property of the host, not of SSH, so it belongs to the
//! layer that already knows which host a session is for.
//!
//! `wake_and_wait` is the whole policy: probe first so an already-awake host
//! is never sent anything, re-send while waiting because a NIC coming out of
//! deep sleep can miss the first packet, and give up on a deadline rather than
//! leaving the connect path open indefinitely. What it doesn't own is
//! cancellation — a pane closed mid-wake is `session_registry`'s to notice,
//! since the registry is what knows the session is gone.

use std::net::{Ipv4Addr, UdpSocket};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio::time::Instant;
use wr_core::{ConnectionEvent, ConnectionStatus};

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

/// The longest wait a stored profile can ask for. Ten minutes is already well
/// past the S4-with-a-spinning-disk case `DEFAULT_WAIT_SECONDS` describes, so
/// nothing legitimate is being refused.
///
/// The ceiling exists because the field is a number in a file: `sessions.json`
/// is editable, and `vault_import`'s plaintext half deserialises straight into
/// `SessionProfile`. Unbounded, it buys two things — a pane stuck "Waking" for
/// a year while emitting a packet every `RETRY_INTERVAL`, and, at the top of
/// the range, a panic: `Instant + Duration` is a `checked_add().expect(..)`,
/// and a panic inside the connect task's prepare step leaves the session
/// wedged in `Connecting`.
///
/// Clamped rather than rejected at use, so an imported profile stays usable;
/// `validate` is the complement, so the person who typed it hears about it.
pub const MAX_WAIT_SECONDS: u64 = 600;

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

    /// Clamped to `MAX_WAIT_SECONDS` — see there for why a stored number
    /// needs a ceiling at all.
    pub fn wait(&self) -> Duration {
        Duration::from_secs(
            self.wait_seconds
                .unwrap_or(DEFAULT_WAIT_SECONDS)
                .min(MAX_WAIT_SECONDS),
        )
    }

    /// The parsed broadcast target. An unparseable address is an error rather
    /// than a silent fall back to 255.255.255.255: a typo'd directed
    /// broadcast that quietly becomes a limited one would look like it worked
    /// on the LAN and fail everywhere else, which is the worst way for this
    /// to be wrong.
    ///
    /// An address that parses but isn't somewhere a magic packet belongs is
    /// the same kind of error — see `is_wakeable`.
    pub fn broadcast_addr(&self) -> Result<Ipv4Addr, String> {
        let addr: Ipv4Addr = match self.broadcast.as_deref().map(str::trim) {
            None | Some("") => return Ok(DEFAULT_BROADCAST),
            Some(text) => text
                .parse()
                .map_err(|_| format!("not a valid IPv4 broadcast address: {text}"))?,
        };
        if !is_wakeable(addr) {
            return Err(format!(
                "{addr} is not somewhere a magic packet belongs: use the limited broadcast \
                 (255.255.255.255) or a private-range address such as 192.168.1.255"
            ));
        }
        Ok(addr)
    }

    /// Everything about this config that can be checked without a network:
    /// the MAC parses, and the target is one a packet may be sent to.
    ///
    /// Separate from `send` so the same answer can be given at the two places
    /// a person can still act on it — saving a profile, and importing a
    /// bundle of them. Before this existed, both checks happened only at
    /// connect time, so a garbage MAC saved cleanly and failed a minute later
    /// in a pane.
    pub fn validate(&self) -> Result<(), String> {
        parse_mac(&self.mac)?;
        self.broadcast_addr()?;
        if self.wait_seconds.is_some_and(|s| s > MAX_WAIT_SECONDS) {
            return Err(format!(
                "waiting longer than {MAX_WAIT_SECONDS}s for a host to wake isn't supported"
            ));
        }
        Ok(())
    }
}

/// Whether a magic packet may be sent to `addr`.
///
/// A wake target has to be somewhere a magic packet is meaningful: the
/// limited broadcast, and the ranges a LAN or a routed internal segment
/// actually uses — which covers every real use of this field, including
/// waking a machine across a VPN into a private range.
///
/// Refused: public unicast, loopback, multicast. Not because a magic packet
/// there would do damage, but because this field arrives from files —
/// `sessions.json`, and `vault_import`'s plaintext half — and an
/// unconstrained address plus an unconstrained port turns `send` into a UDP
/// sender pointed wherever a planted bundle says. It is write-only and the
/// payload is a fixed shape, so it's not much of a primitive; it is still the
/// victim's network position offered to whoever wrote the file, every
/// `RETRY_INTERVAL`, for the length of the wait.
///
/// The one legitimate case refused is a LAN on public address space — some
/// universities and older allocations. If that ever comes up it wants an
/// explicit setting, not a permissive default.
fn is_wakeable(addr: Ipv4Addr) -> bool {
    addr == Ipv4Addr::BROADCAST
        || addr.is_private()    // 10/8, 172.16/12, 192.168/16
        || addr.is_link_local() // 169.254/16
        // Carrier-grade NAT, 100.64/10 — what Tailscale and similar hand out,
        // so a wake across an overlay lands here rather than in RFC 1918.
        || matches!(addr.octets(), [100, b, _, _] if (64..128).contains(&b))
        // Loopback is refused above, which the tests would fail on: they send
        // to a socket on 127.0.0.1 precisely so nothing leaves the machine.
        // The alternative is a test that broadcasts for real, which is worse.
        || (cfg!(test) && addr.is_loopback())
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

/// How long a single reachability probe is given. Short: this runs before
/// every wake-enabled connection, including the overwhelmingly common case of
/// a host that's already up, and two seconds is far past a LAN round trip
/// while still being under what anyone would notice.
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

/// Gap between magic packets while waiting. Each round re-sends rather than
/// sending once and only polling: the first packet can land while the NIC is
/// still in a state that ignores it, and a 102-byte broadcast every few
/// seconds costs nothing worth economising on.
const RETRY_INTERVAL: Duration = Duration::from_secs(3);

/// Wakes `host` if it needs waking, and doesn't return until it answers on
/// `port` or the configured wait runs out.
///
/// The opening probe is the load-bearing part. Without it this would fire a
/// magic packet at a machine that's already up on every single connection,
/// which is both pointless traffic and — for anyone watching a switch — a
/// puzzling thing to see. With it, leaving a MAC configured on a profile
/// permanently costs one round trip and nothing else.
///
/// A wake that times out is an error, so the pane says "did not wake" rather
/// than falling through to a TCP connect that will fail again a minute later
/// with something far less informative.
pub async fn wake_and_wait(
    host: &str,
    port: u16,
    wake: &WakeOnLan,
    events: &mpsc::Sender<ConnectionEvent>,
) -> Result<(), String> {
    // Up front, before the probe: a malformed MAC is a configuration mistake,
    // and making the user wait two seconds to be told so would be strange.
    parse_mac(&wake.mac)?;
    wake.broadcast_addr()?;

    if port_open(host, port, PROBE_TIMEOUT).await {
        return Ok(());
    }

    // Only announced once we know we're actually going to wake something —
    // the pane shouldn't flicker through "Waking" for a host that was up.
    let _ = events
        .send(ConnectionEvent::Status(ConnectionStatus::Waking))
        .await;

    let deadline = Instant::now() + wake.wait();
    loop {
        send(wake)?;

        // A zero wait means "send it and get on with it" — the connect
        // attempt that follows is then the thing that decides whether the
        // host is there, which is the same answer this loop would give, just
        // without the wait the user asked not to have.
        if Instant::now() >= deadline {
            return Ok(());
        }

        tokio::time::sleep(RETRY_INTERVAL).await;
        if port_open(host, port, PROBE_TIMEOUT).await {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "{host} did not answer on port {port} within {}s of being sent a magic packet",
                wake.wait().as_secs()
            ));
        }
    }
}

/// Sends a saved session's magic packet and returns, without waiting for the
/// host or connecting to it.
///
/// The deliberate half of the feature, for the times you want the machine up
/// but aren't about to open a terminal on it. It doesn't probe first — asking
/// for this is asking for a packet, and suppressing it because the host looked
/// up would just be confusing.
#[tauri::command]
pub async fn wake_host(app: tauri::AppHandle, profile_id: String) -> Result<(), String> {
    let profile = crate::profiles::get_profile(&app, &profile_id)?;
    let wake = profile
        .wake_on_lan
        .ok_or("this session has no MAC address saved — add one by editing it")?;
    send(&wake)
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

    /// The addresses this field is actually for: the limited broadcast, a
    /// directed broadcast on each of the private ranges, link-local, and the
    /// CGNAT range an overlay network hands out.
    #[test]
    fn the_ranges_a_lan_uses_are_wakeable() {
        for text in [
            "255.255.255.255",
            "192.168.1.255",
            "10.255.255.255",
            "172.16.5.255",
            "169.254.255.255",
            "100.64.0.255",
        ] {
            let wake = WakeOnLan {
                mac: "aa:bb:cc:dd:ee:ff".into(),
                broadcast: Some(text.into()),
                port: None,
                wait_seconds: None,
            };
            assert_eq!(
                wake.broadcast_addr().unwrap(),
                text.parse::<Ipv4Addr>().unwrap()
            );
        }
    }

    /// See `is_wakeable`: the field arrives from an importable file, and
    /// `send` is otherwise 102 bytes to any address and port the file names.
    #[test]
    fn an_address_a_magic_packet_doesnt_belong_at_is_refused() {
        for text in [
            "8.8.8.8",         // public unicast
            "224.0.0.1",       // multicast
            "239.255.255.250", // multicast, and something that does listen
            "100.128.0.1",     // just past CGNAT, so public
            "0.0.0.0",
        ] {
            let wake = WakeOnLan {
                mac: "aa:bb:cc:dd:ee:ff".into(),
                broadcast: Some(text.into()),
                port: None,
                wait_seconds: None,
            };
            assert!(wake.broadcast_addr().is_err(), "accepted {text}");
            assert!(wake.validate().is_err(), "validate accepted {text}");
        }
    }

    /// The clamp is the thing that stops a stored number becoming either a
    /// year-long send loop or a panic in `Instant::add`.
    #[test]
    fn an_absurd_wait_is_clamped_rather_than_honoured() {
        let mut wake = WakeOnLan {
            mac: "aa:bb:cc:dd:ee:ff".into(),
            broadcast: None,
            port: None,
            wait_seconds: Some(u64::MAX),
        };
        assert_eq!(wake.wait(), Duration::from_secs(MAX_WAIT_SECONDS));
        // Still usable if it arrived from an import — but refused at the
        // boundary, so whoever typed it is told rather than quietly overruled.
        assert!(wake.validate().is_err());

        wake.wait_seconds = Some(120);
        assert_eq!(wake.wait(), Duration::from_secs(120));
        assert!(wake.validate().is_ok());
    }

    /// The clamped deadline has to be one `Instant` can hold, which is the
    /// whole point — this panicked before the `min`.
    #[test]
    fn the_clamped_wait_makes_a_deadline_that_doesnt_panic() {
        let wake = WakeOnLan {
            mac: "aa:bb:cc:dd:ee:ff".into(),
            broadcast: None,
            port: None,
            wait_seconds: Some(u64::MAX),
        };
        let _ = std::time::Instant::now() + wake.wait();
    }

    #[test]
    fn validate_refuses_a_mac_that_isnt_one() {
        assert!(WakeOnLan {
            mac: "the printer in the corner".into(),
            broadcast: None,
            port: None,
            wait_seconds: None,
        }
        .validate()
        .is_err());
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

    /// A UDP socket on loopback standing in for the target's NIC, so the wake
    /// tests can assert what was sent without anything reaching the network.
    fn packet_sink() -> (UdpSocket, WakeOnLan) {
        let sink = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        sink.set_nonblocking(true).unwrap();
        let port = sink.local_addr().unwrap().port();
        let wake = WakeOnLan {
            mac: "aa:bb:cc:dd:ee:ff".into(),
            broadcast: Some(Ipv4Addr::LOCALHOST.to_string()),
            port: Some(port),
            wait_seconds: None,
        };
        (sink, wake)
    }

    fn packets_received(sink: &UdpSocket) -> usize {
        let mut buf = [0u8; 128];
        std::iter::from_fn(|| sink.recv_from(&mut buf).ok()).count()
    }

    /// A port that nothing is listening on, by taking one and giving it back.
    async fn closed_port() -> u16 {
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        listener.local_addr().unwrap().port()
    }

    /// The reason a MAC can be left on a profile permanently: connecting to a
    /// host that's already up sends nothing and says nothing.
    #[tokio::test]
    async fn an_already_awake_host_is_left_alone() {
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let (sink, wake) = packet_sink();
        let (tx, mut rx) = mpsc::channel(8);

        wake_and_wait("127.0.0.1", port, &wake, &tx).await.unwrap();

        assert_eq!(packets_received(&sink), 0);
        assert!(
            rx.try_recv().is_err(),
            "announced a wake that didn't happen"
        );
    }

    /// The pane has to be told what the pause is for, or a minute of silence
    /// looks like a hung client.
    #[tokio::test(start_paused = true)]
    async fn a_host_that_never_answers_is_announced_then_given_up_on() {
        let port = closed_port().await;
        let (sink, mut wake) = packet_sink();
        wake.wait_seconds = Some(1);
        let (tx, mut rx) = mpsc::channel(8);

        let error = wake_and_wait("127.0.0.1", port, &wake, &tx)
            .await
            .unwrap_err();

        assert!(error.contains("did not answer"), "{error}");
        assert!(packets_received(&sink) >= 1, "gave up without sending one");
        assert!(matches!(
            rx.try_recv(),
            Ok(ConnectionEvent::Status(ConnectionStatus::Waking))
        ));
    }

    /// See `wake_and_wait`: a zero wait is "send it and get on with it", not
    /// an instant failure.
    #[tokio::test]
    async fn a_zero_wait_sends_the_packet_and_carries_on() {
        let port = closed_port().await;
        let (sink, mut wake) = packet_sink();
        wake.wait_seconds = Some(0);
        let (tx, _rx) = mpsc::channel(8);

        wake_and_wait("127.0.0.1", port, &wake, &tx).await.unwrap();

        assert_eq!(packets_received(&sink), 1);
    }

    /// Checked before the probe, so a typo'd MAC is reported at once rather
    /// than after a wait the user then has to interpret.
    #[tokio::test]
    async fn a_config_that_cant_be_sent_fails_before_anything_is_probed() {
        let (tx, mut rx) = mpsc::channel(8);
        let wake = WakeOnLan {
            mac: "not a mac".into(),
            broadcast: None,
            port: None,
            wait_seconds: None,
        };

        assert!(wake_and_wait("203.0.113.1", 22, &wake, &tx).await.is_err());
        assert!(rx.try_recv().is_err());
    }
}
