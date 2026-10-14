<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- Map Dark Coders palette and typography from the supplied identity guide into shared CSS semantic tokens, so the voice console remains consistently branded without coupling its behavior to visual rules.
- Serve uploaded brand artwork through a Lovable asset pointer and derive a small public favicon from its mark, so the identity is reusable without committing full-size binary media.
- Model providers, plans and run options are saved per browser (src/lib/settings/store.ts); local models are called from the browser, cloud models via /api/llm with fixed provider hosts and optional HashiCorp Vault key lookup (VAULT_ADDR/VAULT_TOKEN secrets) — keeps keys off arbitrary hosts.
- Keep spatial chat as an alternate presentation of the existing voice console state and shared planner/chat/run layout, so switching views never forks structure, conversation or microphone behavior.
- Live theme values are written as CSS custom properties on the document root (src/lib/settings/theme.ts), so every glass surface re-themes instantly without per-component styling.
- The headset (WebXR) view is a lazily loaded overlay fed by the console's own messages and recording handlers, so 3D code never runs on the server and the conversation is never duplicated.
- Spatial controls use the XR library's controller rays and hand ray/touch pointers with captured hold-to-talk events; the headset room is Apple Vision Pro style (glass panels in a calm void, no avatars or scenery) per the user's simplification request.
- Headset conversation pagination is shared pure logic, keeping full replies readable without duplicating the voice conversation or its permissions.
- Parse architecture YAML as bounded data only; keep review progress separate from deployed capabilities so specifications cannot grant authority.
- Present architecture review inside the planning editor, with its own review state retained so merging the panels does not conflate requirements with task execution.
- Route configured local ASR from the browser through a separate HTTP adapter, reusing console capture and error state so native and headset views share one microphone pipeline.
- Built-in replies accept only allowlisted model names (src/lib/ai/models.ts); unknown picks error instead of being swapped, so a chosen task model is never silently replaced.
