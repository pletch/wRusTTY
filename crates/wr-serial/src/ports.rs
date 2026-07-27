use serde::{Deserialize, Serialize};

use crate::error::SerialError;

/// The stable identity of a USB serial adapter, as distinct from the COM
/// number Windows happens to have assigned it today.
///
/// A COM number is a property of *the socket the adapter is plugged into*, not
/// of the adapter: move an FTDI cable to a different USB port and COM4 becomes
/// COM7. That is why saved serial sessions were ruled out — "COM4" is only
/// meaningful until something moves. But the premise is fixable rather than
/// fixed: `tokio_serial` already reports `vid`, `pid` and `serial_number`
/// alongside the manufacturer and product strings this used to keep, and those
/// *are* stable across replug, reboot and a different socket. Storing them
/// turns "COM4" into "the FTDI cable with serial A50285BI", which is what the
/// user meant by it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbIdentity {
    pub vid: u16,
    pub pid: u16,
    /// Absent on cheap adapters — plenty of CH340 and CP2102 clones ship with
    /// no serial number programmed, which is what [`resolve`] has to cope with.
    pub serial_number: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortInfo {
    pub name: String,
    /// USB manufacturer/product strings joined, when the OS reports them —
    /// what makes "COM3" show up as "COM3 (Arduino Uno)" in the picker.
    pub friendly_name: Option<String>,
    /// `None` for anything that isn't USB — a PCI serial card or an on-board
    /// port, which don't move and are correctly identified by name alone.
    pub usb: Option<UsbIdentity>,
}

/// What a saved serial session stores in order to find its port again.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortIdentity {
    /// The port name as it was when the session was saved. The only identity a
    /// non-USB port has, and the tiebreaker for USB adapters that report no
    /// serial number.
    pub port_name: String,
    #[serde(default)]
    pub usb: Option<UsbIdentity>,
}

/// The outcome of matching a saved identity against the ports present now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolved {
    /// Exactly one port matches; connect to it.
    Port(String),
    /// Nothing matches — the adapter isn't plugged in, or it's a different one.
    NotFound,
    /// Several ports are equally good matches, which happens with identical
    /// adapters that report no serial number. Naming them lets the caller ask
    /// rather than guess, since guessing here means opening a console on the
    /// wrong switch.
    Ambiguous(Vec<String>),
}

/// Finds the port a saved session meant, among the ports present now.
///
/// In order of confidence:
///
/// 1. **VID + PID + serial number.** Unique in practice, and stable across
///    replug, reboot and a different socket. This is the case the whole feature
///    exists for.
/// 2. **VID + PID, when the adapter reports no serial number.** Identifies the
///    *model*, not the unit. With one such adapter attached that is
///    unambiguous. With several, the stored port name breaks the tie if it is
///    still present — that adapter probably didn't move — and otherwise the
///    caller is told it's ambiguous rather than handed a guess.
/// 3. **Port name.** For non-USB ports, which don't move: a PCI serial card
///    stays where it is, so its name is a perfectly good identity. This is also
///    the path for a profile saved before any USB identity was recorded.
///
/// Pure, and takes the port list as an argument, so every branch is testable
/// with no hardware attached.
pub fn resolve(identity: &PortIdentity, available: &[PortInfo]) -> Resolved {
    let Some(want) = &identity.usb else {
        return match available.iter().find(|p| p.name == identity.port_name) {
            Some(port) => Resolved::Port(port.name.clone()),
            None => Resolved::NotFound,
        };
    };

    // A serial number makes this exact. Compared case-insensitively: the same
    // adapter can report `A50285BI` or `a50285bi` depending on which driver
    // enumerated it.
    if let Some(serial) = &want.serial_number {
        let matches: Vec<&PortInfo> = available
            .iter()
            .filter(|p| {
                p.usb.as_ref().is_some_and(|u| {
                    u.vid == want.vid
                        && u.pid == want.pid
                        && u.serial_number
                            .as_deref()
                            .is_some_and(|s| s.eq_ignore_ascii_case(serial))
                })
            })
            .collect();
        return match matches.as_slice() {
            [port] => Resolved::Port(port.name.clone()),
            [] => Resolved::NotFound,
            // Two devices reporting one serial number means a cloned chip,
            // which is common enough with counterfeit FTDI parts to be worth
            // handling. Ask rather than guess.
            many => Resolved::Ambiguous(many.iter().map(|p| p.name.clone()).collect()),
        };
    }

    // No serial number: VID+PID identifies the model only.
    let same_model: Vec<&PortInfo> = available
        .iter()
        .filter(|p| {
            p.usb
                .as_ref()
                .is_some_and(|u| u.vid == want.vid && u.pid == want.pid)
        })
        .collect();

    match same_model.as_slice() {
        [port] => Resolved::Port(port.name.clone()),
        [] => Resolved::NotFound,
        many => {
            // Several identical adapters. If the saved one is still on the
            // same port, that is far more likely to be the right answer than
            // any other — it probably never moved.
            if let Some(port) = many.iter().find(|p| p.name == identity.port_name) {
                return Resolved::Port(port.name.clone());
            }
            Resolved::Ambiguous(many.iter().map(|p| p.name.clone()).collect())
        }
    }
}

