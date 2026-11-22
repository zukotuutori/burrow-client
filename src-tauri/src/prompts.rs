//! Prompts sent to the window that are waiting for an answer.

use std::collections::HashMap;
use std::sync::Mutex;

use tokio::sync::oneshot;

use crate::types::PromptAnswer;

#[derive(Default)]
pub struct PendingPrompts {
    pending: Mutex<HashMap<String, oneshot::Sender<PromptAnswer>>>,
}

impl PendingPrompts {
    /// Registers a prompt, hands its id to `send`, and resolves once it is answered or cancelled.
    pub async fn ask(&self, send: impl FnOnce(&str)) -> PromptAnswer {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);
        send(&id);
        rx.await.unwrap_or_else(|_| PromptAnswer::cancel())
    }

    pub fn answer(&self, id: &str, answer: PromptAnswer) {
        if let Some(tx) = self.pending.lock().unwrap().remove(id) {
            let _ = tx.send(answer);
        }
    }

    /// Answers every pending prompt with "cancel", e.g. when the vault locks or the window closes.
    pub fn cancel_all(&self) {
        let all: Vec<_> = self.pending.lock().unwrap().drain().collect();
        for (_, tx) in all {
            let _ = tx.send(PromptAnswer::cancel());
        }
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.pending.lock().unwrap().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[tokio::test]
    async fn answers_and_cancels() {
        let p = Arc::new(PendingPrompts::default());
        let (id_tx, id_rx) = std::sync::mpsc::channel();
        let p2 = p.clone();
        let task = tokio::spawn(async move { p2.ask(|id| id_tx.send(id.to_string()).unwrap()).await });
        let id = tokio::task::spawn_blocking(move || id_rx.recv().unwrap()).await.unwrap();
        p.answer("unknown", PromptAnswer { ok: true, value: None, save: false });
        p.answer(&id, PromptAnswer { ok: true, value: Some("pw".into()), save: true });
        assert_eq!(task.await.unwrap(), PromptAnswer { ok: true, value: Some("pw".into()), save: true });

        let p3 = p.clone();
        let task = tokio::spawn(async move { p3.ask(|_| {}).await });
        while p.len() == 0 {
            tokio::task::yield_now().await;
        }
        p.cancel_all();
        assert!(!task.await.unwrap().ok);
        assert_eq!(p.len(), 0);
    }
}
