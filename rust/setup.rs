//! Idempotent local setup. Client configuration is returned, never silently overwritten.
use crate::*;
use std::{env, path::PathBuf};

pub fn default_database() -> Result<PathBuf> {
    if let Some(path) = env::var_os("CO_MEMO_DB").filter(|p| !p.is_empty()) {
        let path = PathBuf::from(path);
        ensure!(path.is_absolute(), "CO_MEMO_DB must be an absolute path");
        return Ok(path);
    }
    if let Some(root) = env::var_os("XDG_DATA_HOME").filter(|p| !p.is_empty()) {
        let root = PathBuf::from(root);
        ensure!(root.is_absolute(), "XDG_DATA_HOME must be an absolute path");
        return Ok(root.join("co-memo/memory.sqlite"));
    }
    #[cfg(windows)]
    if let Some(root) = env::var_os("LOCALAPPDATA").filter(|p| !p.is_empty()) {
        return Ok(PathBuf::from(root).join("co-memo/memory.sqlite"));
    }
    let home = env::var_os("HOME")
        .filter(|p| !p.is_empty())
        .context("Cannot find home directory; supply --db")?;
    let home = PathBuf::from(home);
    ensure!(
        home.is_absolute(),
        "Home directory must be absolute; supply --db"
    );
    Ok(home.join(".local/share/co-memo/memory.sqlite"))
}

fn directory(path: &Path) -> Result<PathBuf> {
    let path = path
        .canonicalize()
        .context("Project directory does not exist")?;
    ensure!(path.is_dir(), "Expected project directory");
    Ok(path)
}

impl Store {
    pub fn setup(
        &self,
        path: &Path,
        role: &str,
        agent: Option<&str>,
        project: Option<&str>,
    ) -> Result<Actor> {
        let path = directory(path)?;
        let role = role.trim();
        ensure!(
            !role.is_empty() && role.chars().count() <= 80,
            "Role must contain 1–80 characters"
        );
        let key = path.to_str().context("Non-UTF8 project path")?;
        self.transaction(|| {
            let saved_project: Option<String> = self
                .db
                .query_row(
                    "SELECT project_id FROM setup_projects WHERE path=?",
                    [key],
                    |r| r.get(0),
                )
                .optional()?;
            let project_id = if let Some(saved) = saved_project {
                ensure!(
                    project.is_none_or(|id| id == saved),
                    "This directory already uses another project; use the existing ID"
                );
                saved
            } else if let Some(id) = project {
                id.to_owned()
            } else {
                let name: String = path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("Project")
                    .chars()
                    .take(80)
                    .collect();
                text(&self.register("projects", &name)?, "id").to_owned()
            };
            ensure!(
                self.entity("projects", &project_id)?["archived"] != true,
                "Project archived"
            );
            self.db.execute(
                "INSERT OR IGNORE INTO setup_projects VALUES (?,?)",
                params![key, project_id],
            )?;
            let saved_agent: Option<String> = self
                .db
                .query_row(
                    "SELECT agent_id FROM setup_profiles WHERE path=? AND role=?",
                    params![key, role],
                    |r| r.get(0),
                )
                .optional()?;
            let agent_id = if let Some(saved) = saved_agent {
                ensure!(
                    agent.is_none_or(|id| id == saved),
                    "This role already uses another agent; choose a different --role"
                );
                saved
            } else if let Some(id) = agent {
                id.to_owned()
            } else {
                text(&self.register("agents", role)?, "id").to_owned()
            };
            let actor = Actor {
                agent: agent_id,
                project: Some(project_id),
                ..Default::default()
            };
            self.actor(&actor)?;
            self.db.execute(
                "INSERT OR IGNORE INTO setup_profiles VALUES (?,?,?)",
                params![key, role, actor.agent],
            )?;
            Ok(actor)
        })
    }

    /// Find the nearest configured directory, stopping at its role boundary.
    pub fn profile(&self, path: &Path, role: &str) -> Result<Actor> {
        let path = directory(path)?;
        for parent in path.ancestors() {
            let key = parent.to_str().context("Non-UTF8 project path")?;
            let project: Option<String> = self
                .db
                .query_row(
                    "SELECT project_id FROM setup_projects WHERE path=?",
                    [key],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(project) = project {
                let agent: Option<String> = self
                    .db
                    .query_row(
                        "SELECT agent_id FROM setup_profiles WHERE path=? AND role=?",
                        params![key, role.trim()],
                        |r| r.get(0),
                    )
                    .optional()?;
                let actor = Actor {
                    agent: agent.context("Role is not configured in this project; run setup --role NAME or supply --agent")?,
                    project: Some(project), ..Default::default()
                };
                self.actor(&actor)?;
                ensure!(
                    self.entity("projects", actor.project.as_deref().unwrap())?["archived"] != true,
                    "Project archived"
                );
                return Ok(actor);
            }
        }
        bail!("Project is not configured; run co-memo setup here or supply --agent and --project")
    }
}

pub fn output(db: &Path, project_dir: &Path, role: &str, actor: &Actor) -> Result<V> {
    let executable = env::current_exe()?.canonicalize()?;
    let database = db.canonicalize()?;
    let args = json!([
        "mcp",
        "--db",
        database,
        "--agent",
        actor.agent,
        "--project",
        actor.project
    ]);
    Ok(json!({
        "status":"ready", "database":database, "directory":directory(project_dir)?, "role":role.trim(),
        "agentId":actor.agent, "projectId":actor.project,
        "mcpServers":{"co-memo":{"command":executable,"args":args}},
        "next":"Merge mcpServers into your client's MCP configuration, add the README memory instructions, then restart the client. No client files were changed."
    }))
}
