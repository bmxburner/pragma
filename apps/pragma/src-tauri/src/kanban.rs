//! Tauri commands backing the project-scoped prompt Kanban board. The board's
//! cards persist in `SQLite` (see `db.rs`); these commands are thin CRUD wrappers
//! plus a dedicated status move, mirroring the split-layout persistence pattern.

use pragma_constants::KanbanPromptCard;
use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};

/// Reads opaque project-board presentation and workflow metadata from `SQLite`.
#[tauri::command]
pub fn read_kanban_preferences(db: State<'_, Db>, project_id: String) -> AppResult<Option<String>> {
    db.project(&project_id)?;
    db.setting(&format!("kanban.preferences:{project_id}"))
}

/// Writes the board's JSON document without tying native code to its presentation schema.
#[tauri::command]
pub fn write_kanban_preferences(
    db: State<'_, Db>,
    project_id: String,
    value: String,
) -> AppResult<()> {
    db.project(&project_id)?;
    validate_preferences(&value)?;
    db.set_setting(&format!("kanban.preferences:{project_id}"), &value)
}

fn validate_preferences(value: &str) -> AppResult<()> {
    let parsed: serde_json::Value = serde_json::from_str(value)?;
    if !parsed.is_object() {
        return Err(AppError::InvalidInput(
            "board preferences must be a JSON object".to_owned(),
        ));
    }
    Ok(())
}

/// Lists a project's Kanban prompt cards.
#[tauri::command]
pub fn list_kanban_cards(
    db: State<'_, Db>,
    project_id: String,
) -> AppResult<Vec<KanbanPromptCard>> {
    db.list_kanban_cards(&project_id)
}

/// Creates a fresh draft card scoped to a project.
#[tauri::command]
pub fn create_kanban_card(
    db: State<'_, Db>,
    project_id: String,
    branch_name: String,
    prompt: String,
    agent_id: String,
    model_id: Option<String>,
    reasoning_id: Option<String>,
) -> AppResult<KanbanPromptCard> {
    db.create_kanban_card(
        &project_id,
        &branch_name,
        &prompt,
        &agent_id,
        model_id.as_deref(),
        reasoning_id.as_deref(),
    )
}

/// Persists every mutable field of a card (draft edits and status transitions).
#[tauri::command]
pub fn update_kanban_card(
    db: State<'_, Db>,
    card: KanbanPromptCard,
) -> AppResult<KanbanPromptCard> {
    db.update_kanban_card(&card)
}

/// Deletes a card.
#[tauri::command]
pub fn delete_kanban_card(db: State<'_, Db>, id: String) -> AppResult<()> {
    db.delete_kanban_card(&id)
}

#[cfg(test)]
mod tests {
    use super::validate_preferences;

    #[test]
    fn accepts_opaque_board_metadata_and_rejects_non_objects() {
        assert!(validate_preferences(r##"{"categories":[{"id":"bug","name":"Bug","color":"#123456"}],"overrides":{"worktree":"inProgress"}}"##).is_ok());
        for invalid in ["null", "[]", "false", "42", "\"text\"", "{broken"] {
            assert!(validate_preferences(invalid).is_err(), "accepted {invalid}");
        }
    }
}
