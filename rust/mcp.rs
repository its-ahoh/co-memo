use crate::*;
use std::io::{self, BufRead, Write};
pub fn tools() -> V {
    json!([
     {"name":"memory_search","description":"Search active memories in the host-bound scope.","inputSchema":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"],"additionalProperties":false}},
     {"name":"memory_get","description":"Read an active memory visible to this agent.","inputSchema":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"],"additionalProperties":false}},
     {"name":"memory_record","description":"Submit a private candidate, or return an existing scoped duplicate unchanged (possibly active or forgotten). Cannot approve or share.","inputSchema":{"type":"object","properties":{"content":{"type":"string"},"evidence":{"type":"string"}},"required":["content","evidence"],"additionalProperties":false}}
    ])
}
pub fn call(store: &Store, a: &Actor, name: &str, args: &V) -> Result<V> {
    store.actor(a)?;
    match name {
        "memory_search" => {
            only(args, &["query"])?;
            Ok(json!(store.recall(a,required(args,"query")?)?.iter().map(|m|json!({"id":m["id"],"kind":m["kind"],"summary":text(m,"content").chars().take(180).collect::<String>(),"version":m["version"]})).collect::<Vec<_>>()))
        }
        "memory_get" => {
            only(args, &["id"])?;
            store.get(a, required(args, "id")?)
        }
        "memory_record" => {
            only(args, &["content", "evidence"])?;
            store.propose(a,required(args,"content")?,json!({"source":"assistant","eventId":format!("agent:{}",uuid::Uuid::new_v4()),"excerpt":required(args,"evidence")?.chars().take(1800).collect::<String>()}))
        }
        _ => bail!("Unknown tool"),
    }
}
pub fn rpc(store: &Store, a: &Actor, r: &V) -> Option<V> {
    let id = r.get("id")?.clone();
    let params = &r["params"];
    let result = match text(r, "method") {
        "initialize" => {
            json!({"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"co-memo","version":"0.2.0"}})
        }
        "ping" => json!({}),
        "tools/list" => json!({"tools":tools()}),
        "tools/call" => {
            match call(
                store,
                a,
                text(params, "name"),
                params.get("arguments").unwrap_or(&json!({})),
            ) {
                Ok(v) => json!({"content":[{"type":"text","text":v.to_string()}]}),
                Err(e) => json!({"isError":true,"content":[{"type":"text","text":e.to_string()}]}),
            }
        }
        _ => {
            return Some(
                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Method not found"}}),
            )
        }
    };
    Some(json!({"jsonrpc":"2.0","id":id,"result":result}))
}
pub fn run(store: &Store, a: &Actor) -> Result<()> {
    store.actor(a)?;
    let mut input = io::stdin().lock();
    loop {
        let mut bytes = vec![];
        let mut overflow = false;
        loop {
            let buf = input.fill_buf()?;
            if buf.is_empty() {
                break;
            }
            let n = buf
                .iter()
                .position(|b| *b == b'\n')
                .map(|i| i + 1)
                .unwrap_or(buf.len());
            let done = buf[n - 1] == b'\n';
            if bytes.len() + n <= 65536 && !overflow {
                bytes.extend_from_slice(&buf[..n]);
            } else {
                overflow = true;
            }
            input.consume(n);
            if done {
                break;
            }
        }
        if bytes.is_empty() && !overflow {
            break;
        }
        let reply = if overflow {
            Some(
                json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Message exceeds 64 KiB"}}),
            )
        } else {
            match serde_json::from_slice::<V>(&bytes) {
                Ok(r) if r.is_object() => rpc(store, a, &r),
                _ => Some(
                    json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Invalid JSON-RPC"}}),
                ),
            }
        };
        if let Some(v) = reply {
            println!("{v}");
            io::stdout().flush()?;
        }
    }
    Ok(())
}
