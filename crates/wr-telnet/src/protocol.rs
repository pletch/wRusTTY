//! RFC 854 (Telnet Protocol) + RFC 1073 (NAWS) + RFC 1091 (Terminal Type),
//! hand-rolled: the option-negotiation subset we need is small, and pulling
//! in a full telnet crate for it would be a heavier dependency than the
//! protocol itself.

pub const IAC: u8 = 255;
pub const DONT: u8 = 254;
pub const DO: u8 = 253;
pub const WONT: u8 = 252;
pub const WILL: u8 = 251;
pub const SB: u8 = 250;
pub const SE: u8 = 240;

pub const OPT_ECHO: u8 = 1;
pub const OPT_SUPPRESS_GO_AHEAD: u8 = 3;
pub const OPT_TERMINAL_TYPE: u8 = 24;
pub const OPT_NAWS: u8 = 31;

pub const TTYPE_SEND: u8 = 1;
pub const TTYPE_IS: u8 = 0;

/// What the caller needs to react to as bytes are parsed.
#[derive(Debug, Default)]
pub struct ParseOutput {
    /// Plain data bytes (IAC IAC already unescaped to a single 0xFF).
    pub data: Vec<u8>,
    /// Raw negotiation reply bytes to write straight back to the peer.
    pub replies: Vec<u8>,
    /// Server asked us to send our terminal type (IAC SB TTYPE SEND IAC SE).
    pub terminal_type_requested: bool,
    /// Server accepted NAWS (DO NAWS) — caller should push the current
    /// terminal size now, since NAWS is otherwise client-initiated.
    pub naws_accepted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Data,
    Iac,
    Negotiation(u8),
    SubnegOption,
    Subneg(u8),
    SubnegIac(u8),
}

/// The subnegotiations we actually consume (terminal-type SEND) are a few
/// bytes; anything approaching this is a broken or hostile peer that opened
/// `IAC SB` and never sent `IAC SE`, which would otherwise buffer the rest
/// of the connection's bytes into memory forever. On overflow the
/// subnegotiation is abandoned and parsing resumes as plain data.
const MAX_SUBNEG_LEN: usize = 4096;

/// Incremental parser: feed it arbitrary-sized chunks and it survives IAC
/// sequences split across reads (TCP gives no framing guarantees).
#[derive(Debug)]
pub struct Parser {
    state: State,
    subneg_buf: Vec<u8>,
}

impl Default for Parser {
    fn default() -> Self {
        Self {
            state: State::Data,
            subneg_buf: Vec::new(),
        }
    }
}

impl Parser {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn feed(&mut self, input: &[u8]) -> ParseOutput {
        let mut out = ParseOutput::default();

        for &byte in input {
            match self.state {
                State::Data => {
                    if byte == IAC {
                        self.state = State::Iac;
                    } else {
                        out.data.push(byte);
                    }
                }
                State::Iac => match byte {
                    IAC => {
                        out.data.push(IAC);
                        self.state = State::Data;
                    }
                    WILL | WONT | DO | DONT => {
                        self.state = State::Negotiation(byte);
                    }
                    SB => {
                        self.state = State::SubnegOption;
                    }
                    _ => {
                        // Single-byte commands (NOP, AYT, GA, ...) we don't
                        // act on; just resume normal data parsing.
                        self.state = State::Data;
                    }
                },
                State::Negotiation(cmd) => {
                    let option = byte;
                    if let Some(reply) = negotiate(cmd, option) {
                        out.replies.extend_from_slice(&reply);
                    }
                    if cmd == DO && option == OPT_NAWS {
                        out.naws_accepted = true;
                    }
                    self.state = State::Data;
                }
                State::SubnegOption => {
                    self.subneg_buf.clear();
                    self.state = State::Subneg(byte);
                }
                State::Subneg(option) => {
                    if byte == IAC {
                        self.state = State::SubnegIac(option);
                    } else if self.subneg_buf.len() >= MAX_SUBNEG_LEN {
                        self.subneg_buf.clear();
                        self.state = State::Data;
                    } else {
                        self.subneg_buf.push(byte);
                    }
                }
                State::SubnegIac(option) => match byte {
                    SE => {
                        if option == OPT_TERMINAL_TYPE
                            && self.subneg_buf.first() == Some(&TTYPE_SEND)
                        {
                            out.terminal_type_requested = true;
                        }
                        self.subneg_buf.clear();
                        self.state = State::Data;
                    }
                    IAC => {
                        if self.subneg_buf.len() >= MAX_SUBNEG_LEN {
                            self.subneg_buf.clear();
                            self.state = State::Data;
                        } else {
                            self.subneg_buf.push(IAC);
                            self.state = State::Subneg(option);
                        }
                    }
                    _ => {
                        // Malformed (IAC followed by neither SE nor IAC
                        // inside a subnegotiation) — bail back to Data
                        // rather than getting stuck.
                        self.subneg_buf.clear();
                        self.state = State::Data;
                    }
                },
            }
        }

