//! Minimal SOCKS5 (RFC 1928) server: CONNECT command only, no
//! authentication — sufficient for a local "dynamic forward" proxy where
//! the only client is the user's own browser/tools on localhost.

use std::net::{Ipv4Addr, Ipv6Addr};

pub const VERSION: u8 = 0x05;
pub const CMD_CONNECT: u8 = 0x01;
pub const ATYP_IPV4: u8 = 0x01;
pub const ATYP_DOMAIN: u8 = 0x03;
pub const ATYP_IPV6: u8 = 0x04;
pub const METHOD_NO_AUTH: u8 = 0x00;
pub const METHOD_NONE_ACCEPTABLE: u8 = 0xFF;

pub const REPLY_SUCCEEDED: u8 = 0x00;
pub const REPLY_COMMAND_NOT_SUPPORTED: u8 = 0x07;
pub const REPLY_ADDRESS_TYPE_NOT_SUPPORTED: u8 = 0x08;
pub const REPLY_CONNECTION_REFUSED: u8 = 0x05;

#[derive(Debug, PartialEq, Eq)]
pub enum SocksError {
    UnsupportedVersion(u8),
    UnsupportedCommand(u8),
    UnsupportedAddressType(u8),
    NoAcceptableMethod,
}

pub fn validate_version(ver: u8) -> Result<(), SocksError> {
    if ver == VERSION {
        Ok(())
    } else {
        Err(SocksError::UnsupportedVersion(ver))
    }
}

pub fn validate_command(cmd: u8) -> Result<(), SocksError> {
    if cmd == CMD_CONNECT {
        Ok(())
    } else {
        Err(SocksError::UnsupportedCommand(cmd))
    }
}

/// Picks our one supported auth method (none) from the client's offered
/// list, per RFC 1928 §3 — `0xFF` if `NO_AUTH` wasn't offered.
pub fn select_method(offered: &[u8]) -> Result<u8, SocksError> {
    if offered.contains(&METHOD_NO_AUTH) {
        Ok(METHOD_NO_AUTH)
    } else {
        Err(SocksError::NoAcceptableMethod)
    }
}

/// Decodes the address+port that follow the ATYP byte in a SOCKS5 request.
/// `body` must be exactly the right length for `atyp` (4+2 for IPv4, 16+2
/// for IPv6, 1+len+2 for a domain name) — the caller reads that many bytes
/// off the wire before calling this, since the length itself depends on
/// `atyp`/the embedded domain-length byte.
pub fn decode_address(atyp: u8, body: &[u8]) -> Result<(String, u16), SocksError> {
    match atyp {
        ATYP_IPV4 => {
            if body.len() != 6 {
                return Err(SocksError::UnsupportedAddressType(atyp));
            }
            let addr = Ipv4Addr::new(body[0], body[1], body[2], body[3]);
            let port = u16::from_be_bytes([body[4], body[5]]);
            Ok((addr.to_string(), port))
        }
        ATYP_IPV6 => {
            if body.len() != 18 {
                return Err(SocksError::UnsupportedAddressType(atyp));
            }
            let mut octets = [0u8; 16];
            octets.copy_from_slice(&body[..16]);
            let addr = Ipv6Addr::from(octets);
            let port = u16::from_be_bytes([body[16], body[17]]);
            Ok((addr.to_string(), port))
        }
        ATYP_DOMAIN => {
            if body.is_empty() {
                return Err(SocksError::UnsupportedAddressType(atyp));
            }
            let len = body[0] as usize;
            if body.len() != 1 + len + 2 {
                return Err(SocksError::UnsupportedAddressType(atyp));
            }
            let name = String::from_utf8_lossy(&body[1..1 + len]).into_owned();
            let port = u16::from_be_bytes([body[1 + len], body[2 + len]]);
            Ok((name, port))
        }
        other => Err(SocksError::UnsupportedAddressType(other)),
    }
}

/// Length of the address+port body that follows ATYP, given the ATYP byte
/// and (for domain names) the length-prefix byte that comes right after it.
pub fn body_len(atyp: u8, domain_len: u8) -> Option<usize> {
    match atyp {
        ATYP_IPV4 => Some(6),
        ATYP_IPV6 => Some(18),
        ATYP_DOMAIN => Some(1 + domain_len as usize + 2),
        _ => None,
    }
}

/// A "success" reply with a placeholder bound address — real SOCKS5 clients
/// don't rely on this field once the CONNECT succeeds, only on the reply
/// code, so `0.0.0.0:0` (rather than tracking russh's actual ephemeral
/// remote-side port) is standard practice for tunneling proxies.
pub fn reply(code: u8) -> [u8; 10] {
    [VERSION, code, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_ipv4_address() {
        let body = [127, 0, 0, 1, 0x1F, 0x90]; // 127.0.0.1:8080
        let (host, port) = decode_address(ATYP_IPV4, &body).unwrap();
        assert_eq!(host, "127.0.0.1");
        assert_eq!(port, 8080);
    }

    #[test]
    fn decodes_ipv6_address() {
        let mut body = [0u8; 18];
        body[15] = 1; // ::1
        body[16] = 0x00;
        body[17] = 0x50; // port 80
        let (host, port) = decode_address(ATYP_IPV6, &body).unwrap();
        assert_eq!(host, "::1");
        assert_eq!(port, 80);
    }

    #[test]
    fn decodes_domain_name() {
        let mut body = vec![11u8]; // length
        body.extend_from_slice(b"example.com");
        body.extend_from_slice(&443u16.to_be_bytes());
        let (host, port) = decode_address(ATYP_DOMAIN, &body).unwrap();
        assert_eq!(host, "example.com");
        assert_eq!(port, 443);
    }

    #[test]
    fn rejects_wrong_length_ipv4_body() {
        assert_eq!(
            decode_address(ATYP_IPV4, &[1, 2, 3]),
            Err(SocksError::UnsupportedAddressType(ATYP_IPV4))
        );
    }

    #[test]
    fn rejects_unknown_atyp() {
        assert_eq!(
            decode_address(0x02, &[0, 0]),
            Err(SocksError::UnsupportedAddressType(0x02))
        );
    }

    #[test]
    fn body_len_matches_decodeable_sizes() {
        assert_eq!(body_len(ATYP_IPV4, 0), Some(6));
        assert_eq!(body_len(ATYP_IPV6, 0), Some(18));
        assert_eq!(body_len(ATYP_DOMAIN, 11), Some(14));
    }

    #[test]
    fn validate_version_accepts_5_rejects_others() {
        assert_eq!(validate_version(0x05), Ok(()));
        assert_eq!(
            validate_version(0x04),
            Err(SocksError::UnsupportedVersion(4))
        );
    }

    #[test]
    fn validate_command_accepts_connect_rejects_others() {
        assert_eq!(validate_command(CMD_CONNECT), Ok(()));
        assert_eq!(
            validate_command(0x02), // BIND
            Err(SocksError::UnsupportedCommand(0x02))
        );
    }

    #[test]
    fn select_method_picks_no_auth_when_offered() {
        assert_eq!(
            select_method(&[0x01, METHOD_NO_AUTH, 0x02]),
            Ok(METHOD_NO_AUTH)
        );
    }

    #[test]
    fn select_method_fails_when_no_auth_not_offered() {
        assert_eq!(
            select_method(&[0x01, 0x02]),
            Err(SocksError::NoAcceptableMethod)
        );
    }
}
