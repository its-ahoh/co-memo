use crate::*;
use notify::{RecursiveMode, Watcher};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
fn read(path: &Path) -> Result<String> {
    ensure!(
        !fs::symlink_metadata(path)?.file_type().is_symlink(),
        "Symlinks are not supported"
    );
    ensure!(
        fs::symlink_metadata(path)?.is_file(),
        "Expected regular file"
    );
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    ensure!(file.metadata()?.is_file(), "Expected regular file");
    let mut buf = vec![];
    file.take(65537).read_to_end(&mut buf)?;
    ensure!(buf.len() <= 65536, "File exceeds 64 KiB");
    Ok(String::from_utf8(buf)?.replace("\r\n", "\n"))
}
fn blocks(s: &str) -> Vec<String> {
    let mut out = vec![];
    let mut paragraph = String::new();
    for line in s.lines().chain(std::iter::once("")) {
        if line.trim().is_empty() {
            let mut chunk = String::new();
            let mut count = 0;
            for c in paragraph.trim().chars() {
                if count + c.len_utf16() > 2400 {
                    out.push(std::mem::take(&mut chunk));
                    count = 0;
                }
                count += c.len_utf16();
                chunk.push(c);
            }
            if !chunk.is_empty() {
                out.push(chunk)
            }
            paragraph.clear();
        } else {
            if !paragraph.is_empty() {
                paragraph.push('\n')
            }
            paragraph.push_str(line)
        }
    }
    let mut seen = HashSet::new();
    out.into_iter().filter(|s| seen.insert(s.clone())).collect()
}
impl Store {
    pub fn sources(&self) -> Result<Vec<V>> {
        self.rows("SELECT payload FROM memory_sources ORDER BY rowid")
    }
    pub fn source_add(&self, path: &Path, a: &Actor) -> Result<V> {
        self.actor(a)?;
        ensure!(
            path.is_absolute()
                && path
                    .extension()
                    .is_some_and(|s| s.eq_ignore_ascii_case("md")),
            "Absolute Markdown path required"
        );
        read(path)?;
        self.transaction(|| {
            let sources = self.sources()?;
            ensure!(sources.len() < 32, "Maximum 32 files");
            let path = path.to_str().context("Non-UTF8 path")?;
            ensure!(!sources.iter().any(|s| s["path"] == path), "File already registered");
            let source = json!({"id":uuid::Uuid::new_v4().to_string(),"path":path,"actor":a.value(),"enabled":true,"content":"","previous":"","digest":""});
            self.save_source(&source)?;
            Ok(source)
        })
    }

    fn save_source(&self, s: &V) -> Result<()> {
        self.db.execute(
            "INSERT OR REPLACE INTO memory_sources VALUES (?,?)",
            params![text(s, "id"), s.to_string()],
        )?;
        Ok(())
    }
    pub fn source_action(&self, id: &str, enabled: Option<bool>, review: Option<i64>) -> Result<V> {
        self.transaction(|| {
            let mut s = self
                .sources()?
                .into_iter()
                .find(|s| s["id"] == id)
                .context("Source not found")?;
            if let Some(e) = enabled {
                s["enabled"] = json!(e)
            }
            if let Some(v) = review {
                ensure!(
                    v > 0 && v <= s["version"].as_i64().unwrap_or(0),
                    "Invalid source version"
                );
                s["reviewedVersion"] = json!(v.max(s["reviewedVersion"].as_i64().unwrap_or(0)));
            }
            self.save_source(&s)?;
            Ok(s)
        })
    }
    pub fn scan(&self, pending: &mut HashMap<String, String>) -> Result<Vec<V>> {
        self.transaction(|| {
            let lease: Option<i64> = self
                .db
                .query_row(
                    "SELECT expires FROM memory_scan_lease WHERE id=1",
                    [],
                    |r| r.get(0),
                )
                .optional()?;
            if lease.is_some_and(|t| t > now()) {
                return Ok(vec![]);
            }
            let mut events = vec![];
            for source in self.sources()?.into_iter().filter(|s| s["enabled"] == true) {
                let id = text(&source, "id").to_owned();
                self.db.execute_batch("SAVEPOINT file_import")?;
                match self.import_source(&mut source.clone(), pending) {
                    Ok(event) => {
                        self.db.execute_batch("RELEASE file_import")?;
                        if let Some(event) = event {
                            events.push(event);
                        }
                    }
                    Err(error) => {
                        self.db
                            .execute_batch("ROLLBACK TO file_import; RELEASE file_import")?;
                        pending.remove(&id);
                        let message = error.to_string();
                        // Preserve the last committed snapshot when an import rolls back.
                        let mut source = source;
                        if source["error"] != message {
                            source["error"] = json!(message);
                            self.save_source(&source)?;
                        }
                        events.push(json!({"sourceId":id,"error":message}));
                    }
                }
            }
            Ok(events)
        })
    }

