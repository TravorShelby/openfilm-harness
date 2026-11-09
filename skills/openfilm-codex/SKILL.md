---
name: openfilm-codex
description: Use the OpenFilm Harness editor plugin to edit video from the current Codex or MCP agent conversation, read selection and playhead context, apply reversible timeline edits, check frames and render. Applies when the user chooses OpenFilm; preserve explicitly selected video tools.
---

# OpenFilm in the current Harness conversation

Keep the current Harness as the conversation of record. OpenFilm Studio supplies the canvas, timeline, inspector, preview and export. It does not start another chat or model runtime.

## Start a project

1. Identify the actual film project folder: it must contain `film.html`. Do not assume an example directory is the user's active project.
2. Use `openfilm_open_editor` with the actual folder and host name. Supply the actual current conversation ID only when the host exposes it; never invent one or read unrelated conversation databases to discover it. Without a supplied ID or supported environment variable the binding is explicitly MCP-connection-scoped, not persistent chat association.
3. Open the returned `editorUrl` in this host's browser pane when available, otherwise provide an external browser handoff. Preserve its fragment and query privately, without logging them in project files, Git, reports or wiki. Keep the returned `binding.id` in this conversation and pass it explicitly on subsequent operations.
4. For a new film, create a separate project using OpenFilm's Projects → New project flow. Keep it separate from imported examples.

## Work with OpenFilm

- The official OpenFilm Skill and the package's built-in film skills are available under this installation. When a film type fits a built-in skill, read that skill in full and follow it.
- Before an edit, call `openfilm_get_context` for the explicit binding. It returns the real timeline and filmRevision plus editor selection, playhead, queued references and freshness. If the editor is offline or selectionStale, do not assume "this" still means an old selection; reopen or resolve the intended clip from current context.
- "Reference in chat" and the editor's 引用所选 button queue references for this binding. They do not send a chat message. When the user refers to a selected item or asks to continue, read context, use the actual IDs and times, and clear only the reference IDs you handled.
- Apply timeline edits with `openfilm_patch_project`, the exact observed baseRevision and a UUID requestId. Operations are the OpenFilm editor operations; the MCP tool describes common forms. Do not guess a clip ID or reuse another project's binding. Preserve locked tracks and existing overrides. Do not bypass a conflict or lock with a direct whole-film file write.
- After a version conflict, reread, assess the new human/agent changes and merge the intended edit. A timeout does not establish failure: inspect `openfilm_get_operation` and context; retry an identical request with the same requestId only when its outcome is established. `prepared` is uncertain and must not be blindly retried.
- `openfilm_undo_operation` restores only that operation's previous timeline and only at its exact resulting revision; later edits cause a conflict. It is not a general rollback of scene source or media files.
- `openfilm_editor_command` selects a clip, seeks or shows a range. Queued means pending; inspect the next context for its receipt and actual selection/time. A receipt acknowledges the listener, not visual or render quality.
- For new HTML scenes and assets, use the existing project and OpenFilm's manual. `node <plugin-root>/manual.mjs` prints the pinned runtime's authoring manual, or `--skill <name>` reads one of its built-in film skills. The bridge's revision covers film.html, not arbitrary scene source files.
- Use `openfilm_check_project` after visual changes and inspect its generated frames; use `openfilm_render_project` for exports. Successful checks, queued jobs and unread images do not prove visual quality or audiovisual timing.
- OpenFilm's `get` command can call configured media providers and may spend account credits. Explain the provider and expected operation before initiating paid generation when the user's request does not already clearly authorize it.
- If a tool fails, report the actual failure and completed scope. Do not replace the OpenFilm workflow with a hand-written output and claim it succeeded.

## Session and files

- Do not promise automatic chat-message injection, universally embedded UI or persisted host conversation identity when those capabilities are absent. Bindings with actual supplied session IDs persist locally; page credentials expire on worker restart and must be refreshed by opening again.
- `.film/chat/` remains the project's OpenFilm chat-history store; this editor-only workflow does not create or modify those conversations.
- Stop with `openfilm_stop_editor` only when the user is done with the shared Harness editor; it can serve multiple clients. Running exports keep it alive. It uses a separate data home from the installed OpenFilm desktop app. Avoid opening the same project in another independent editor process.