        out
    }
}

/// Our negotiation policy: accept the handful of options we actually use,
/// refuse everything else (RFC 854's specified safe default).
fn negotiate(cmd: u8, option: u8) -> Option<[u8; 3]> {
    match (cmd, option) {
        (WILL, OPT_ECHO) => Some(reply(DO, OPT_ECHO)),
        (WILL, OPT_SUPPRESS_GO_AHEAD) => Some(reply(DO, OPT_SUPPRESS_GO_AHEAD)),
        (DO, OPT_TERMINAL_TYPE) => Some(reply(WILL, OPT_TERMINAL_TYPE)),
        (DO, OPT_NAWS) => Some(reply(WILL, OPT_NAWS)),
        (WILL, _) => Some(reply(DONT, option)),
        (DO, _) => Some(reply(WONT, option)),
        // WONT/DONT need no reply unless we're revoking a previously
        // accepted option, which we never initiate.
        _ => None,
    }
}

fn reply(cmd: u8, option: u8) -> [u8; 3] {
    [IAC, cmd, option]
}

/// Doubles any literal 0xFF bytes in outgoing data, per RFC 854 — required
/// so raw IAC bytes in user input/paste can't be mistaken for a command.
pub fn escape_data(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    for &b in data {
        out.push(b);
        if b == IAC {
            out.push(IAC);
        }
    }
    out
}

pub fn encode_naws(cols: u16, rows: u16) -> Vec<u8> {
    let [w_hi, w_lo] = cols.to_be_bytes();
    let [h_hi, h_lo] = rows.to_be_bytes();
    let mut out = vec![IAC, SB, OPT_NAWS];
    for b in [w_hi, w_lo, h_hi, h_lo] {
        out.push(b);
        if b == IAC {
            out.push(IAC); // escape a size byte that happens to equal 0xFF
        }
    }
    out.extend_from_slice(&[IAC, SE]);
    out
}