    fn import_source(
        &self,
        source: &mut V,
        pending: &mut HashMap<String, String>,
    ) -> Result<Option<V>> {
        let id = required(source, "id")?.to_owned();
        let actor = Actor::from(&source["actor"])?;
        self.actor(&actor)?;
        let path = Path::new(required(source, "path")?);
        let (content, missing) = match read(path) {
            Ok(content) => (content, false),
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
            {
                (String::new(), true)
            }
            Err(error) => return Err(error),
        };
        let digest = if missing {
            "missing".to_owned()
        } else {
            hash(&content)
        };
        if digest == text(source, "digest") {
            pending.remove(&id);
            if !missing && source.get("error").is_some() {
                source.as_object_mut().unwrap().remove("error");
                self.save_source(source)?;
            }
            return Ok(None);
        }
        if pending.get(&id) != Some(&digest) {
            pending.insert(id, digest);
            return Ok(None);
        }
        let old = blocks(text(source, "content"));
        let current = blocks(&content);
        let added: Vec<_> = current
            .iter()
            .filter(|b| !old.contains(b))
            .cloned()
            .collect();
        let removed: Vec<_> = old
            .iter()
            .filter(|b| !current.contains(b))
            .cloned()
            .collect();
        for block in &added {
            self.put(
                &actor,
                block,
                json!({
                    "source":"execution","eventId":format!("file:{id}:{digest}:{}",hash(block)),
                    "excerpt":block,"filePath":source["path"],"fileHash":digest
                }),
            )?;
        }
        let kind = if missing {
            "deleted"
        } else if source["missing"] == true {
            "restored"
        } else if text(source, "digest").is_empty() {
            "imported"
        } else if content.trim().is_empty() {
            "cleared"
        } else {
            "modified"
        };
        source["change"] = json!({"kind":kind,"added":added,"removed":removed});
        source["previous"] = source["content"].clone();
        source["content"] = json!(content);
        source["digest"] = json!(digest);
        source["missing"] = json!(missing);
        source["version"] = json!(source["version"].as_i64().unwrap_or(0) + 1);
        source["changedAt"] = json!(now());
        source["checkedAt"] = json!(now());
        if missing {
            source["error"] = json!("File missing; existing memories retained");
        } else {
            source.as_object_mut().unwrap().remove("error");
        }
        self.save_source(source)?;
        pending.remove(&id);
        Ok(Some(
            json!({"sourceId":id,"version":source["version"],"change":kind,"added":added.len(),"removed":removed.len()}),
        ))
    }
}
fn event_path(path: &Path) -> PathBuf {
    // FSEvents may expand /var or /tmp to /private/...; resolve the parent even after deletion.
    path.parent()
        .and_then(|p| p.canonicalize().ok())
        .map(|p| {
            path.file_name()
                .map_or_else(|| p.clone(), |name| p.join(name))
        })
        .unwrap_or_else(|| path.to_path_buf())
}
fn affects_sources(event: &notify::Event, paths: &[PathBuf]) -> bool {
    if event.need_rescan() {
        return true;
    }
    // Reading a source must not trigger another import on backends that report access.
    if matches!(event.kind, notify::EventKind::Access(_)) {
        return false;
    }
    event.paths.is_empty()
        || event.paths.iter().any(|p| {
            let changed = event_path(p);
            paths.iter().any(|source| source.starts_with(&changed))
        })
}
pub fn run(store: &Store, once: bool) -> Result<()> {
    let mut pending = HashMap::new();
    if once {
        for e in store.scan(&mut pending)? {
            println!("{e}")
        }
        std::thread::sleep(Duration::from_millis(250));
        for e in store.scan(&mut pending)? {
            println!("{e}")
        }
        return Ok(());
    }
    let running = Arc::new(AtomicBool::new(true));
    let flag = running.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    let signal = tx.clone();
    ctrlc::set_handler(move || {
        flag.store(false, Ordering::SeqCst);
        let _ = signal.send(None);
    })?;
    let mut watcher = match notify::recommended_watcher(move |event| {
        let _ = tx.send(Some(event));
    }) {
        Ok(watcher) => Some(watcher),
        Err(e) => {
            eprintln!(
                "{}",
                json!({"error":e.to_string(),"fallback":"reconciliation"})
            );
            None
        }
    };
    let mut watched = HashSet::<PathBuf>::new();
    let mut watch_errors = HashMap::<PathBuf, String>::new();
    // Native backends can silently omit events. Bound fallback latency even when
    // the backend reports successful registration but delivers nothing.
    let reconcile_interval = Duration::from_secs(2);
    let mut reconcile = Instant::now();
    let mut due = Some(Instant::now());
    let mut pass = 0;
    println!(
        "{}",
        json!({"status":"watching","mode":if watcher.is_some() { "events" } else { "polling" },"reconcileMs":reconcile_interval.as_millis()})
    );
    while running.load(Ordering::SeqCst) {
        if Instant::now() >= reconcile {
            let dirs: HashSet<_> = store
                .sources()?
                .iter()
                .filter(|s| s["enabled"] == true)
                .filter_map(|s| Path::new(text(s, "path")).parent().map(event_path))
                .collect();
            for dir in watched.difference(&dirs) {
                if let Some(watcher) = watcher.as_mut() {
                    let _ = watcher.unwatch(dir);
                }
            }
            watched.retain(|p| dirs.contains(p));
            watch_errors.retain(|p, _| dirs.contains(p));
            for dir in dirs.difference(&watched).cloned().collect::<Vec<_>>() {
                if let Some(watcher) = watcher.as_mut() {
                    match watcher.watch(&dir, RecursiveMode::NonRecursive) {
                        Ok(()) => {
                            watch_errors.remove(&dir);
                            watched.insert(dir);
                        }
                        Err(e) => {
                            let message = e.to_string();
                            if watch_errors.get(&dir) != Some(&message) {
                                eprintln!(
                                    "{}",
                                    json!({"path":dir,"error":message,"fallback":"reconciliation"})
                                );
                                watch_errors.insert(dir, message);
                            }
                        }
                    }
                }
            }
            reconcile = Instant::now() + reconcile_interval;
            due = Some(Instant::now());
            pass = 0;
        }
        match rx.recv_timeout(
            due.unwrap_or(reconcile)
                .min(reconcile)
                .saturating_duration_since(Instant::now()),
        ) {
            Ok(Some(Ok(event))) => {
                let paths: Vec<_> = store
                    .sources()?
                    .iter()
                    .filter(|s| s["enabled"] == true)
                    .map(|s| event_path(Path::new(text(s, "path"))))
                    .collect();
                if affects_sources(&event, &paths) {
                    due = Some(Instant::now() + Duration::from_millis(200));
                    pass = 0;
                }
            }
            Ok(Some(Err(e))) => eprintln!(
                "{}",
                json!({"error":e.to_string(),"fallback":"reconciliation"})
            ),
            Ok(None) => break,
            Err(_) => {}
        }
        if due.is_some_and(|t| Instant::now() >= t) {
            for e in store.scan(&mut pending)? {
                println!("{e}")
            }
            pass += 1;
            due = if pass == 1 {
                Some(Instant::now() + Duration::from_millis(250))
            } else {
                None
            };
        }
    }
    println!("{}", json!({"status":"stopped"}));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::{
        event::{AccessKind, Flag},
        Event, EventKind,
    };

    #[test]
    fn directory_and_dropped_events_trigger_checks_but_access_does_not() {
        let dir = std::env::temp_dir().canonicalize().unwrap();
        let source = dir.join("co-memo-event-test.md");
        let paths = vec![source.clone()];
        assert!(affects_sources(
            &Event::new(EventKind::Any).add_path(source.clone()),
            &paths
        ));
        assert!(affects_sources(
            &Event::new(EventKind::Any).add_path(dir.clone()),
            &paths
        ));
        assert!(affects_sources(
            &Event::new(EventKind::Other)
                .set_flag(Flag::Rescan)
                .add_path(dir.join("unrelated")),
            &paths
        ));
        assert!(!affects_sources(
            &Event::new(EventKind::Any).add_path(dir.join("other.md")),
            &paths
        ));
        assert!(!affects_sources(
            &Event::new(EventKind::Access(AccessKind::Read)).add_path(source),
            &paths
        ));
    }
}
