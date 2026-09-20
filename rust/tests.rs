use super::*;
fn fixture(f: impl FnOnce(&Store, Actor, Actor)) {
    let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
    {
        let s = Store::open(&dir.join("memory.sqlite"), true).unwrap();
        let a = s.register("agents", "Writer").unwrap();
        let b = s.register("agents", "Reviewer").unwrap();
        let p = s.register("projects", "Launch").unwrap();
        f(
            &s,
            Actor {
                agent: text(&a, "id").into(),
                project: Some(text(&p, "id").into()),
                ..Default::default()
            },
            Actor {
                agent: text(&b, "id").into(),
                project: Some(text(&p, "id").into()),
                ..Default::default()
            },
        );
    }
    let _ = std::fs::remove_dir_all(dir);
}
fn proposal(s: &Store, a: &Actor, c: &str) -> V {
    s.propose(
        a,
        c,
        json!({"source":"assistant","eventId":"test","excerpt":"evidence"}),
    )
    .unwrap()
}
#[test]
fn sharing_requires_review_and_correct_scope() {
    fixture(|s, a, b| {
        let m = proposal(s, &a, "Use concise explanations");
        let id = text(&m, "id");
        assert!(s.recall(&a, "").unwrap().is_empty());
        s.revise(id, 1, json!({"state":"active"})).unwrap();
        assert!(s.get(&b, id).is_err());
        s.revise(id, 2, json!({"audience":"shared","sharedWith":[b.agent]}))
            .unwrap();
        assert!(s.get(&b, id).is_ok());
        let no_project = Actor { project: None, ..b };
        assert!(s.get(&no_project, id).is_err());
    });
}
#[test]
fn stale_updates_and_forgetting() {
    fixture(|s, a, _| {
        let m = proposal(s, &a, "Lesson");
        let id = text(&m, "id");
        s.revise(id, 1, json!({"state":"active"})).unwrap();
        assert!(s.revise(id, 1, json!({"content":"stale"})).is_err());
        s.revise(id, 2, json!({"state":"forgotten"})).unwrap();
        assert!(s.revise(id, 3, json!({"state":"active"})).is_err());
        assert_eq!(proposal(s, &a, "Lesson")["state"], "forgotten");
        assert_eq!(s.history(id).unwrap().len(), 3);
    });
}
#[test]
fn classification_does_not_broaden_access() {
    fixture(|s, mut a, b| {
        a.stage = Some("stage-build".into());
        a.purpose = Some("purpose-knowledge".into());
        let m = proposal(s, &a, "Validation");
        s.revise(
            text(&m, "id"),
            1,
            json!({"state":"active","audience":"global"}),
        )
        .unwrap();
        let good = Actor {
            agent: b.agent,
            ..a.clone()
        };
        assert!(s.get(&good, text(&m, "id")).is_ok());
        let bad = Actor {
            stage: Some("stage-explore".into()),
            ..good
        };
        assert!(s.get(&bad, text(&m, "id")).is_err());
    });
}
#[test]
fn mcp_rejects_scope_and_promotion_injection() {
    fixture(|s, a, b| {
        for args in [
            json!({"content":"x","evidence":"q","agentId":b.agent}),
            json!({"content":"x","evidence":"q","state":"active"}),
            json!({"content":"x","evidence":"q","audience":"global"}),
        ] {
            assert!(mcp::call(s, &a, "memory_record", &args).is_err());
        }
        assert!(s.list().unwrap().is_empty());
    });
}
#[test]
fn archive_and_expiry_exclude_recall() {
    fixture(|s, a, _| {
        let m = proposal(s, &a, "Expired");
        s.revise(text(&m, "id"), 1, json!({"state":"active","reviewAfter":1}))
            .unwrap();
        assert!(s.recall(&a, "").unwrap().is_empty());
        s.db.execute(
            "UPDATE catalog SET payload=json_set(payload,'$.archived',json('true')) WHERE id=?",
            [&a.agent],
        )
        .unwrap();
        assert!(s.recall(&a, "").is_err());
    });
}
#[test]
fn file_changes_are_candidates_and_deletion_preserves_memory() {
    fixture(|s, a, _| {
        let path = std::env::temp_dir().join(format!("{}.md", uuid::Uuid::new_v4()));
        std::fs::write(&path, "One lesson").unwrap();
        let source = s.source_add(&path, &a).unwrap();
        let mut pending = std::collections::HashMap::new();
        s.scan(&mut pending).unwrap();
        assert!(s.list().unwrap().is_empty());
        s.scan(&mut pending).unwrap();
        assert_eq!(s.list().unwrap()[0]["state"], "candidate");
        let changes = s.db.total_changes();
        s.scan(&mut pending).unwrap();
        assert_eq!(s.db.total_changes(), changes);
        std::fs::remove_file(&path).unwrap();
        s.scan(&mut pending).unwrap();
        s.scan(&mut pending).unwrap();
        assert_eq!(s.sources().unwrap()[0]["change"]["kind"], "deleted");
        assert_eq!(s.list().unwrap().len(), 1);
        s.source_action(text(&source, "id"), None, Some(2)).unwrap();
        assert_eq!(s.sources().unwrap()[0]["reviewedVersion"], 2);
    });
}
#[test]
fn invalid_source_never_reads_unregistered_file() {
    fixture(|s, a, _| {
        assert!(s.source_add(Path::new("relative.md"), &a).is_err());
        let p = std::env::temp_dir().join(format!("{}.md", uuid::Uuid::new_v4()));
        std::fs::write(&p, "x".repeat(65537)).unwrap();
        assert!(s.source_add(&p, &a).is_err());
        std::fs::remove_file(p).unwrap();
    });
}
#[test]
fn conflicts_are_atomic_and_version_checked() {
    fixture(|s, a, _| {
        let old = proposal(s, &a, "First");
        s.revise(text(&old, "id"), 1, json!({"state":"active"}))
            .unwrap();
        let new = proposal(s, &a, "Second");
        s.db.execute("UPDATE memories SET payload=json_set(payload,'$.conflictsWith',?,'$.relatedVersion',2) WHERE id=?",params![text(&old,"id"),text(&new,"id")]).unwrap();
        s.revise(text(&old, "id"), 2, json!({"content":"Changed"}))
            .unwrap();
        assert!(s
            .revise(text(&new, "id"), 1, json!({"state":"active"}))
            .is_err());
        assert_eq!(s.raw(text(&new, "id")).unwrap()["state"], "candidate");
    });
}
#[test]
fn reads_and_updates_actual_typescript_database_fixture() {
    let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&dir).unwrap();
    {
        // Create the legacy schema before Rust opens it, rather than populating
        // tables that were already initialized by the implementation under test.
        let legacy = Connection::open(dir.join("legacy.sqlite")).unwrap();
        legacy
            .execute_batch(include_str!("fixtures/typescript-v1-schema.sql"))
            .unwrap();
        let fixture: V = serde_json::from_str(include_str!("fixtures/typescript-v1.json")).unwrap();
        for table in ["catalog", "memories", "revisions"] {
            for row in fixture["tables"][table].as_array().unwrap() {
                let map = row.as_object().unwrap();
                let keys = map.keys().cloned().collect::<Vec<_>>();
                let values: Vec<rusqlite::types::Value> = keys
                    .iter()
                    .map(|k| match &map[k] {
                        V::Null => rusqlite::types::Value::Null,
                        V::Number(n) => n.as_i64().unwrap().into(),
                        V::String(t) => t.clone().into(),
                        _ => panic!(),
                    })
                    .collect();
                legacy
                    .execute(
                        &format!(
                            "INSERT OR REPLACE INTO {table} ({}) VALUES ({})",
                            keys.join(","),
                            vec!["?"; keys.len()].join(",")
                        ),
                        rusqlite::params_from_iter(values),
                    )
                    .unwrap();
            }
        }
        let a = Actor::from(&fixture["actor"]).unwrap();
        let id = text(&fixture, "memoryId");
        let mut old: V = serde_json::from_str(
            fixture["tables"]["memories"][0]["payload"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        old["version"] = json!(2);
        old["legacyMetadata"] = json!({"preserve":true});
        legacy
            .execute(
                "UPDATE memories SET payload=? WHERE id=?",
                params![old.to_string(), id],
            )
            .unwrap();
        legacy
            .execute(
                "INSERT INTO revisions VALUES (?,2,'user:edit',?,?)",
                params![id, old.to_string(), now()],
            )
            .unwrap();
        let path = dir.join("MEMORY.md");
        std::fs::write(&path, "A new imported lesson").unwrap();
        let source = json!({"id":"legacy-source","path":path,"actor":a.value(),"enabled":true,"content":"An old paragraph","previous":"","digest":hash("An old paragraph"),"version":4,"reviewedVersion":4});
        legacy
            .execute(
                "INSERT INTO memory_sources VALUES (?,?)",
                params!["legacy-source", source.to_string()],
            )
            .unwrap();
        legacy
            .execute(
                "INSERT INTO learning_jobs VALUES ('legacy-job','{}',2,NULL)",
                [],
            )
            .unwrap();
        drop(legacy);

        let s = Store::open(&dir.join("legacy.sqlite"), false).unwrap();
        assert!(s.get(&a, id).is_ok());
        assert_eq!(
            proposal(&s, &a, "Preserve this synthetic legacy lesson.")["id"],
            fixture["memoryId"]
        );
        s.revise(id, 2, json!({"content":"Updated by Rust"}))
            .unwrap();
        assert_eq!(s.history(id).unwrap().len(), 3);
        assert_eq!(s.raw(id).unwrap()["legacyMetadata"]["preserve"], true);
        assert_eq!(s.sources().unwrap()[0], source);
        let mut pending = std::collections::HashMap::new();
        s.scan(&mut pending).unwrap();
        s.scan(&mut pending).unwrap();
        assert_eq!(s.sources().unwrap()[0]["version"], 5);
        assert_eq!(s.sources().unwrap()[0]["previous"], "An old paragraph");
        assert_eq!(
            s.db.query_row(
                "SELECT attempts FROM learning_jobs WHERE id='legacy-job'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            2
        );
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn rediscovery_survives_sharing_and_forgetting_without_crossing_scope() {
    fixture(|s, a, b| {
        for audience in ["shared", "global", "project"] {
            let content = format!("Remember {audience} lesson");
            let note = proposal(s, &a, &content);
            let id = text(&note, "id");
            s.revise(id, 1, json!({"state":"active"})).unwrap();
            s.revise(id, 2, json!({"audience":audience,"sharedWith":if audience == "shared" { vec![b.agent.clone()] } else { vec![] }})).unwrap();
            assert_eq!(proposal(s, &a, &content)["id"], id);
            s.revise(id, 3, json!({"state":"forgotten"})).unwrap();
            let duplicate = proposal(s, &a, &format!("  {}  ", content.to_uppercase()));
            assert_eq!(duplicate["id"], id);
            assert_eq!(duplicate["state"], "forgotten");
            assert_eq!(s.history(id).unwrap().len(), 4);
            assert_ne!(proposal(s, &b, &content)["id"], id);
            for scoped in [
                Actor {
                    project: None,
                    ..a.clone()
                },
                Actor {
                    stage: Some("stage-build".into()),
                    ..a.clone()
                },
                Actor {
                    purpose: Some("purpose-knowledge".into()),
                    ..a.clone()
                },
            ] {
                assert_ne!(proposal(s, &scoped, &content)["id"], id);
            }
        }
    });
}

#[test]
fn long_context_keeps_the_top_result_and_marks_utf8_safe_excerpts() {
    fixture(|s, a, _| {
        for content in [
            "测试中文记忆。".repeat(60),
            "test 🧠\n\"\\\t".repeat(100),
            "x".repeat(2400),
        ] {
            let note = proposal(s, &a, &content);
            s.revise(text(&note, "id"), 1, json!({"state":"active"}))
                .unwrap();
            let context = s.context(&a, &content).unwrap();
            let rendered = text(&context, "text");
            assert!(!rendered.is_empty());
            assert!(rendered.len() <= 1200);
            assert!(rendered.contains("[truncated;"));
            assert_eq!(context["entries"][0]["id"], note["id"]);
            assert_eq!(context["entries"][0]["content"], content.trim());
            assert_eq!(context["truncatedIds"][0], note["id"]);
            let escaped = rendered
                .lines()
                .last()
                .unwrap()
                .split_once("] ")
                .unwrap()
                .1
                .split_once(" [truncated;")
                .unwrap()
                .0;
            let excerpt: String = serde_json::from_str(escaped).unwrap();
            assert!(content.starts_with(&excerpt));
            assert!(!excerpt.is_empty());
        }
        let short = proposal(s, &a, "uniqueshort");
        s.revise(text(&short, "id"), 1, json!({"state":"active"}))
            .unwrap();
        assert_eq!(
            s.context(&a, "uniqueshort").unwrap()["truncatedIds"],
            json!([])
        );
        assert_eq!(s.context(&a, "unmatched").unwrap()["text"], "");
    });
}

#[test]
fn expired_notes_can_be_inspected_and_renewed_without_agent_access() {
    fixture(|s, a, b| {
        let note = proposal(s, &a, "Expired review example");
        let id = text(&note, "id");
        assert_eq!(s.inbox().unwrap()[0]["reviewReason"], "candidate");
        s.revise(id, 1, json!({"state":"active","reviewAfter":1}))
            .unwrap();
        assert_eq!(s.inbox().unwrap()[0]["reviewReason"], "expired");
        assert_eq!(s.raw(id).unwrap()["version"], 2);
        assert!(s.raw(id).unwrap().get("reviewReason").is_none());
        assert!(s.get(&a, id).is_err());
        assert!(s.get(&b, id).is_err());
        assert!(s.recall(&a, "Expired").unwrap().is_empty());
        assert!(mcp::call(s, &a, "inspect", &json!({"id":id})).is_err());
        s.revise(id, 2, json!({"state":"active"})).unwrap();
        assert!(s.inbox().unwrap().is_empty());
        assert!(s.get(&a, id).is_ok());
        assert!(s.get(&b, id).is_err());
        s.revise(id, 3, json!({"state":"forgotten"})).unwrap();
        assert!(s.inbox().unwrap().is_empty());
    });
}

#[test]
fn get_uses_the_id_without_parsing_other_visible_notes() {
    fixture(|s, a, _| {
        let good = proposal(s, &a, "Readable");
        let bad = proposal(s, &a, "Unrelated malformed payload");
        for note in [&good, &bad] {
            s.revise(text(note, "id"), 1, json!({"state":"active"}))
                .unwrap();
        }
        s.db.execute(
            "UPDATE memories SET payload='invalid JSON' WHERE id=?",
            [text(&bad, "id")],
        )
        .unwrap();
        assert_eq!(s.get(&a, text(&good, "id")).unwrap()["content"], "Readable");
    });
}

#[test]
fn failed_file_import_keeps_the_committed_snapshot_and_retries() {
    fixture(|s, a, _| {
        let path = std::env::temp_dir().join(format!("{}.md", uuid::Uuid::new_v4()));
        std::fs::write(&path, "Initial paragraph").unwrap();
        s.source_add(&path, &a).unwrap();
        let mut pending = std::collections::HashMap::new();
        s.scan(&mut pending).unwrap();
        s.scan(&mut pending).unwrap();
        s.db.execute_batch(
            "CREATE TRIGGER reject_snapshot BEFORE INSERT ON memory_sources
            WHEN json_extract(NEW.payload, '$.version') > 1
            BEGIN SELECT RAISE(ABORT, 'synthetic snapshot failure'); END;",
        )
        .unwrap();
        std::fs::write(&path, "New paragraph\n\nAnother paragraph").unwrap();
        s.scan(&mut pending).unwrap();
        let events = s.scan(&mut pending).unwrap();
        assert!(events[0]["error"]
            .as_str()
            .unwrap()
            .contains("synthetic snapshot failure"));
        let source = &s.sources().unwrap()[0];
        assert_eq!(source["version"], 1);
        assert_eq!(source["content"], "Initial paragraph");
        assert_eq!(s.list().unwrap().len(), 1);
        s.db.execute_batch("DROP TRIGGER reject_snapshot").unwrap();
        s.scan(&mut pending).unwrap();
        assert_eq!(s.scan(&mut pending).unwrap()[0]["change"], "modified");
        assert_eq!(s.sources().unwrap()[0]["version"], 2);
        assert_eq!(s.list().unwrap().len(), 3);
        std::fs::remove_file(path).unwrap();
    });
}