pub fn list_ports() -> Result<Vec<PortInfo>, SerialError> {
    let ports = tokio_serial::available_ports()
        .map_err(|e| SerialError::Io(std::io::Error::other(e.to_string())))?;

    Ok(ports
        .into_iter()
        .map(|p| {
            let (friendly_name, usb) = match &p.port_type {
                tokio_serial::SerialPortType::UsbPort(info) => {
                    let parts: Vec<&str> = [info.manufacturer.as_deref(), info.product.as_deref()]
                        .into_iter()
                        .flatten()
                        .collect();
                    let friendly = if parts.is_empty() {
                        None
                    } else {
                        Some(parts.join(" "))
                    };
                    (
                        friendly,
                        Some(UsbIdentity {
                            vid: info.vid,
                            pid: info.pid,
                            serial_number: info.serial_number.clone(),
                        }),
                    )
                }
                _ => (None, None),
            };
            PortInfo {
                name: p.port_name,
                friendly_name,
                usb,
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usb_port(name: &str, vid: u16, pid: u16, serial: Option<&str>) -> PortInfo {
        PortInfo {
            name: name.to_string(),
            friendly_name: None,
            usb: Some(UsbIdentity {
                vid,
                pid,
                serial_number: serial.map(str::to_string),
            }),
        }
    }

    fn plain_port(name: &str) -> PortInfo {
        PortInfo {
            name: name.to_string(),
            friendly_name: None,
            usb: None,
        }
    }

    fn saved(port_name: &str, vid: u16, pid: u16, serial: Option<&str>) -> PortIdentity {
        PortIdentity {
            port_name: port_name.to_string(),
            usb: Some(UsbIdentity {
                vid,
                pid,
                serial_number: serial.map(str::to_string),
            }),
        }
    }

    /// The case the whole feature exists for: the cable moved to a different
    /// socket and came up as a different COM number.
    #[test]
    fn a_serial_numbered_adapter_is_found_on_a_new_com_port() {
        let identity = saved("COM4", 0x0403, 0x6001, Some("A50285BI"));
        let ports = [
            usb_port("COM7", 0x0403, 0x6001, Some("A50285BI")),
            usb_port("COM4", 0x10c4, 0xea60, Some("0001")),
        ];
        assert_eq!(resolve(&identity, &ports), Resolved::Port("COM7".into()));
    }

    /// The same adapter can enumerate with different case depending on which
    /// driver claimed it.
    #[test]
    fn serial_number_comparison_ignores_case() {
        let identity = saved("COM4", 0x0403, 0x6001, Some("a50285bi"));
        let ports = [usb_port("COM9", 0x0403, 0x6001, Some("A50285BI"))];
        assert_eq!(resolve(&identity, &ports), Resolved::Port("COM9".into()));
    }

    /// Unplugged must not mean "connect to whatever else is there" — the
    /// failure mode is a console session on the wrong device.
    #[test]
    fn an_absent_adapter_is_not_found_rather_than_substituted() {
        let identity = saved("COM4", 0x0403, 0x6001, Some("A50285BI"));
        let ports = [usb_port("COM4", 0x0403, 0x6001, Some("DIFFERENT"))];
        assert_eq!(resolve(&identity, &ports), Resolved::NotFound);
    }

    /// Plenty of CH340/CP2102 clones program no serial number at all.
    #[test]
    fn an_adapter_without_a_serial_number_matches_on_model_when_it_is_the_only_one() {
        let identity = saved("COM3", 0x1a86, 0x7523, None);
        let ports = [usb_port("COM8", 0x1a86, 0x7523, None), plain_port("COM1")];
        assert_eq!(resolve(&identity, &ports), Resolved::Port("COM8".into()));
    }

    /// Two identical no-serial adapters: the one still on the saved port is
    /// overwhelmingly likely to be the one that never moved.
    #[test]
    fn identical_adapters_are_disambiguated_by_the_saved_port_name() {
        let identity = saved("COM3", 0x1a86, 0x7523, None);
        let ports = [
            usb_port("COM3", 0x1a86, 0x7523, None),
            usb_port("COM5", 0x1a86, 0x7523, None),
        ];
        assert_eq!(resolve(&identity, &ports), Resolved::Port("COM3".into()));
    }

    /// ...but with no tiebreaker, guessing means opening a console on the
    /// wrong switch. Say so instead.
    #[test]
    fn identical_adapters_with_no_tiebreaker_are_ambiguous() {
        let identity = saved("COM3", 0x1a86, 0x7523, None);
        let ports = [
            usb_port("COM6", 0x1a86, 0x7523, None),
            usb_port("COM7", 0x1a86, 0x7523, None),
        ];
        assert_eq!(
            resolve(&identity, &ports),
            Resolved::Ambiguous(vec!["COM6".into(), "COM7".into()])
        );
    }

    /// A cloned FTDI chip reporting a duplicated serial number is a real
    /// thing, and picking one at random is the wrong answer.
    #[test]
    fn duplicate_serial_numbers_are_ambiguous_rather_than_first_wins() {
        let identity = saved("COM4", 0x0403, 0x6001, Some("A50285BI"));
        let ports = [
            usb_port("COM4", 0x0403, 0x6001, Some("A50285BI")),
            usb_port("COM8", 0x0403, 0x6001, Some("A50285BI")),
        ];
        assert!(matches!(resolve(&identity, &ports), Resolved::Ambiguous(_)));
    }

    /// A PCI serial card doesn't move, so its name is a fine identity — and
    /// this is also the path for a profile saved before USB identity existed.
    #[test]
    fn a_non_usb_port_resolves_by_name() {
        let identity = PortIdentity {
            port_name: "COM1".to_string(),
            usb: None,
        };
        assert_eq!(
            resolve(&identity, &[plain_port("COM1"), plain_port("COM2")]),
            Resolved::Port("COM1".into())
        );
        assert_eq!(resolve(&identity, &[plain_port("COM2")]), Resolved::NotFound);
    }
}
