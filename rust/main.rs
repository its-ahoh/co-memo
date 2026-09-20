use anyhow::{ensure, Context, Result};
use clap::{Args as ClapArgs, Parser, Subcommand};
use co_memo::{files, mcp, *};
use serde_json::{json, Value as V};
use std::{io::Read, path::PathBuf};

#[derive(Parser)]
#[command(version, about = "Local-first memory CLI and MCP server")]
struct Args {
    /// SQLite database path (required for every command).
    #[arg(long, global = true)]
    db: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(ClapArgs)]
struct Scope {
    #[arg(long)]
    agent: String,
    #[arg(long)]
    project: Option<String>,
    #[arg(long)]
    stage: Option<String>,
    #[arg(long)]
    purpose: Option<String>,
}
impl From<Scope> for Actor {
    fn from(scope: Scope) -> Self {
        Self {
            agent: scope.agent,
            project: scope.project,
            stage: scope.stage,
            purpose: scope.purpose,
        }
    }
}

#[derive(ClapArgs)]
struct Mutation {
    #[arg(long)]
    id: String,
    #[arg(long, value_parser = clap::value_parser!(i64).range(1..))]
    version: i64,
}

#[derive(Subcommand)]
enum Command {
    /// Create or initialize the database.
    Init,
    /// List registered identities and classifications.
    Catalog,
    /// Register an agent, project, stage, or purpose.
    Register {
        #[arg(long, default_value = "agents", value_parser = ["agents", "projects", "stages", "purposes"])]
        kind: String,
        #[arg(long)]
        name: String,
    },
    /// Retrieve scoped memory context, with marked excerpts for long notes.
    Recall {
        #[command(flatten)]
        scope: Scope,
        #[arg(long, default_value = "")]
        query: String,
        #[arg(long)]
        json: bool,
    },
    /// Read an active memory accessible to this agent.
    Get {
        #[command(flatten)]
        scope: Scope,
        #[arg(long)]
        id: String,
    },
    /// Inspect any memory, including expired or forgotten notes (local administrator).
    Inspect {
        #[arg(long)]
        id: String,
    },
    /// Propose a private candidate, or return an existing scoped duplicate.
    Propose {
        #[command(flatten)]
        scope: Scope,
        #[arg(long)]
        content: String,
        #[arg(long)]
        evidence: String,
    },
    /// List candidates and expired memories with their review reasons.
    Inbox,
    /// Confirm a candidate or renew an expired memory.
    Review(Mutation),
    /// Edit memory content using its current version.
    Edit {
        #[command(flatten)]
        mutation: Mutation,
        #[arg(long)]
        content: String,
    },
    /// Change who can read a memory (local administrator).
    Share {
        #[command(flatten)]
        mutation: Mutation,
        #[arg(long, value_parser = ["private", "shared", "global", "project"])]
        audience: String,
        #[arg(long, value_delimiter = ',')]
        with: Vec<String>,
    },
    /// Forget a memory while retaining its audit history.
    Forget(Mutation),
    /// Read a memory's revision history (local administrator).
    History {
        #[arg(long)]
        id: String,
    },
    /// List registered file sources and their snapshots.
    Sources,
    /// Authorize ongoing imports from an absolute Markdown path.
    SourceAdd {
        #[command(flatten)]
        scope: Scope,
        #[arg(long)]
        file: PathBuf,
    },
    /// Pause imports from a registered file.
    SourcePause {
        #[arg(long)]
        id: String,
    },
    /// Resume imports from a registered file.
    SourceResume {
        #[arg(long)]
        id: String,
    },
    /// Acknowledge a file snapshot without confirming its memories.
    SourceReview(Mutation),
    /// Attempt two stable file snapshots and exit.
    Scan,
    /// Continuously import registered files.
    Watch {
        #[arg(long)]
        once: bool,
    },
    /// Serve agent tools over stdio with a fixed identity and scope.
    Mcp {
        #[command(flatten)]
        scope: Scope,
    },
    /// Read a query from stdin and return context for the host.
    HookStart {
        #[command(flatten)]
        scope: Scope,
    },
    /// Read content/evidence from stdin and propose a private candidate.
    HookEnd {
        #[command(flatten)]
        scope: Scope,
    },
}

