use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialConfig {
    pub port_name: String,
    pub baud_rate: u32,
    pub data_bits: DataBits,
    pub parity: Parity,
    pub stop_bits: StopBits,
    pub flow_control: FlowControl,
    /// Terminal-emulation settings serial has to handle itself — unlike
    /// SSH/telnet, there's no PTY or remote echo layer underneath.
    pub local_echo: bool,
    pub line_ending: LineEnding,
}

impl Default for SerialConfig {
    fn default() -> Self {
        Self {
            port_name: String::new(),
            baud_rate: 9600,
            data_bits: DataBits::Eight,
            parity: Parity::None,
            stop_bits: StopBits::One,
            flow_control: FlowControl::None,
            local_echo: false,
            line_ending: LineEnding::Cr,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub enum DataBits {
    Five,
    Six,
    Seven,
    Eight,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub enum Parity {
    None,
    Odd,
    Even,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub enum StopBits {
    One,
    Two,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub enum FlowControl {
    None,
    Software,
    Hardware,
}

/// What a bare CR (0x0D) — what a terminal sends for the Enter key —
/// should be translated to on the wire. Only CR bytes are rewritten;
/// everything else (including any literal LF) passes through untouched.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub enum LineEnding {
    Cr,
    Lf,
    CrLf,
}

impl From<DataBits> for tokio_serial::DataBits {
    fn from(v: DataBits) -> Self {
        match v {
            DataBits::Five => tokio_serial::DataBits::Five,
            DataBits::Six => tokio_serial::DataBits::Six,
            DataBits::Seven => tokio_serial::DataBits::Seven,
            DataBits::Eight => tokio_serial::DataBits::Eight,
        }
    }
}

impl From<Parity> for tokio_serial::Parity {
    fn from(v: Parity) -> Self {
        match v {
            Parity::None => tokio_serial::Parity::None,
            Parity::Odd => tokio_serial::Parity::Odd,
            Parity::Even => tokio_serial::Parity::Even,
        }
    }
}

impl From<StopBits> for tokio_serial::StopBits {
    fn from(v: StopBits) -> Self {
        match v {
            StopBits::One => tokio_serial::StopBits::One,
            StopBits::Two => tokio_serial::StopBits::Two,
        }
    }
}

impl From<FlowControl> for tokio_serial::FlowControl {
    fn from(v: FlowControl) -> Self {
        match v {
            FlowControl::None => tokio_serial::FlowControl::None,
            FlowControl::Software => tokio_serial::FlowControl::Software,
            FlowControl::Hardware => tokio_serial::FlowControl::Hardware,
        }
    }
}

/// Rewrites each CR byte per `mode`; everything else passes through as-is.
pub fn translate_line_ending(data: &[u8], mode: LineEnding) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    for &b in data {
        if b == b'\r' {
            match mode {
                LineEnding::Cr => out.push(b'\r'),
                LineEnding::Lf => out.push(b'\n'),
                LineEnding::CrLf => out.extend_from_slice(b"\r\n"),
            }
        } else {
            out.push(b);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cr_mode_leaves_cr_unchanged() {
        assert_eq!(translate_line_ending(b"a\rb", LineEnding::Cr), b"a\rb");
    }

    #[test]
    fn lf_mode_rewrites_cr_to_lf() {
        assert_eq!(translate_line_ending(b"a\rb", LineEnding::Lf), b"a\nb");
    }

    #[test]
    fn crlf_mode_expands_cr_to_crlf() {
        assert_eq!(translate_line_ending(b"a\rb", LineEnding::CrLf), b"a\r\nb");
    }

    #[test]
    fn existing_lf_bytes_are_never_touched() {
        assert_eq!(translate_line_ending(b"a\nb", LineEnding::CrLf), b"a\nb");
    }
}
