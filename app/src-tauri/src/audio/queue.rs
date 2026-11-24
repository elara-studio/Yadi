//! Bounded chunk queue with a drop-oldest policy. Slow consumers lose the oldest audio
//! (counted and logged) instead of blocking the capture thread.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::Duration;

use super::Msg;

pub struct ChunkQueue {
    cap: usize,
    inner: Mutex<VecDeque<Msg>>,
    ready: Condvar,
    dropped: AtomicU64,
}

impl ChunkQueue {
    /// `cap` is the maximum number of queued audio chunks (about 100 ms each).
    pub fn new(cap: usize) -> Self {
        assert!(cap > 0);
        Self {
            cap,
            inner: Mutex::new(VecDeque::new()),
            ready: Condvar::new(),
            dropped: AtomicU64::new(0),
        }
    }

    fn lock(&self) -> MutexGuard<'_, VecDeque<Msg>> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Queues a message. When too many audio chunks are waiting, the OLDEST chunk is dropped.
    /// `Error` and `End` are never dropped.
    pub fn push(&self, msg: Msg) {
        let mut q = self.lock();
        if matches!(msg, Msg::Chunk(_)) {
            let chunks = q.iter().filter(|m| matches!(m, Msg::Chunk(_))).count();
            if chunks >= self.cap
                && let Some(pos) = q.iter().position(|m| matches!(m, Msg::Chunk(_)))
            {
                q.remove(pos);
                let total = self.dropped.fetch_add(1, Ordering::Relaxed) + 1;
                // Log the count only, never audio. Rate-limited to the first and every 50th.
                if total == 1 || total.is_multiple_of(50) {
                    log::warn!("audio backpressure: {total} chunk(s) dropped so far");
                }
            }
        }
        q.push_back(msg);
        self.ready.notify_one();
    }

    /// Waits up to `timeout` for the next message.
    pub fn pop_timeout(&self, timeout: Duration) -> Option<Msg> {
        let mut q = self.lock();
        if let Some(m) = q.pop_front() {
            return Some(m);
        }
        let (mut q, _) = self
            .ready
            .wait_timeout(q, timeout)
            .unwrap_or_else(|e| e.into_inner());
        q.pop_front()
    }

    pub fn try_pop(&self) -> Option<Msg> {
        self.lock().pop_front()
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.lock().len()
    }

    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::{AudioError, AudioErrorKind};

    fn chunk(n: f32) -> Msg {
        Msg::Chunk(vec![n])
    }

    #[test]
    fn full_queue_drops_the_oldest_and_counts_it() {
        let q = ChunkQueue::new(3);
        for i in 0..10 {
            q.push(chunk(i as f32));
        }
        assert_eq!(q.dropped(), 7);
        assert_eq!(q.len(), 3);
        // the three NEWEST remain, in order
        assert_eq!(q.try_pop(), Some(chunk(7.0)));
        assert_eq!(q.try_pop(), Some(chunk(8.0)));
        assert_eq!(q.try_pop(), Some(chunk(9.0)));
        assert_eq!(q.try_pop(), None);
    }

    #[test]
    fn nothing_is_dropped_below_capacity() {
        let q = ChunkQueue::new(5);
        for i in 0..5 {
            q.push(chunk(i as f32));
        }
        assert_eq!(q.dropped(), 0);
        assert_eq!(q.len(), 5);
    }

    #[test]
    fn errors_and_end_are_never_dropped() {
        let q = ChunkQueue::new(2);
        q.push(chunk(1.0));
        q.push(Msg::Error(AudioError::new(
            AudioErrorKind::DeviceLost,
            "unplugged",
        )));
        q.push(chunk(2.0));
        q.push(chunk(3.0)); // drops chunk 1.0 only
        q.push(Msg::End);
        let mut got = Vec::new();
        while let Some(m) = q.try_pop() {
            got.push(m);
        }
        assert!(got.iter().any(|m| matches!(m, Msg::Error(_))));
        assert!(got.contains(&Msg::End));
        assert!(!got.contains(&chunk(1.0)));
        assert_eq!(q.dropped(), 1);
    }

    #[test]
    fn pop_timeout_returns_none_when_empty_and_wakes_on_push() {
        let q = std::sync::Arc::new(ChunkQueue::new(2));
        assert_eq!(q.pop_timeout(Duration::from_millis(10)), None);
        let q2 = q.clone();
        let t = std::thread::spawn(move || q2.pop_timeout(Duration::from_secs(2)));
        std::thread::sleep(Duration::from_millis(30));
        q.push(chunk(4.0));
        assert_eq!(t.join().unwrap(), Some(chunk(4.0)));
    }
}
