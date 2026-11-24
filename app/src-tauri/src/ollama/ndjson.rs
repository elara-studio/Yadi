//! Newline-delimited JSON decoding for streaming HTTP bodies. Network chunks do not respect
//! line boundaries: one JSON line can arrive split over several chunks (even in the middle of a
//! multi-byte character), and one chunk can hold several lines.

use serde_json::Value;

#[derive(Debug, Default)]
pub struct NdjsonDecoder {
    buf: Vec<u8>,
}

impl NdjsonDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feeds a chunk; returns every complete line it finished, in order. A line that is not
    /// valid JSON yields an `Err` with the reason (it never panics and never stops the stream).
    pub fn push(&mut self, chunk: &[u8]) -> Vec<Result<Value, String>> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(pos) = self.buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=pos).collect();
            if let Some(parsed) = parse_line(&line[..line.len() - 1]) {
                out.push(parsed);
            }
        }
        out
    }

    /// The stream ended: a final line without a trailing newline still counts.
    pub fn finish(&mut self) -> Option<Result<Value, String>> {
        let rest = std::mem::take(&mut self.buf);
        parse_line(&rest)
    }
}

fn parse_line(line: &[u8]) -> Option<Result<Value, String>> {
    let text = std::str::from_utf8(line).map(str::trim);
    match text {
        Ok("") => None, // blank lines are allowed between records
        Ok(t) => Some(serde_json::from_str(t).map_err(|e| format!("bad JSON line: {e}"))),
        Err(e) => Some(Err(format!("line is not valid UTF-8: {e}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ok(v: &[Result<Value, String>]) -> Vec<Value> {
        v.iter().map(|r| r.clone().unwrap()).collect()
    }

    #[test]
    fn whole_lines_in_one_chunk() {
        let mut d = NdjsonDecoder::new();
        let out = d.push(b"{\"a\":1}\n{\"b\":2}\n");
        assert_eq!(ok(&out), vec![json!({"a":1}), json!({"b":2})]);
    }

    #[test]
    fn a_line_split_across_chunks_is_reassembled() {
        let mut d = NdjsonDecoder::new();
        assert!(d.push(b"{\"status\":\"pull").is_empty());
        assert!(d.push(b"ing manifest\"").is_empty());
        let out = d.push(b"}\n{\"status\":\"success\"}\n");
        assert_eq!(
            ok(&out),
            vec![
                json!({"status":"pulling manifest"}),
                json!({"status":"success"})
            ]
        );
    }

    #[test]
    fn a_split_in_the_middle_of_a_multibyte_character_is_safe() {
        let line = "{\"status\":\"héllo ✓\"}\n".as_bytes();
        for split in 1..line.len() {
            let mut d = NdjsonDecoder::new();
            let mut got = d.push(&line[..split]);
            got.extend(d.push(&line[split..]));
            assert_eq!(
                ok(&got),
                vec![json!({"status":"héllo ✓"})],
                "split at byte {split}"
            );
        }
    }

    #[test]
    fn every_possible_two_way_split_of_a_stream_gives_the_same_records() {
        let stream = b"{\"n\":1}\n{\"n\":2}\n\n{\"n\":3}\n";
        for split in 0..=stream.len() {
            let mut d = NdjsonDecoder::new();
            let mut got = d.push(&stream[..split]);
            got.extend(d.push(&stream[split..]));
            assert_eq!(
                ok(&got),
                vec![json!({"n":1}), json!({"n":2}), json!({"n":3})],
                "split {split}"
            );
        }
    }

    #[test]
    fn crlf_and_blank_lines_are_tolerated() {
        let mut d = NdjsonDecoder::new();
        let out = d.push(b"{\"a\":1}\r\n\r\n   \n{\"b\":2}\r\n");
        assert_eq!(ok(&out), vec![json!({"a":1}), json!({"b":2})]);
    }

    #[test]
    fn a_bad_line_is_an_error_but_the_stream_continues() {
        let mut d = NdjsonDecoder::new();
        let out = d.push(b"{\"a\":1}\nnot json\n{\"b\":2}\n");
        assert_eq!(out.len(), 3);
        assert!(out[1].as_ref().unwrap_err().contains("bad JSON"));
        assert_eq!(out[2].clone().unwrap(), json!({"b":2}));
    }

    #[test]
    fn invalid_utf8_is_an_error_not_a_panic() {
        let mut d = NdjsonDecoder::new();
        let out = d.push(&[0xff, 0xfe, b'\n']);
        assert!(out[0].as_ref().unwrap_err().contains("UTF-8"));
    }

    #[test]
    fn finish_flushes_a_last_line_with_no_newline() {
        let mut d = NdjsonDecoder::new();
        assert!(d.push(b"{\"status\":\"success\"}").is_empty());
        assert_eq!(d.finish().unwrap().unwrap(), json!({"status":"success"}));
        assert!(d.finish().is_none(), "nothing left afterwards");
    }
}