pub fn encode_terminal_type(term: &str) -> Vec<u8> {
    let mut out = vec![IAC, SB, OPT_TERMINAL_TYPE, TTYPE_IS];
    out.extend_from_slice(&escape_data(term.as_bytes()));
    out.extend_from_slice(&[IAC, SE]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A peer that opens `IAC SB` and never closes it must not buffer the
    /// rest of the connection into memory — the parser abandons the
    /// subnegotiation at the cap and resumes treating bytes as data.
    #[test]
    fn unterminated_subnegotiation_is_capped_not_buffered_forever() {
        let mut p = Parser::new();
        let out = p.feed(&[IAC, SB, OPT_TERMINAL_TYPE]);
        assert!(out.data.is_empty());

        let flood = vec![b'x'; MAX_SUBNEG_LEN * 3];
        let out = p.feed(&flood);
        assert!(p.subneg_buf.len() <= MAX_SUBNEG_LEN);
        // Everything past the cap resumes flowing as plain data (the byte
        // that tripped the cap is discarded along with the abandoned
        // subnegotiation, hence the extra -1).
        assert_eq!(out.data.len(), flood.len() - MAX_SUBNEG_LEN - 1);

        // And the parser is genuinely back to normal afterwards.
        let out = p.feed(b"hello");
        assert_eq!(out.data, b"hello");
    }

    #[test]
    fn plain_data_passes_through() {
        let mut p = Parser::new();
        let out = p.feed(b"hello world");
        assert_eq!(out.data, b"hello world");
        assert!(out.replies.is_empty());
    }

    #[test]
    fn escaped_iac_becomes_single_0xff() {
        let mut p = Parser::new();
        let out = p.feed(&[b'a', IAC, IAC, b'b']);
        assert_eq!(out.data, vec![b'a', 0xFF, b'b']);
    }

    #[test]
    fn will_echo_is_accepted_with_do() {
        let mut p = Parser::new();
        let out = p.feed(&[IAC, WILL, OPT_ECHO]);
        assert_eq!(out.replies, vec![IAC, DO, OPT_ECHO]);
        assert!(out.data.is_empty());
    }

    #[test]
    fn unsupported_will_is_refused_with_dont() {
        let mut p = Parser::new();
        let out = p.feed(&[IAC, WILL, 99]);
        assert_eq!(out.replies, vec![IAC, DONT, 99]);
    }

    #[test]
    fn unsupported_do_is_refused_with_wont() {
        let mut p = Parser::new();
        let out = p.feed(&[IAC, DO, 99]);
        assert_eq!(out.replies, vec![IAC, WONT, 99]);
    }

    #[test]
    fn do_naws_is_flagged_for_caller() {
        let mut p = Parser::new();
        let out = p.feed(&[IAC, DO, OPT_NAWS]);
        assert!(out.naws_accepted);
        assert_eq!(out.replies, vec![IAC, WILL, OPT_NAWS]);
    }

    #[test]
    fn negotiation_split_across_feed_calls() {
        let mut p = Parser::new();
        let out1 = p.feed(&[IAC, WILL]);
        assert!(out1.replies.is_empty());
        let out2 = p.feed(&[OPT_ECHO]);
        assert_eq!(out2.replies, vec![IAC, DO, OPT_ECHO]);
    }

    #[test]
    fn terminal_type_send_request_is_detected() {
        let mut p = Parser::new();
        let out = p.feed(&[IAC, SB, OPT_TERMINAL_TYPE, TTYPE_SEND, IAC, SE]);
        assert!(out.terminal_type_requested);
    }

    #[test]
    fn subnegotiation_split_across_feed_calls() {
        let mut p = Parser::new();
        p.feed(&[IAC, SB, OPT_TERMINAL_TYPE]);
        p.feed(&[TTYPE_SEND]);
        let out = p.feed(&[IAC, SE]);
        assert!(out.terminal_type_requested);
    }

    #[test]
    fn data_around_negotiation_is_preserved_in_order() {
        let mut p = Parser::new();
        let out = p.feed(&[b'x', IAC, WILL, OPT_ECHO, b'y']);
        assert_eq!(out.data, vec![b'x', b'y']);
        assert_eq!(out.replies, vec![IAC, DO, OPT_ECHO]);
    }

    #[test]
    fn naws_encoding_matches_wire_format() {
        let bytes = encode_naws(80, 24);
        assert_eq!(bytes, vec![IAC, SB, OPT_NAWS, 0, 80, 0, 24, IAC, SE]);
    }

    #[test]
    fn terminal_type_encoding_matches_wire_format() {
        let bytes = encode_terminal_type("xterm");
        assert_eq!(
            bytes,
            vec![
                IAC,
                SB,
                OPT_TERMINAL_TYPE,
                TTYPE_IS,
                b'x',
                b't',
                b'e',
                b'r',
                b'm',
                IAC,
                SE
            ]
        );
    }

    #[test]
    fn escape_data_doubles_0xff() {
        assert_eq!(escape_data(&[1, IAC, 2]), vec![1, IAC, IAC, 2]);
    }
}
