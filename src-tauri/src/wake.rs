//! Wake-on-LAN: the magic packet, and the TCP probe that says whether one is
//! needed. Lives here rather than in a crate (std UDP plus one tokio connect),
//! at the layer that knows which host a session is for.
//!
//! `wake_and_wait` is the policy: probe first so an awake host is never sent
//! anything, re-send while waiting (a NIC leaving deep sleep can miss the first
//! packet), and give up at a deadline. Cancellation when a pane closes is
//! `session_registry`'s job.

use std::net::{Ipv4Addr, UdpSocket};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio::time::Instant;
use wr_core::{ConnectionEvent, ConnectionStatus};

/// The conventional magic-packet port (the NIC matches the payload anywhere,
/// so it's only convention; some gear uses 7).
pub const DEFAULT_PORT: u16 = 9;

/// Default target: the limited broadcast, which never leaves the local segment.
pub const DEFAULT_BROADCAST: Ipv4Addr = Ipv4Addr::BROADCAST;

/// Default wait for a woken host to answer; covers a slow Windows box resuming
/// from S4.
pub const DEFAULT_WAIT_SECONDS: u64 = 60;

/// The longest wait a stored profile may ask for. The value comes from
/// editable or imported files, and unbounded it could loop for a year or panic
/// in `Instant + Duration` (wedging the session in `Connecting`). Clamped at
/// use so imported profiles still work; `validate` reports it to whoever typed
/// it.
pub const MAX_WAIT_SECONDS: u64 = 600;

/// What to send, and where. `None` means the default, so a MAC-only profile
/// stores just the MAC.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeOnLan {
    /// In any common notation; see `parse_mac`.
    pub mac: String,
    /// Where to broadcast. `None` is 255.255.255.255 (local segment only); a
    /// directed broadcast (`192.168.1.255`) reaches another segment and pins the
    /// interface; see `send`.
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

    /// Clamped to `MAX_WAIT_SECONDS`.
    pub fn wait(&self) -> Duration {
        Duration::from_secs(
            self.wait_seconds
                .unwrap_or(DEFAULT_WAIT_SECONDS)
                .min(MAX_WAIT_SECONDS),
        )
    }

    /// The parsed broadcast target. An unparseable address is an error rather than
    /// a silent fallback to the limited broadcast (which would work on the LAN and
    /// fail elsewhere), as is one `is_wakeable` refuses.
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

    /// Checks that need no network: the MAC parses and the target is allowed. Used
    /// when saving a profile and importing a bundle, where the user can still fix
    /// it.
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

/// Whether a magic packet may be sent to `addr`: the limited broadcast, private
/// ranges, link-local and CGNAT. Public unicast, loopback and multicast are
/// refused because the address comes from files (including imported bundles),
/// and an unconstrained address and port would let a planted file aim UDP
/// anywhere from the victim's network. A LAN on public address space would need
/// an explicit setting.
fn is_wakeable(addr: Ipv4Addr) -> bool {
    addr == Ipv4Addr::BROADCAST
        || addr.is_private()    // 10/8, 172.16/12, 192.168/16
        || addr.is_link_local() // 169.254/16
        // CGNAT (100.64/10), used by Tailscale and similar overlays.
        || matches!(addr.octets(), [100, b, _, _] if (64..128).contains(&b))
        // Tests send to loopback so nothing leaves the machine.
        || (cfg!(test) && addr.is_loopback())
}

/// A MAC as six bytes, from `aa:bb:cc:dd:ee:ff`, `aa-bb-...`, Cisco's
/// `aabb.ccdd.eeff` or bare hex. Separators are just dropped.
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

/// The magic packet: six `0xFF` bytes, then the MAC sixteen times (102 bytes).
fn magic_packet(mac: [u8; 6]) -> [u8; 102] {
    let mut packet = [0xFFu8; 102];
    for chunk in packet[6..].chunks_exact_mut(6) {
        chunk.copy_from_slice(&mac);
    }
    packet
}

/// Broadcasts one magic packet. Binding 0.0.0.0 leaves the interface to the
/// routing table; on a multi-homed machine, a directed broadcast
/// (`WakeOnLan::broadcast`) picks the interface via its subnet.
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

/// Whether `host:port` accepts a connection within `timeout`. Any failure
/// (refused, timeout, DNS) reads as "not up yet".
pub async fn port_open(host: &str, port: u16, timeout: Duration) -> bool {
    matches!(
        tokio::time::timeout(timeout, tokio::net::TcpStream::connect((host, port))).await,
        Ok(Ok(_))
    )
}

/// Timeout for one reachability probe; runs before every wake-enabled connect,
/// so it stays short.
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

/// Gap between magic packets while waiting; each round re-sends in case the
/// NIC ignored an earlier one.
const RETRY_INTERVAL: Duration = Duration::from_secs(3);