fn stdin() -> Result<V> {
    let mut bytes = vec![];
    std::io::stdin().take(65537).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 65536, "Input exceeds 64 KiB");
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(json!({}));
    }
    Ok(serde_json::from_slice(&bytes)?)
}
fn run() -> Result<()> {
    let args = Args::parse();
    let db = args.db.context("--db required")?;
    let store = Store::open(&db, matches!(args.command, Command::Init))?;
    let result = match args.command {
        Command::Init => json!({"database":db,"status":"ready"}),
        Command::Catalog => json!(store.catalog()?),
        Command::Register { kind, name } => store.register(&kind, &name)?,
        Command::Recall { scope, query, json } => {
            let result = store.context(&scope.into(), &query)?;
            if !json {
                print!("{}", text(&result, "text"));
                return Ok(());
            }
            result
        }
        Command::Get { scope, id } => store.get(&scope.into(), &id)?,
        Command::Inspect { id } => store.raw(&id)?,
        Command::Propose {
            scope,
            content,
            evidence,
        } => mcp::call(
            &store,
            &scope.into(),
            "memory_record",
            &json!({"content":content,"evidence":evidence}),
        )?,
        Command::Inbox => json!(store.inbox()?),
        Command::Review(m) => store.revise(&m.id, m.version, json!({"state":"active"}))?,
        Command::Forget(m) => store.revise(&m.id, m.version, json!({"state":"forgotten"}))?,
        Command::Edit {
            mutation: m,
            content,
        } => store.revise(&m.id, m.version, json!({"content":content}))?,
        Command::Share {
            mutation: m,
            audience,
            with,
        } => store.revise(
            &m.id,
            m.version,
            json!({"audience":audience,"sharedWith":with}),
        )?,
        Command::History { id } => json!(store.history(&id)?),
        Command::Sources => json!(store.sources()?),
        Command::SourceAdd { scope, file } => store.source_add(&file, &scope.into())?,
        Command::SourcePause { id } => store.source_action(&id, Some(false), None)?,
        Command::SourceResume { id } => store.source_action(&id, Some(true), None)?,
        Command::SourceReview(m) => store.source_action(&m.id, None, Some(m.version))?,
        Command::Scan => {
            files::run(&store, true)?;
            return Ok(());
        }
        Command::Watch { once } => {
            files::run(&store, once)?;
            return Ok(());
        }
        Command::Mcp { scope } => {
            mcp::run(&store, &scope.into())?;
            return Ok(());
        }
        Command::HookStart { scope } => {
            let input = stdin()?;
            only(&input, &["query"])?;
            ensure!(
                input.get("query").is_none() || input["query"].is_string(),
                "Invalid query"
            );
            let context = store.context(&scope.into(), text(&input, "query"))?;
            json!({"context":context["text"],"truncatedIds":context["truncatedIds"],"memories":context["entries"].as_array().unwrap().iter().map(|m|json!({"id":m["id"],"version":m["version"]})).collect::<Vec<_>>()})
        }
        Command::HookEnd { scope } => {
            let input = stdin()?;
            only(&input, &["content", "evidence"])?;
            let actor = scope.into();
            store.actor(&actor)?;
            if input.as_object().unwrap().is_empty() {
                json!({"status":"skipped"})
            } else {
                mcp::call(&store, &actor, "memory_record", &input)?
            }
        }
    };
    println!("{result}");
    Ok(())
}
fn main() {
    if let Err(e) = run() {
        eprintln!("{}", json!({"error":e.to_string()}));
        std::process::exit(1)
    }
}
