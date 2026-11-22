//! When to lock the vault on its own: after idle time, after the machine slept, and when the screen locks.

use std::time::{Duration, Instant, SystemTime};

/// Whether the vault should lock because nobody has touched keyboard or mouse for `minutes` (0 = never).
pub fn should_idle_lock(idle_seconds: u64, minutes: u32, unlocked: bool) -> bool {
    unlocked && minutes > 0 && idle_seconds >= minutes as u64 * 60
}

/// Seconds since the last keyboard or mouse input anywhere on the machine, if the system tells us.
pub fn system_idle_seconds() -> Option<u64> {
    user_idle::UserIdle::get_time().ok().map(|t| t.as_seconds())
}

/// Notices a sleep: the wall clock keeps running while the machine sleeps, the monotonic clock does not.
pub struct SleepDetector {
    wall: SystemTime,
    mono: Instant,
}

impl Default for SleepDetector {
    fn default() -> Self {
        SleepDetector { wall: SystemTime::now(), mono: Instant::now() }
    }
}

impl SleepDetector {
    /// True if the machine slept since the last call.
    pub fn slept(&mut self) -> bool {
        let (wall, mono) = (SystemTime::now(), Instant::now());
        let wall_gap = wall.duration_since(self.wall).unwrap_or_default();
        let mono_gap = mono.duration_since(self.mono);
        self.wall = wall;
        self.mono = mono;
        wall_gap.saturating_sub(mono_gap) > Duration::from_secs(20)
    }
}

/// Whether the login screen is shown (macOS only; elsewhere always false).
#[cfg(target_os = "macos")]
pub fn screen_locked() -> bool {
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::string::CFString;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGSessionCopyCurrentDictionary() -> CFDictionaryRef;
    }
    // SAFETY: the function returns a new dictionary (or null), which we own and release through the wrapper.
    let raw = unsafe { CGSessionCopyCurrentDictionary() };
    if raw.is_null() {
        return false;
    }
    let dict: CFDictionary<CFString, CFType> = unsafe { CFDictionary::wrap_under_create_rule(raw) };
    dict.find(CFString::from_static_string("CGSSessionScreenIsLocked"))
        .and_then(|v| v.downcast::<CFBoolean>())
        .is_some_and(bool::from)
}

#[cfg(not(target_os = "macos"))]
pub fn screen_locked() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_lock_rules() {
        assert!(should_idle_lock(900, 15, true));
        assert!(!should_idle_lock(899, 15, true));
        assert!(!should_idle_lock(900, 15, false));
        assert!(!should_idle_lock(99999, 0, true));
    }

    #[test]
    fn no_sleep_without_a_clock_gap() {
        let mut d = SleepDetector::default();
        assert!(!d.slept());
    }

    #[test]
    fn idle_time_and_screen_state_can_be_read() {
        // Only checks that the calls work on this system; the values depend on the machine.
        let _ = system_idle_seconds();
        let _ = screen_locked();
    }
}
