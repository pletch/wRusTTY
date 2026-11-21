//! Tells the session registry when this machine's network changes, as
//! `NetworkWatch.kt` does on Android. A TCP connection is bound to the address it
//! started from, so turning Wi-Fi off kills sessions opened over it even with
//! Ethernet up. Unwatched, they can sit dead until keepalives run out, about three
//! minutes. Told, the registry pings each live session right away and reconnects
//! the ones that don't answer. A session waiting to retry tries again at once, with
//! a fresh budget.
//!
//! The signal is a local unicast address being added or removed: what an adapter
//! joining or leaving a network looks like from here. The desktop never reports
//! "offline": with no network a retry fails fast, and the address coming back
//! retries again.

use std::sync::mpsc;
use std::sync::OnceLock;
use std::time::Duration;

use windows::Win32::Foundation::{HANDLE, NO_ERROR};
use windows::Win32::NetworkManagement::IpHelper::{
    MibAddInstance, MibDeleteInstance, NotifyUnicastIpAddressChange, MIB_NOTIFICATION_TYPE,
    MIB_UNICASTIPADDRESS_ROW,
};
use windows::Win32::Networking::WinSock::AF_UNSPEC;

/// Changes come in bursts (IPv4 and IPv6, several addresses each, DAD), so they are
/// collected until the network has been quiet this long, then reported once.
const SETTLE: Duration = Duration::from_secs(1);

static EVENTS: OnceLock<mpsc::Sender<()>> = OnceLock::new();

/// Runs on a system thread pool thread, so it only hands the event off.
unsafe extern "system" fn on_address_change(
    _context: *const core::ffi::c_void,
    _row: *const MIB_UNICASTIPADDRESS_ROW,
    kind: MIB_NOTIFICATION_TYPE,
) {
    // Parameter changes (lifetimes ticking down, DAD state) aren't a new network.
    if kind == MibAddInstance || kind == MibDeleteInstance {
        if let Some(events) = EVENTS.get() {
            let _ = events.send(());
        }
    }
}

/// Starts watching for the life of the process. Failing to start only costs the
/// faster recovery, so it is logged rather than returned.
pub fn start() {
    let (tx, rx) = mpsc::channel::<()>();
    if EVENTS.set(tx).is_err() {
        return;
    }

    let mut handle = HANDLE::default();
    // SAFETY: the callback is a plain function that touches only a static, and the
    // handle is never canceled, so the registration outlives every callback.
    let status = unsafe {
        NotifyUnicastIpAddressChange(AF_UNSPEC, Some(on_address_change), None, false, &mut handle)
    };
    if status != NO_ERROR {
        log::warn!("network watch: could not register for address changes: {status:?}");
        return;
    }

    let spawned = std::thread::Builder::new()
        .name("network-watch".into())
        .spawn(move || {
            while rx.recv().is_ok() {
                while rx.recv_timeout(SETTLE).is_ok() {}
                log::info!("network watch: local addresses changed");
                crate::session_registry::network_changed(true);
            }
        });
    if let Err(e) = spawned {
        log::warn!("network watch: could not start its thread: {e}");
    }
}