/// Wakes `host` if needed and returns once it answers on `port`, or errors when
/// the wait runs out (so the pane says "did not wake" rather than failing the
/// connect later). The opening probe means a MAC left on a profile costs one
/// round trip when the host is already up.
pub async fn wake_and_wait(
    host: &str,
    port: u16,
    wake: &WakeOnLan,
    events: &mpsc::Sender<ConnectionEvent>,
) -> Result<(), String> {
    // Validate before the probe, so config mistakes are reported immediately.
    parse_mac(&wake.mac)?;
    wake.broadcast_addr()?;

    if port_open(host, port, PROBE_TIMEOUT).await {
        return Ok(());
    }

    // Announced only when actually waking.
    let _ = events
        .send(ConnectionEvent::Status(ConnectionStatus::Waking))
        .await;

    let deadline = Instant::now() + wake.wait();
    loop {
        send(wake)?;

        // A zero wait means send once and let the connect decide.
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

/// Sends a saved session's magic packet without waiting or connecting. No
/// probe: the user asked for a packet.
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

    /// The notations people copy from ipconfig, router tables, switches and labels.
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

    /// A malformed MAC wakes nothing, so it's refused at the form.
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

    /// A MAC-only profile just works.
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

    /// A cleared form field means the default.
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

    /// A malformed address is an error, not a fallback.
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

    /// The limited broadcast, private directed broadcasts, link-local and CGNAT.
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

    /// See `is_wakeable`.
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

    /// The clamp prevents a year-long send loop or a panic.
    #[test]
    fn an_absurd_wait_is_clamped_rather_than_honoured() {
        let mut wake = WakeOnLan {
            mac: "aa:bb:cc:dd:ee:ff".into(),
            broadcast: None,
            port: None,
            wait_seconds: Some(u64::MAX),
        };
        assert_eq!(wake.wait(), Duration::from_secs(MAX_WAIT_SECONDS));
        // Usable after import, but refused by `validate`.
        assert!(wake.validate().is_err());

        wake.wait_seconds = Some(120);
        assert_eq!(wake.wait(), Duration::from_secs(120));
        assert!(wake.validate().is_ok());
    }

    /// The clamped deadline fits in an `Instant` (this used to panic).
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

    /// The bytes on the wire, through a real socket (on loopback, so nothing
    /// leaves the machine).
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

    /// "Don't wake a machine that's already up."
    #[tokio::test]
    async fn port_open_sees_something_listening() {
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(port_open("127.0.0.1", port, Duration::from_secs(2)).await);
    }

    #[tokio::test]
    async fn port_open_reports_a_closed_port_as_closed() {
        let port = closed_port().await;
        assert!(!port_open("127.0.0.1", port, Duration::from_secs(2)).await);
    }

    /// A host that never answers doesn't hold the connect path past the timeout.
    #[tokio::test]
    async fn port_open_gives_up_after_the_timeout() {
        // TEST-NET-3 is routed nowhere, so this can only time out.
        assert!(!port_open("203.0.113.1", 22, Duration::from_millis(200)).await);
    }

    /// A loopback UDP socket standing in for the target's NIC.
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

    /// Where [`closed_port`] looks: below the OS ephemeral ranges (49152+ on
    /// Windows, 32768+ on typical Linux), above 1024, and away from round-number
    /// services.
    const CLOSED_PORT_BAND: std::ops::Range<u16> = 20480..20736;

    /// A loopback TCP port nothing is listening on, taken from outside the
    /// ephemeral range so a concurrent ephemeral allocation can't reuse it. Binding
    /// first proves it's free. Each call gets its own slot (a counter plus the pid,
    /// so separate test binaries start apart) so concurrent tests in this module
    /// don't pick the same port.
    static NEXT_CLOSED_PORT: std::sync::atomic::AtomicUsize =
        std::sync::atomic::AtomicUsize::new(0);

    async fn closed_port() -> u16 {
        let len = CLOSED_PORT_BAND.len();
        let start = std::process::id() as usize
            + NEXT_CLOSED_PORT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        for i in 0..len {
            let port = CLOSED_PORT_BAND.start + ((start + i) % len) as u16;
            if let Ok(listener) = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await {
                drop(listener);
                return port;
            }
        }
        panic!("nothing free in {CLOSED_PORT_BAND:?} — is something listening across the band?");
    }

    /// Connecting to a host that's already up sends nothing and says nothing.
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

    /// The pane is told why it's pausing.
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

    /// A zero wait sends the packet and carries on.
    #[tokio::test]
    async fn a_zero_wait_sends_the_packet_and_carries_on() {
        let port = closed_port().await;
        let (sink, mut wake) = packet_sink();
        wake.wait_seconds = Some(0);
        let (tx, _rx) = mpsc::channel(8);

        wake_and_wait("127.0.0.1", port, &wake, &tx).await.unwrap();

        assert_eq!(packets_received(&sink), 1);
    }

    /// A bad config fails before anything is probed.
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
